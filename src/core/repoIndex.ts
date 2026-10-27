import * as os from 'node:os'
import * as path from 'node:path'
import { runGit } from './git'
import { findRepos } from './repoState'
import { systemOf, type GitSystem } from './systems'

export type RepoEntry = { root: string; origin: string | null; system: string; found: 'scan' | 'added' }

export const PROJECTS_ROOT = path.join(os.homedir(), 'projects')
// .git at depth 3 of the projects folder: a clone two folders down (projects/group/repo).
export const REPO_SCAN_DEPTH = 3

// The scanned clones plus the extra roots (a folder he added, a repo a player edited), each
// under the system its origin points at.
export async function indexRepos(extraRoots: string[], systems: GitSystem[]): Promise<RepoEntry[]> {
  const scanned = await findRepos(PROJECTS_ROOT, REPO_SCAN_DEPTH)
  const known = new Set(scanned)
  const added = [...new Set(extraRoots)].filter((root) => !known.has(root))
  const roots: [string, RepoEntry['found']][] = [
    ...scanned.map((root): [string, RepoEntry['found']] => [root, 'scan']),
    ...added.map((root): [string, RepoEntry['found']] => [root, 'added']),
  ]
  return Promise.all(roots.map(([root, found]) => repoEntry(root, found, systems)))
}

export async function repoEntry(root: string, found: RepoEntry['found'], systems: GitSystem[]): Promise<RepoEntry> {
  const remote = await runGit(root, ['remote', 'get-url', 'origin'])
  const origin = remote.ok ? remote.stdout.trim() : null
  return { root, origin, system: systemOf(origin, systems), found }
}
