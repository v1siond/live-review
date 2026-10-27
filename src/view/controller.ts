import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { runGit } from '../core/git'
import { readRecords } from '../core/orchestra'
import { SessionReader, type History, type Player } from '../core/players'
import { indexRepos, repoEntry, type RepoEntry } from '../core/repoIndex'
import { RepoRootCache, repoStateLoader, type RepoState } from '../core/repoState'
import { CLAUDE_PROJECTS, findSession, listCurrentSessions, type SessionRef } from '../core/sessions'
import { readSystems, SSH_CONFIG, type GitSystem } from '../core/systems'
import type { Store } from './store'

export type Model = {
  session: SessionRef | null
  players: Player[]
  systems: GitSystem[]
  repos: RepoEntry[]
  states: Map<string, RepoState>
}

// A player appends to its transcript several times a second; the refresh waits 2 s after the
// first append and takes every append of those 2 s in one pass.
const TRANSCRIPT_DELAY_MS = 2000
// Picked repos are re-read on this beat, so a save by him or by a player shows within 5 s.
const REPO_POLL_MS = 4000
const SESSION_CHECK_MS = 60_000
const FETCH_EVERY_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 120_000

export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  readonly model: Model = { session: null, players: [], systems: [], repos: [], states: new Map() }
  private readonly roots = new RepoRootCache()
  private reader: SessionReader | null = null
  private watcher: fs.FSWatcher | null = null
  private sshWatcher: fs.FSWatcher | null = null
  private pendingRefresh: NodeJS.Timeout | null = null
  private refreshing = false
  private refreshAgain = false
  private readonly timers: NodeJS.Timeout[] = []
  // The 4 s beat runs only while a section of the panel is on screen.
  private visibleViews = 0

  constructor(
    private readonly store: Store,
    private readonly log: vscode.OutputChannel,
  ) {}

  async start(): Promise<void> {
    await this.guard('start', async () => {
      await this.followSession()
      await this.rescanRepos()
    })
    this.sshWatcher = watchFile(SSH_CONFIG, () => void this.guard('read ssh config', () => this.rescanRepos()))
    this.timers.push(
      setInterval(() => void this.tick(), REPO_POLL_MS),
      setInterval(() => void this.guard('check the newest session', () => this.followSession()), SESSION_CHECK_MS),
      setInterval(() => void this.fetchPicked(), FETCH_EVERY_MS),
    )
  }

  // Every repo under the projects folder, its system and its state: run at start, on Refresh
  // and when ~/.ssh/config changes. The 4 s beat re-reads only the picked and played repos.
  async rescanRepos(): Promise<void> {
    this.model.systems = await readSystems(SSH_CONFIG)
    const extra = [...this.store.added(), ...this.playedRepos()]
    const removed = this.store.removed()
    this.model.repos = (await indexRepos(extra, this.model.systems)).filter((entry) => !removed.has(entry.root))
    const stateOf = repoStateLoader()
    const states = await Promise.all(this.model.repos.map((entry) => stateOf(entry.root)))
    this.model.states = new Map(states.map((state) => [state.root, state]))
    this.changed.fire()
    await this.refresh()
  }

  private async tick(): Promise<void> {
    if (this.visibleViews === 0) return
    await this.refresh()
  }

  viewVisible(visible: boolean): void {
    this.visibleViews += visible ? 1 : -1
    if (visible) void this.refresh()
  }

  scheduleRefresh(delayMs: number): void {
    if (this.pendingRefresh) return
    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null
      void this.refresh()
    }, delayMs)
  }

  // One refresh at a time; a request that lands mid-run runs once more right after it.
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    await this.guard('refresh', () => this.refreshLive())
    this.refreshing = false
    if (!this.refreshAgain) return
    this.refreshAgain = false
    await this.refresh()
  }

  async fetchPicked(): Promise<void> {
    const picked = [...this.store.picked()]
    const results = await Promise.all(picked.map((root) => runGit(root, ['fetch'], FETCH_TIMEOUT_MS)))
    results.forEach((result, index) => {
      if (!result.ok) this.log.appendLine(`fetch ${picked[index]}: ${result.error}`)
    })
    await this.refresh()
  }

  async useSession(id: string | null): Promise<void> {
    await this.store.chooseSession(id)
    await this.followSession()
    await this.refresh()
  }

  async clearFinished(): Promise<void> {
    const session = this.model.session
    if (!session) return
    const cleared = this.store.cleared(session.id)
    this.model.players.filter((player) => player.verdict.state === 'done').forEach((player) => cleared.add(player.id))
    await this.store.saveCleared(session.id, cleared)
    await this.refresh()
  }

  async addRepo(root: string): Promise<void> {
    await this.store.addRepo(root)
    await this.rescanRepos()
  }

  async removeRepo(root: string): Promise<void> {
    await this.store.removeRepo(root)
    this.model.repos = this.model.repos.filter((entry) => entry.root !== root)
    this.changed.fire()
  }

  // Every repo a player of the session changed a file in.
  playedRepos(): string[] {
    const repos = this.model.players.flatMap((player) => player.files.map((file) => file.repo))
    return [...new Set(repos.filter((repo): repo is string => repo !== null))]
  }

  dispose(): void {
    this.timers.forEach(clearInterval)
    if (this.pendingRefresh) clearTimeout(this.pendingRefresh)
    this.watcher?.close()
    this.sshWatcher?.close()
    this.changed.dispose()
  }

  private async refreshLive(): Promise<void> {
    const session = this.model.session
    const git = { roots: this.roots, stateOf: repoStateLoader() }
    if (session && this.reader) {
      const files = vscode.workspace.getConfiguration('liveReview').get<string[]>('recordFiles', [])
      const history = this.store.history(session.id)
      const players = await this.reader.readPlayers(await readRecords(files), history, git, Date.now())
      await this.remember(session.id, history, players)
      const cleared = this.store.cleared(session.id)
      this.model.players = players.filter((player) => !(cleared.has(player.id) && player.verdict.state === 'done'))
    }
    await this.addUnlistedRepos()
    const live = new Set([...this.store.picked(), ...this.playedRepos()])
    const states = await Promise.all([...live].map((root) => git.stateOf(root)))
    states.forEach((state) => this.model.states.set(state.root, state))
    this.changed.fire()
  }

  // Each Bash credit seen is kept for the session: when a later write by someone else moves the
  // file's mtime out of this player's window, the player still owns its earlier write.
  private async remember(session: string, history: History, players: Player[]): Promise<void> {
    let grew = false
    for (const player of players) {
      const files = history.get(player.id) ?? new Set<string>()
      for (const file of player.files) {
        if (file.how !== 'bash' || files.has(file.file)) continue
        files.add(file.file)
        grew = true
      }
      history.set(player.id, files)
    }
    if (grew) await this.store.saveHistory(session, history)
  }

  private async addUnlistedRepos(): Promise<void> {
    const listed = new Set(this.model.repos.map((entry) => entry.root))
    const removed = this.store.removed()
    const unlisted = this.playedRepos().filter((root) => !listed.has(root) && !removed.has(root))
    const entries = await Promise.all(unlisted.map((root) => repoEntry(root, 'added', this.model.systems)))
    this.model.repos.push(...entries)
  }

  private async followSession(): Promise<void> {
    const chosen = this.store.chosenSession()
    const session = chosen ? await findSession(CLAUDE_PROJECTS, chosen) : (await listCurrentSessions(CLAUDE_PROJECTS))[0] ?? null
    if (session?.id === this.model.session?.id) return
    this.model.session = session
    this.model.players = []
    this.reader = session ? new SessionReader(session) : null
    this.watcher?.close()
    this.watcher = session ? watchFile(session.subagentsDir, () => this.scheduleRefresh(TRANSCRIPT_DELAY_MS)) : null
    this.changed.fire()
  }

  private async guard(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this.log.appendLine(`${new Date().toISOString()} ${what} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
  }
}

// fs.watch throws when the path is gone (a deleted session folder, no ssh config) and emits an
// error when it disappears later; the panel keeps working on its timers either way, so a
// missing path only means no watcher.
function watchFile(target: string, onChange: () => void): fs.FSWatcher | null {
  if (!fs.existsSync(target)) return null
  const watcher = fs.watch(target, onChange)
  watcher.on('error', () => watcher.close())
  return watcher
}
