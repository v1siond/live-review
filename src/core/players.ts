import * as path from 'node:path'
import { describeCall } from './actions'
import { attributeAgent, type Credit, type Hunk } from './attribution'
import { modifiedAt } from './files'
import { findRow, jobOf, rowNumber, type RecordRow } from './orchestra'
import { changedPaths, type RepoRootCache, type RepoState } from './repoState'
import { listAgents, readMeta, type SessionRef } from './sessions'
import { TranscriptCursor } from './transcript'

export type PlayerState = 'working' | 'waiting' | 'done'

export type Verdict = { active: boolean; state: PlayerState; rule: string }

export type FileStatus = 'uncommitted' | 'unpushed' | 'clean' | 'outside git'

export type PlayerFile = Credit & { relative: string | null; status: FileStatus }

export type TimelineEntry = { time: number; words: string }

export type Player = {
  id: string
  description: string
  label: string
  row: RecordRow | null
  verdict: Verdict
  lastAction: string
  timeline: TimelineEntry[]
  files: PlayerFile[]
  namedOnly: PlayerFile[]
  hunks: Map<string, Hunk[]>
}

export type GitView = { roots: RepoRootCache; stateOf: (root: string) => Promise<RepoState> }

// Files credited earlier by the window rule, per player; a later write by someone else moves
// the mtime out of the window, so the earlier credit would otherwise be lost.
export type History = Map<string, Set<string>>

const QUIET_MS = 10 * 60 * 1000

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

  async readPlayers(records: string[], history: History, git: GitView, now: number): Promise<Player[]> {
    const agents = await listAgents(this.session)
    return Promise.all(
      agents.map(async (agent) => {
        const cursor = this.cursorFor(agent.id, agent.transcript)
        await cursor.readNew()
        const [meta, lastWrite] = await Promise.all([readMeta(agent.meta), modifiedAt(agent.transcript)])
        return buildPlayer({ id: agent.id, description: meta.description, cursor, lastWrite, records, history, git, now })
      }),
    )
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
  const { id, description, cursor, git, now } = input
  const attribution = await attributeAgent(cursor.calls, { ...git, mtimeOf: modifiedAt, now })
  await addHistory(attribution.files, input.history.get(id), git.roots)
  const number = rowNumber(description)
  const row = number === null ? null : findRow(input.records, number)
  const verdict = verdictOf(cursor.lastAssistant, input.lastWrite, now)
  const timeline = cursor.calls.map((call) => ({ time: call.start, words: describeCall(call) }))
  return {
    id,
    description,
    label: labelOf(description, row),
    row,
    verdict,
    lastAction: verdict.state === 'done' ? 'finished' : (timeline.at(-1)?.words ?? 'starting'),
    timeline,
    files: await withStatus([...attribution.files.values()], git),
    namedOnly: await withStatus([...attribution.namedOnly.values()].map((named) => ({ ...named, how: 'bash' as const })), git),
    hunks: attribution.hunks,
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
