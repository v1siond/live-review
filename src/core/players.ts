import * as path from 'node:path'
import { describeCall } from './actions'
import { attributeAgent, type Credit, type Hunk } from './attribution'
import { modifiedAt } from './files'
import { findRow, jobOf, readRecords, rowNumber, type RecordRow } from './orchestra'
import { changedPaths, type RepoRootCache, type RepoState } from './repoState'
import { listAgents, readMeta, type SessionRef } from './sessions'
import { TranscriptCursor } from './transcript'
import { workspaceFolders } from './workspace'

export type PlayerState = 'working' | 'waiting' | 'done'

export type Verdict = { active: boolean; state: PlayerState; rule: string }

export type FileStatus = 'uncommitted' | 'unpushed' | 'clean' | 'outside git'

export type PlayerFile = Credit & { relative: string | null; status: FileStatus }

export type TimelineEntry = { time: number; words: string }

export type Player = {
  // Unique across sessions: "<session id>/<agent id>".
  key: string
  id: string
  session: SessionRef
  main: boolean
  description: string
  label: string
  row: RecordRow | null
  verdict: Verdict
  lastAction: string
  timeline: TimelineEntry[]
  files: PlayerFile[]
  namedOnly: PlayerFile[]
  hunks: Map<string, Hunk[]>
  lastChange: number
}

type SessionRead = { players: Player[]; workspaceFolders: string[] }

// projectsRoot bounds which extra folders a Bash call can name as repos (see callDirectories).
export type GitView = { roots: RepoRootCache; stateOf: (root: string) => Promise<RepoState>; projectsRoot: string }

// Files credited earlier by the window rule, per player; a later write by someone else moves
// the mtime out of the window, so the earlier credit would otherwise be lost.
export type History = Map<string, Set<string>>

const QUIET_MS = 10 * 60 * 1000

// The session's own agent, the one the user talks to, listed beside its players.
const MAIN_AGENT = 'main'
const MAIN_DESCRIPTION = 'you'
// The optional table of tickets each workspace folder keeps; a player's "Row <n>" is looked up in it.
const RECORD_FILE = 'ORCHESTRA.md'

type Source = { id: string; transcript: string; description: () => Promise<string> }

// The transcript is the only witness: a player that ended wrote a final text with no tool
// call after it, and one appended in the last 10 minutes is still running. A player that is
// neither went quiet mid-call (a long background wait or a crash), so it is shown as waiting.
export function verdictOf(lastAssistant: TranscriptCursor['lastAssistant'], lastWrite: number, now: number): Verdict {
  if (lastAssistant === 'text') return { active: false, state: 'done', rule: 'last assistant message is a final text with no tool call after it' }
  if (now - lastWrite > QUIET_MS) return { active: false, state: 'waiting', rule: 'transcript not appended in the last 10 min' }
  return { active: true, state: 'working', rule: 'appended in the last 10 min and its last assistant message is a tool call' }
}

export class SessionReader {
  private readonly cursors = new Map<string, TranscriptCursor>()

  constructor(readonly session: SessionRef) {}

  // The transcripts are read one after the other: a first read of a main transcript of hundreds of
  // MB beside its players' at once would hold all of them in memory together.
  async read(workspaceRoot: string, history: History, git: GitView, now: number): Promise<SessionRead> {
    const sources = await this.sources()
    const cursors: TranscriptCursor[] = []
    for (const source of sources) cursors.push(await this.readSource(source))
    const folders = await workspaceFolders(cursors.flatMap((cursor) => cursor.calls), workspaceRoot)
    const records = await readRecords(folders.map((folder) => path.join(folder, RECORD_FILE)))
    const players = await Promise.all(
      sources.map(async (source, index) => {
        const cursor = cursors[index]
        const [description, lastWrite] = await Promise.all([source.description(), modifiedAt(source.transcript)])
        return buildPlayer({ session: this.session, id: source.id, description, cursor, lastWrite, records, history, git, now })
      }),
    )
    return { players, workspaceFolders: folders }
  }

  private async sources(): Promise<Source[]> {
    const agents = await listAgents(this.session)
    const main: Source = { id: MAIN_AGENT, transcript: this.session.transcript, description: async () => MAIN_DESCRIPTION }
    const players = agents.map((agent) => ({ id: agent.id, transcript: agent.transcript, description: async () => (await readMeta(agent.meta)).description }))
    return [main, ...players]
  }

  private async readSource(source: Source): Promise<TranscriptCursor> {
    const cursor = this.cursorFor(source.id, source.transcript)
    await cursor.readNew()
    return cursor
  }

  private cursorFor(id: string, file: string): TranscriptCursor {
    const known = this.cursors.get(id)
    if (known) return known
    const cursor = new TranscriptCursor(file)
    this.cursors.set(id, cursor)
    return cursor
  }
}

type PlayerInput = {
  session: SessionRef
  id: string
  description: string
  cursor: TranscriptCursor
  lastWrite: number
  records: string[]
  history: History
  git: GitView
  now: number
}

async function buildPlayer(input: PlayerInput): Promise<Player> {
  const { session, id, description, cursor, git, now } = input
  const attribution = await attributeAgent(cursor.calls, { ...git, mtimeOf: modifiedAt, now })
  await addHistory(attribution.files, input.history.get(id), git.roots)
  const number = rowNumber(description)
  const row = number === null ? null : findRow(input.records, number)
  const verdict = verdictOf(cursor.lastAssistant, input.lastWrite, now)
  const timeline = cursor.calls.map((call) => ({ time: call.start, words: describeCall(call) }))
  return {
    key: `${session.id}/${id}`,
    id,
    session,
    main: id === MAIN_AGENT,
    description,
    label: labelOf(description, row),
    row,
    verdict,
    lastAction: verdict.state === 'done' ? 'finished' : (timeline.at(-1)?.words ?? 'starting'),
    timeline,
    files: await withStatus([...attribution.files.values()], git),
    namedOnly: await withStatus([...attribution.namedOnly.values()].map((named) => ({ ...named, how: 'bash' as const })), git),
    hunks: attribution.hunks,
    lastChange: attribution.lastChange,
  }
}

async function addHistory(files: Map<string, Credit>, remembered: Set<string> | undefined, roots: RepoRootCache) {
  for (const file of remembered ?? []) {
    if (files.has(file)) continue
    files.set(file, { file, repo: await roots.rootOfFile(file), how: 'history' })
  }
}

function labelOf(description: string, row: RecordRow | null): string {
  if (!row) return description
  const job = jobOf(description)
  return job ? `Row ${row.number}: ${row.ticket}, ${job}` : `Row ${row.number}: ${row.ticket}`
}

async function withStatus(credits: Credit[], git: GitView): Promise<PlayerFile[]> {
  const files = await Promise.all(credits.map((credit) => statusOf(credit, git)))
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

async function statusOf(credit: Credit, git: GitView): Promise<PlayerFile> {
  if (!credit.repo) return { ...credit, relative: null, status: 'outside git' }
  const relative = path.relative(credit.repo, credit.file)
  const state = await git.stateOf(credit.repo)
  return { ...credit, relative, status: changedPaths(state).get(relative) ?? 'clean' }
}
