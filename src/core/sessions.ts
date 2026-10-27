import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { modifiedAt } from './files'

export type SessionRef = {
  id: string
  project: string
  subagentsDir: string
  // Newest append to the session's own transcript or to any of its players' transcripts.
  lastWrite: number
}

export type AgentRef = { id: string; transcript: string; meta: string }

export type AgentMeta = { description: string }

const AGENT_TRANSCRIPT = /^agent-(.+)\.jsonl$/

export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

// The newest session of each project folder, newest first. Only sessions that started a
// player have a subagents folder, and a session with no player has nothing to review.
export async function listCurrentSessions(projectsRoot: string): Promise<SessionRef[]> {
  const projects = await readDirNames(projectsRoot)
  const newest = await Promise.all(projects.map((project) => newestSession(path.join(projectsRoot, project))))
  return newest.filter((session): session is SessionRef => session !== null).sort((a, b) => b.lastWrite - a.lastWrite)
}

export async function findSession(projectsRoot: string, id: string): Promise<SessionRef | null> {
  const projects = await readDirNames(projectsRoot)
  const matches = await Promise.all(projects.map((project) => sessionAt(path.join(projectsRoot, project), id)))
  return matches.find((session) => session !== null) ?? null
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

async function newestSession(projectDir: string): Promise<SessionRef | null> {
  const names = await readDirNames(projectDir)
  const sessions = await Promise.all(names.map((name) => sessionAt(projectDir, name)))
  return sessions.reduce<SessionRef | null>((best, session) => {
    if (!session) return best
    if (!best || session.lastWrite > best.lastWrite) return session
    return best
  }, null)
}

async function sessionAt(projectDir: string, id: string): Promise<SessionRef | null> {
  const subagentsDir = path.join(projectDir, id, 'subagents')
  const agentFiles = (await readDirNames(subagentsDir)).filter((name) => AGENT_TRANSCRIPT.test(name))
  if (agentFiles.length === 0) return null
  const writes = await Promise.all([
    modifiedAt(path.join(projectDir, `${id}.jsonl`)),
    ...agentFiles.map((name) => modifiedAt(path.join(subagentsDir, name))),
  ])
  return { id, project: path.basename(projectDir), subagentsDir, lastWrite: Math.max(...writes) }
}

async function readDirNames(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}
