import { runGit } from './git'
import { findRepos } from './repoState'
import { systemOf, type GitSystem } from './systems'

export type RepoEntry = { root: string; origin: string | null; system: string; found: 'scan' | 'added' }

// Where the clones live and how deep to look: depth 3 finds a .git two folders down
// (projects/group/repo).
export type RepoScan = { projectsRoot: string; depth: number }

// The scanned clones plus the extra roots (a folder the user added, a repo a player edited), each
// under the system its origin points at.
export async function indexRepos(scan: RepoScan, extraRoots: string[], systems: GitSystem[]): Promise<RepoEntry[]> {
  const scanned = await findRepos(scan.projectsRoot, scan.depth)
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
