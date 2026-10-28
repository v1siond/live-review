import { runGit } from './git'

// What the user chose for one repo: the stored pick ("HEAD", a branch name, or nothing when the
// default applies) and the liveReview.defaultCompareBranch setting ("" for none).
export type CompareChoice = { stored: string | undefined; fallback: string }

export type Branches = { local: string[]; remote: string[] }

// The stored pick that compares a repo to HEAD even when a default branch is set.
export const HEAD_PICK = 'HEAD'

// The ref a repo is compared to, or null for the HEAD comparison. A stored branch is kept even
// when it no longer resolves, so the summary can say it is missing; the default applies only
// where it names a commit, since one setting covers every repo and most lack some branch.
export async function compareRefOf(root: string, choice: CompareChoice): Promise<string | null> {
  if (choice.stored === HEAD_PICK) return null
  if (choice.stored) return choice.stored
  if (!choice.fallback) return null
  const resolved = await runGit(root, ['rev-parse', '--verify', '--quiet', `${choice.fallback}^{commit}`])
  return resolved.ok ? choice.fallback : null
}

// Local branches, then remote ones; a remote's HEAD only points at one of its branches.
export async function listBranches(root: string): Promise<Branches> {
  const [local, remote] = await Promise.all([refNames(root, 'refs/heads'), refNames(root, 'refs/remotes')])
  return { local, remote: remote.filter((name) => !name.endsWith('/HEAD')) }
}

async function refNames(root: string, prefix: string): Promise<string[]> {
  const refs = await runGit(root, ['for-each-ref', '--format=%(refname:short)', prefix])
  if (!refs.ok) return []
  return refs.stdout.split('\n').filter(Boolean)
}
