import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { runGit } from './git'

export type ChangedFile = { path: string; status: string }

export type Commit = { sha: string; time: number; subject: string; files: string[] }

export type RepoState = {
  root: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  uncommitted: ChangedFile[]
  unpushed: Commit[]
  // The revision a committed but unpushed file is compared against: what the remote already has.
  baseRev: string
}

// Enough history to name the files of every unpushed commit a player could have made today,
// while a repo that was never pushed (thousands of local commits) stays cheap to read.
const UNPUSHED_LIST_LIMIT = 100
const RECORD_SEPARATOR = '\x1e'
const FIELD_SEPARATOR = '\x1f'

export async function readRepoState(root: string): Promise<RepoState> {
  const [branch, range, uncommitted] = await Promise.all([readBranch(root), readUnpushedRange(root), readUncommitted(root)])
  const [unpushed, ahead, behind] = await Promise.all([
    readUnpushed(root, range.args),
    countRevisions(root, range.args),
    range.upstream ? countRevisions(root, ['HEAD..@{u}']) : Promise.resolve(0),
  ])
  return { root, branch, upstream: range.upstream, ahead, behind, uncommitted, unpushed, baseRev: baseRevision(range.upstream, unpushed) }
}

export function hasWork(state: RepoState): boolean {
  return state.uncommitted.length > 0 || state.unpushed.length > 0
}

// Every repo-relative path a player could have changed: dirty now, or inside an unpushed commit.
// Built once per state: every Bash call and every credited file of every player asks for it.
const changedPathsByState = new WeakMap<RepoState, Map<string, 'uncommitted' | 'unpushed'>>()

export function changedPaths(state: RepoState): Map<string, 'uncommitted' | 'unpushed'> {
  const known = changedPathsByState.get(state)
  if (known) return known
  const paths = new Map<string, 'uncommitted' | 'unpushed'>()
  state.unpushed.forEach((commit) => commit.files.forEach((file) => paths.set(file, 'unpushed')))
  state.uncommitted.forEach((file) => paths.set(file.path, 'uncommitted'))
  changedPathsByState.set(state, paths)
  return paths
}

async function readBranch(root: string): Promise<string> {
  const current = await runGit(root, ['branch', '--show-current'])
  if (current.ok && current.stdout.trim()) return current.stdout.trim()
  const sha = await runGit(root, ['rev-parse', '--short', 'HEAD'])
  if (!sha.ok) return 'no commits'
  return `detached at ${sha.stdout.trim()}`
}

async function readUnpushedRange(root: string): Promise<{ args: string[]; upstream: string | null }> {
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok) return { args: ['@{u}..HEAD'], upstream: upstream.stdout.trim() }
  return { args: ['HEAD', '--not', '--remotes'], upstream: null }
}

async function readUncommitted(root: string): Promise<ChangedFile[]> {
  const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return []
  return parsePorcelain(status.stdout)
}

// Porcelain v1 with -z: "XY path\0", and a rename or copy carries its old path as the next entry.
function parsePorcelain(output: string): ChangedFile[] {
  const entries = output.split('\0').filter(Boolean)
  const files: ChangedFile[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const status = entry.slice(0, 2)
    files.push({ path: entry.slice(3), status: status.trim() })
    if (/[RC]/.test(status)) index++
  }
  return files
}

async function readUnpushed(root: string, range: string[]): Promise<Commit[]> {
  const format = `--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%s`
  const log = await runGit(root, ['log', `-n${UNPUSHED_LIST_LIMIT}`, format, '--name-only', ...range])
  if (!log.ok) return []
  return log.stdout.split(RECORD_SEPARATOR).filter(Boolean).map(parseCommit)
}

function parseCommit(record: string): Commit {
  const [header, ...files] = record.split('\n')
  const [sha, seconds, subject] = header.split(FIELD_SEPARATOR)
  return { sha, time: Number(seconds) * 1000, subject, files: files.filter(Boolean) }
}

async function countRevisions(root: string, range: string[]): Promise<number> {
  const count = await runGit(root, ['rev-list', '--count', ...range])
  if (!count.ok) return 0
  return Number(count.stdout.trim())
}

function baseRevision(upstream: string | null, unpushed: Commit[]): string {
  if (upstream) return upstream
  if (unpushed.length === 0) return 'HEAD'
  return `${unpushed[unpushed.length - 1].sha}^`
}

// Repos the same way `find <root> -maxdepth <depth> -name .git -type d` sees them: a .git
// directory (never a worktree or submodule .git file), symlinks not followed.
export async function findRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = []
  await walkForRepos(root, 1, maxDepth, repos)
  return repos.sort()
}

async function walkForRepos(dir: string, depth: number, maxDepth: number, repos: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const directories = entries.filter((entry) => entry.isDirectory())
  if (directories.some((entry) => entry.name === '.git')) repos.push(dir)
  if (depth >= maxDepth) return
  await Promise.all(
    directories
      .filter((entry) => entry.name !== '.git')
      .map((entry) => walkForRepos(path.join(dir, entry.name), depth + 1, maxDepth, repos)),
  )
}

// Repo roots by directory, so the many calls of one player in one folder cost one git call.
export class RepoRootCache {
  private readonly roots = new Map<string, Promise<string | null>>()

  // Keyed by the closest folder that exists, so the many paths a command names that share a
  // folder (or name nothing real) cost one git call between them.
  async rootOf(dir: string): Promise<string | null> {
    const existing = await nearestExistingDir(dir)
    const known = this.roots.get(existing)
    if (known) return known
    const lookup = this.lookup(existing)
    this.roots.set(existing, lookup)
    return lookup
  }

  rootOfFile(file: string): Promise<string | null> {
    return this.rootOf(path.dirname(file))
  }

  private async lookup(dir: string): Promise<string | null> {
    const top = await runGit(dir, ['rev-parse', '--show-toplevel'])
    if (!top.ok) return null
    return top.stdout.trim()
  }
}

// A deleted file's folder may be gone too; its repo is found from the closest folder still there.
async function nearestExistingDir(dir: string): Promise<string> {
  const stat = await fs.stat(dir).catch(() => null)
  if (stat?.isDirectory()) return dir
  const parent = path.dirname(dir)
  if (parent === dir) return dir
  return nearestExistingDir(parent)
}

// One read per repo per refresh, shared by every player whose calls land in it.
export function repoStateLoader(): (root: string) => Promise<RepoState> {
  const states = new Map<string, Promise<RepoState>>()
  return (root) => {
    const known = states.get(root)
    if (known) return known
    const state = readRepoState(root)
    states.set(root, state)
    return state
  }
}
