import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type SessionRef = {
  id: string
  // Where the session runs, relative to the projects folder: "shop", "shop/api".
  project: string
  transcript: string
  subagentsDir: string
  startedAt: number
}

export type AgentRef = { id: string; transcript: string; meta: string }

export type AgentMeta = { description: string }

// One entry of Claude Code's own registry of its running processes, ~/.claude/sessions/<pid>.json.
type RegistryEntry = { sessionId?: unknown; cwd?: unknown; startedAt?: unknown; procStart?: unknown; kind?: unknown; entrypoint?: unknown }

const AGENT_TRANSCRIPT = /^agent-(.+)\.jsonl$/
const REGISTRY_FILE = /^(\d+)\.json$/
// A terminal session the user opened. Headless runs (`claude -p`, the SDK) say "sdk-cli", and
// background jobs say kind "bg"; neither is a session the user has open.
const INTERACTIVE = { kind: 'interactive', entrypoint: 'cli' }
// Field 22 of /proc/<pid>/stat, the process start in clock ticks: the registry keeps it so a pid
// the system gave to another process is not taken for the session.
const PROC_START_FIELD = 22

export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
export const CLAUDE_SESSIONS = path.join(os.homedir(), '.claude', 'sessions')

// The live sessions are the Claude processes running now: every registry entry whose process is
// alive, newest start first. The registry also keeps the entries of every process that ended, so
// an entry counts only while its pid runs with the start time the entry recorded.
export class SessionIndex {
  // A session's transcript never moves; it is looked up once per session.
  private readonly transcripts = new Map<string, string>()

  constructor(
    private readonly registry: string,
    private readonly claudeProjects: string,
  ) {}

  // projectsRoot only names each session: its cwd relative to that folder.
  async listLive(projectsRoot: string): Promise<SessionRef[]> {
    const pids = (await readDirNames(this.registry)).map((name) => name.match(REGISTRY_FILE)?.[1]).filter((pid): pid is string => pid !== undefined)
    const sessions = await Promise.all(pids.map((pid) => this.sessionOf(pid, projectsRoot)))
    return sessions.filter((session): session is SessionRef => session !== null).sort((a, b) => b.startedAt - a.startedAt)
  }

  private async sessionOf(pid: string, projectsRoot: string): Promise<SessionRef | null> {
    const procStart = await processStart(pid)
    if (procStart === null) return null
    const entry = await readEntry(path.join(this.registry, `${pid}.json`))
    if (!entry || !isLiveInteractive(entry, procStart)) return null
    const id = String(entry.sessionId)
    const cwd = String(entry.cwd ?? '')
    const transcript = await this.transcriptOf(id, cwd)
    const subagentsDir = path.join(path.dirname(transcript), id, 'subagents')
    return { id, project: projectLabel(cwd, projectsRoot), transcript, subagentsDir, startedAt: Number(entry.startedAt) }
  }

  // Claude Code names a project folder after the cwd with every character other than a letter or
  // a digit turned into "-"; a folder named otherwise (a long path is shortened) is found by search.
  private async transcriptOf(id: string, cwd: string): Promise<string> {
    const known = this.transcripts.get(id)
    if (known) return known
    const named = path.join(this.claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
    const found = (await exists(named)) ? named : await this.searchTranscript(id)
    if (found) this.transcripts.set(id, found)
    return found ?? named
  }

  private async searchTranscript(id: string): Promise<string | null> {
    const candidates = (await readDirNames(this.claudeProjects)).map((project) => path.join(this.claudeProjects, project, `${id}.jsonl`))
    const present = await Promise.all(candidates.map(exists))
    return candidates.find((_candidate, index) => present[index]) ?? null
  }
}

function isLiveInteractive(entry: RegistryEntry, procStart: string): boolean {
  if (entry.kind !== INTERACTIVE.kind || entry.entrypoint !== INTERACTIVE.entrypoint) return false
  if (typeof entry.sessionId !== 'string') return false
  return entry.procStart === undefined || String(entry.procStart) === procStart
}

// null when no process runs under that pid.
async function processStart(pid: string): Promise<string | null> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  if (stat === null) return null
  // The command name (field 2) sits in brackets and may hold spaces; fields count from after it.
  const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return afterName[PROC_START_FIELD - 3] ?? null
}

async function readEntry(file: string): Promise<RegistryEntry | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return JSON.parse(text) as RegistryEntry
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

export async function listAgents(session: SessionRef): Promise<AgentRef[]> {
  const names = await readDirNames(session.subagentsDir)
  return names
    .map((name) => name.match(AGENT_TRANSCRIPT))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      id: match[1],
      transcript: path.join(session.subagentsDir, match[0]),
      meta: path.join(session.subagentsDir, `agent-${match[1]}.meta.json`),
    }))
}

// A meta file can be missing or caught mid-write; the player is still listed, and the
// description says so instead of going blank.
export async function readMeta(file: string): Promise<AgentMeta> {
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return { description: '(no meta.json)' }
  try {
    const meta = JSON.parse(text) as { description?: unknown }
    return { description: String(meta.description ?? '') }
  } catch {
    return { description: '(meta.json unreadable)' }
  }
}

function projectLabel(cwd: string, projectsRoot: string): string {
  const relative = path.relative(projectsRoot, cwd)
  if (relative === '') return path.basename(projectsRoot)
  if (relative.startsWith('..')) return cwd
  return relative
}

async function readDirNames(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}
