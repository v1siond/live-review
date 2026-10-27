import * as os from 'node:os'
import * as path from 'node:path'
import { PROJECTS_ROOT } from './repoIndex'
import { changedPaths, type RepoRootCache, type RepoState } from './repoState'
import type { ToolCall } from './transcript'

export type Hunk = { before: string; after: string }

export type Credit = { file: string; repo: string | null; how: 'edit' | 'bash' | 'history' }

export type NamedOnly = { file: string; repo: string }

export type Attribution = {
  files: Map<string, Credit>
  // Files the player named in a Bash call whose mtime fell outside every window of its calls:
  // it read them (sed, grep, git diff) or someone else wrote them.
  namedOnly: Map<string, NamedOnly>
  hunks: Map<string, Hunk[]>
  // When the player last changed a file (0 for never): the start of its last Write or Edit call,
  // or the save time of the last file a Bash call of its own wrote.
  lastChange: number
}

export type AttributionContext = {
  roots: RepoRootCache
  stateOf: (root: string) => Promise<RepoState>
  mtimeOf: (file: string) => Promise<number>
  now: number
}

// Coarse filesystems round mtimes to the second; a write in the first or last second of a
// call must still land inside its window.
const WINDOW_SLACK_MS = 1000
const BACKGROUND_WINDOW_MS = 10 * 60 * 1000
const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n|$)/
const ANY_CD = /(?:^|[;&|(\n]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g
const ABSOLUTE_PATH = /(?:^|[\s'"=:(])(\/[^\s'";|&)<>$*]+)/g

type FileTool = (input: Record<string, unknown>) => { file: string; hunks: Hunk[] }

// Tools that name the file they change. Every other tool either changes files through Bash
// (handled by the window rule) or changes nothing.
const fileTools: Record<string, FileTool> = {
  Write: (input) => ({ file: String(input.file_path), hunks: [{ before: '', after: String(input.content ?? '') }] }),
  Edit: (input) => ({ file: String(input.file_path), hunks: [hunkOf(input)] }),
  MultiEdit: (input) => ({
    file: String(input.file_path),
    hunks: (Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []).map(hunkOf),
  }),
}

// The file a Write, Edit or MultiEdit call names; null for every other tool.
export function changedFileOf(call: ToolCall): string | null {
  const fileTool = fileTools[call.name]
  return fileTool ? fileTool(call.input).file : null
}

function hunkOf(edit: Record<string, unknown>): Hunk {
  return { before: String(edit.old_string ?? ''), after: String(edit.new_string ?? '') }
}

export async function attributeAgent(calls: ToolCall[], context: AttributionContext): Promise<Attribution> {
  const attribution: Attribution = { files: new Map(), namedOnly: new Map(), hunks: new Map(), lastChange: 0 }
  for (const call of calls) {
    const fileTool = fileTools[call.name]
    if (fileTool) await creditFileTool(fileTool(call.input), call.start, attribution, context)
    if (call.name === 'Bash') await creditBash(call, attribution, context)
  }
  attribution.files.forEach((_credit, file) => attribution.namedOnly.delete(file))
  return attribution
}

async function creditFileTool(change: { file: string; hunks: Hunk[] }, start: number, attribution: Attribution, context: AttributionContext) {
  const repo = await context.roots.rootOfFile(change.file)
  attribution.lastChange = Math.max(attribution.lastChange, start)
  attribution.files.set(change.file, { file: change.file, repo, how: 'edit' })
  attribution.hunks.set(change.file, [...(attribution.hunks.get(change.file) ?? []), ...change.hunks])
}

async function creditBash(call: ToolCall, attribution: Attribution, context: AttributionContext) {
  const command = String(call.input.command ?? '')
  const roots = await Promise.all(callDirectories(command, call.cwd).map((dir) => context.roots.rootOf(dir)))
  const repos = new Set(roots.filter((root): root is string => root !== null))
  for (const repo of repos) await creditBashInRepo(call, command, repo, attribution, context)
}

async function creditBashInRepo(call: ToolCall, command: string, repo: string, attribution: Attribution, context: AttributionContext) {
  const [from, to] = callWindow(call, context.now)
  const state = await context.stateOf(repo)
  creditOwnCommits(command, repo, state, [from, to], attribution)
  for (const relative of changedPaths(state).keys()) {
    if (!namesFile(command, relative)) continue
    const file = path.join(repo, relative)
    const mtime = await context.mtimeOf(file)
    const credited = attribution.files.has(file)
    if (mtime < from || mtime > to) {
      if (!credited) attribution.namedOnly.set(file, { file, repo })
      continue
    }
    attribution.lastChange = Math.max(attribution.lastChange, mtime)
    if (!credited) attribution.files.set(file, { file, repo, how: 'bash' })
  }
}

// A player that commits owns the files of its commit, even when a later git step (a stash pop,
// a checkout) rewrote them and moved their mtime out of every window. Its commit is the unpushed
// commit made inside the call whose subject the command carries.
function creditOwnCommits(command: string, repo: string, state: RepoState, [from, to]: [number, number], attribution: Attribution) {
  const own = state.unpushed.filter((commit) => commit.time >= from && commit.time <= to && command.includes(commit.subject))
  own.forEach((commit) => (attribution.lastChange = Math.max(attribution.lastChange, commit.time)))
  for (const file of own.flatMap((commit) => commit.files).map((relative) => path.join(repo, relative))) {
    if (!attribution.files.has(file)) attribution.files.set(file, { file, repo, how: 'bash' })
  }
}

// A leading `cd <dir>` moves the call into that folder; otherwise it runs where the line says.
// Players also write from a folder outside the repo (`P=/abs/repo/docs/x.md; python3 ...`) or
// cd later in the command, so every cd target and absolute path in the text adds its repo too.
// Each candidate still has to be named in the command and saved inside the call's window.
// The extra folders count only inside the projects folder: a PATH export names ~/.nvm, itself a
// git clone, and reading its status on every refresh would cost seconds for nothing.
export function callDirectories(command: string, cwd: string): string[] {
  const leading = command.match(LEADING_CD)
  const directory = leading ? resolveTarget(cwd, leading[1] ?? leading[2] ?? leading[3]) : cwd
  const cdTargets = [...command.matchAll(ANY_CD)].map((match) => resolveTarget(directory, match[1] ?? match[2] ?? match[3]))
  const absolutePaths = [...command.matchAll(ABSOLUTE_PATH)].map((match) => match[1])
  const extra = [...cdTargets, ...absolutePaths].filter((dir) => dir.startsWith(PROJECTS_ROOT + path.sep))
  return [...new Set([directory, ...extra])]
}

function resolveTarget(base: string, target: string): string {
  return path.resolve(base, target.replace(/^~(?=\/|$)/, os.homedir()))
}

export function callWindow(call: ToolCall, now: number): [number, number] {
  return [call.start - WINDOW_SLACK_MS, callEnd(call, now) + WINDOW_SLACK_MS]
}

// A background call with no task notification is held open for 10 minutes at most.
function callEnd(call: ToolCall, now: number): number {
  if (call.end !== null) return call.end
  if (call.background) return Math.min(now, call.start + BACKGROUND_WINDOW_MS)
  return now
}

// The repo-relative path, or the file name standing alone (so iso.ts never matches miso.ts).
export function namesFile(command: string, relative: string): boolean {
  if (command.includes(relative)) return true
  const name = escapeRegExp(path.basename(relative))
  return new RegExp(`(^|[^\\w.-])${name}(?![\\w-])`).test(command)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
