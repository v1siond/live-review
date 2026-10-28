import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { expandHome } from '../core/files'
import { runGit } from '../core/git'
import { SessionReader, type GitView, type History, type Player } from '../core/players'
import { indexRepos, repoEntry, type RepoEntry } from '../core/repoIndex'
import { RepoRootCache, repoStateLoader, type RepoState } from '../core/repoState'
import { CLAUDE_PROJECTS, CLAUDE_SESSIONS, SessionIndex, type SessionRef } from '../core/sessions'
import { readSystems, SSH_CONFIG, type GitSystem } from '../core/systems'
import { WorkspaceScanner, type WorkspaceFile } from '../core/workspace'
import type { Store } from './store'

export type SessionView = { ref: SessionRef; players: Player[]; workspace: WorkspaceFile[] }

// The liveReview.* settings, read again on every refresh so a change applies without a reload.
export type Settings = { projectsRoot: string; scanDepth: number; workspaceRoot: string; defaultCompareBranch: string }

export type Model = {
  // The sessions and players the user has not removed, newest session first.
  sessions: SessionView[]
  // Every player of those sessions, for the views that tag files and repos by writer.
  players: Player[]
  systems: GitSystem[]
  repos: RepoEntry[]
  states: Map<string, RepoState>
  settings: Settings
}

// A player appends to its transcript several times a second; the refresh waits 2 s after the
// first append and takes every append of those 2 s in one pass.
const TRANSCRIPT_DELAY_MS = 2000
// Picked repos are re-read on this beat, so a save by the user or by a player shows within 5 s.
const REPO_POLL_MS = 4000
const SESSION_CHECK_MS = 30_000
const FETCH_EVERY_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 120_000

// One session seen since the panel started: its reader keeps the transcript offsets, and its last
// read stays in place until the next one replaces it, so a refresh never starts from empty.
type Tracked = { reader: SessionReader; view: SessionView | null; watcher: fs.FSWatcher | null }

export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  readonly model: Model = { sessions: [], players: [], systems: [], repos: [], states: new Map(), settings: readSettings() }
  private readonly roots = new RepoRootCache()
  private readonly index = new SessionIndex(CLAUDE_SESSIONS, CLAUDE_PROJECTS)
  // Sessions stay tracked for the life of the window, even once their process ends: only the
  // user's x takes one off the panel.
  private readonly tracked = new Map<string, Tracked>()
  private readonly scanner = new WorkspaceScanner()
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
      await this.discoverSessions()
      await this.rescanRepos()
    })
    this.sshWatcher = watchFile(SSH_CONFIG, () => void this.guard('read ssh config', () => this.rescanRepos()))
    this.timers.push(
      setInterval(() => void this.tick(), REPO_POLL_MS),
      setInterval(() => void this.guard('look for new sessions', () => this.discoverSessions()), SESSION_CHECK_MS),
      setInterval(() => void this.fetchPicked(), FETCH_EVERY_MS),
    )
  }

  // Every repo under the projects folder, its system and its state: run at start, on Refresh
  // and when ~/.ssh/config or a liveReview setting changes. The 4 s beat re-reads only the picked and played repos.
  async rescanRepos(): Promise<void> {
    const settings = readSettings()
    this.model.settings = settings
    this.model.systems = await readSystems(SSH_CONFIG)
    const extra = [...this.store.added(), ...this.playedRepos()]
    const removed = this.store.removed()
    const scan = { projectsRoot: settings.projectsRoot, depth: settings.scanDepth }
    this.model.repos = (await indexRepos(scan, extra, this.model.systems)).filter((entry) => !removed.has(entry.root))
    const stateOf = this.stateLoader()
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

  // A removed player or session stays removed until a later edit of its own brings it back.
  async removePlayer(key: string): Promise<void> {
    await this.dismiss([key])
  }

  async clearFinished(session: string): Promise<void> {
    const players = this.model.sessions.find((view) => view.ref.id === session)?.players ?? []
    await this.dismiss(players.filter((player) => player.verdict.state === 'done').map((player) => player.key))
  }

  async removeSession(session: string): Promise<void> {
    const players = this.tracked.get(session)?.view?.players ?? []
    await this.dismiss([session, ...players.map((player) => player.key)])
  }

  async addRepo(root: string): Promise<void> {
    await this.store.addRepo(root)
    await this.rescanRepos()
  }

  // Only this repo is read again: its summary, commits and files all change with the base.
  async compareTo(root: string, value: string | undefined): Promise<void> {
    await this.store.setCompareTo(root, value)
    const state = await this.stateLoader()(root)
    this.model.states.set(root, state)
    this.changed.fire()
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
    this.tracked.forEach((entry) => entry.watcher?.close())
    this.sshWatcher?.close()
    this.changed.dispose()
  }

  // Sessions are read one after the other, for the same memory reason as their transcripts. A
  // session whose read fails keeps its previous view.
  private async refreshLive(): Promise<void> {
    this.model.settings = readSettings()
    const git: GitView = { roots: this.roots, stateOf: this.stateLoader(), projectsRoot: this.model.settings.projectsRoot }
    const now = Date.now()
    for (const entry of this.tracked.values()) {
      await this.guard(`read session ${entry.reader.session.id}`, async () => {
        entry.view = await this.readSession(entry.reader, git, now)
      })
    }
    this.publishSessions()
    await this.addUnlistedRepos()
    const live = new Set([...this.store.picked(), ...this.playedRepos()])
    const states = await Promise.all([...live].map((root) => git.stateOf(root)))
    states.forEach((state) => this.model.states.set(state.root, state))
    this.changed.fire()
  }

  // Each Bash credit seen is kept for the session: when a later write by someone else moves the
  // file's mtime out of this player's window, the player still owns its earlier write.
  private async readSession(reader: SessionReader, git: GitView, now: number): Promise<SessionView> {
    const ref = reader.session
    const history = this.store.history(ref.id)
    const { workspaceRoot } = this.model.settings
    const read = await reader.read(workspaceRoot, history, git, now)
    await this.remember(ref.id, history, read.players)
    const workspace = await this.scanner.filesSince(workspaceRoot, read.workspaceFolders, ref.startedAt, now)
    return { ref, players: read.players, workspace }
  }

  // Each repo is compared to its stored pick, or else to the default branch setting.
  private stateLoader(): (root: string) => Promise<RepoState> {
    const fallback = this.model.settings.defaultCompareBranch
    return repoStateLoader((root) => ({ stored: this.store.compareTo(root), fallback }))
  }

  private publishSessions(): void {
    const dismissed = this.store.dismissed()
    this.model.sessions = [...this.tracked.values()]
      .map((entry) => entry.view)
      .filter((view): view is SessionView => view !== null && isShown(dismissed.get(view.ref.id), latestChange(view.players)))
      .map((view) => ({ ...view, players: view.players.filter((player) => isShown(dismissed.get(player.key), player.lastChange)) }))
      .sort((a, b) => b.ref.startedAt - a.ref.startedAt)
    this.model.players = this.model.sessions.flatMap((view) => view.players)
  }

  private async dismiss(keys: string[]): Promise<void> {
    await this.store.dismiss(keys, Date.now(), new Set(this.tracked.keys()))
    this.publishSessions()
    this.changed.fire()
  }

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
    if (grew) await this.store.saveHistory(session, history, new Set(this.tracked.keys()))
  }

  private async addUnlistedRepos(): Promise<void> {
    const listed = new Set(this.model.repos.map((entry) => entry.root))
    const removed = this.store.removed()
    const unlisted = this.playedRepos().filter((root) => !listed.has(root) && !removed.has(root))
    const entries = await Promise.all(unlisted.map((root) => repoEntry(root, 'added', this.model.systems)))
    this.model.repos.push(...entries)
  }

  // New live sessions join the panel; the ones already tracked keep their reader and their view.
  private async discoverSessions(): Promise<void> {
    this.tracked.forEach((entry) => (entry.watcher ??= this.watchPlayers(entry.reader.session)))
    const live = await this.index.listLive(this.model.settings.projectsRoot)
    const fresh = live.filter((ref) => !this.tracked.has(ref.id))
    if (fresh.length === 0) return
    fresh.forEach((ref) => this.tracked.set(ref.id, { reader: new SessionReader(ref), view: null, watcher: this.watchPlayers(ref) }))
    await this.refresh()
  }

  // A session with no player yet has no subagents folder; the 4 s beat covers it until it has one.
  private watchPlayers(ref: SessionRef): fs.FSWatcher | null {
    return watchFile(ref.subagentsDir, () => this.scheduleRefresh(TRANSCRIPT_DELAY_MS))
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

// Shown unless the user removed it and it changed nothing since.
function isShown(dismissedAt: number | undefined, lastChange: number): boolean {
  return dismissedAt === undefined || lastChange > dismissedAt
}

function latestChange(players: Player[]): number {
  return Math.max(0, ...players.map((player) => player.lastChange))
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('liveReview')
  const workspaceRoot = config.get<string>('workspaceRoot', '').trim()
  return {
    projectsRoot: path.resolve(expandHome(config.get<string>('projectsRoot', '~/projects'))),
    scanDepth: config.get<number>('scanDepth', 3),
    workspaceRoot: workspaceRoot && path.resolve(expandHome(workspaceRoot)),
    defaultCompareBranch: config.get<string>('defaultCompareBranch', '').trim(),
  }
}
