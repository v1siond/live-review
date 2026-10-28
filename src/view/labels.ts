import * as path from 'node:path'
import type { Player } from '../core/players'
import type { RepoState } from '../core/repoState'

export function repoName(root: string, projectsRoot: string): string {
  const relative = path.relative(projectsRoot, root)
  return relative.startsWith('..') ? root : relative
}

// The session's own agent is "you" in its session; outside it, the project says which session.
export function playerTag(player: Player): string {
  if (player.main) return `you, ${player.session.project}`
  return player.row ? `Row ${player.row.number}` : player.description
}

// Every player credited with each file, so a file names all of its writers.
export function writersByFile(players: Player[]): Map<string, Player[]> {
  const writers = new Map<string, Player[]>()
  players.forEach((player) => player.files.forEach((file) => writers.set(file.file, [...(writers.get(file.file) ?? []), player])))
  return writers
}

export function repoSummary(state: RepoState | undefined): string {
  if (!state) return 'reading'
  if (isComparing(state)) return comparedSummary(state)
  const parts = [state.branch, `${state.uncommitted.length} changed`, `${state.ahead} unpushed`]
  if (state.behind > 0) parts.push(`${state.behind} behind`)
  if (state.compareMissing) parts.unshift(`vs ${state.compareRef} (missing)`)
  return parts.join(', ')
}

type ComparedState = RepoState & { compareRef: string }

// committed holds no dirty path, so the two lengths add up to the union of both lists.
function comparedSummary(state: ComparedState): string {
  const changed = state.uncommitted.length + state.committed.length
  return `vs ${state.compareRef}, ${state.branch}, ${changed} changed, ${state.ahead} ahead, ${state.behind} behind`
}

// Words that change with the compare mode: what a commit in the list is, and what a file that is
// only committed is.
export function commitWords(state: RepoState | undefined): string {
  return isComparing(state) ? `ahead of ${state.compareRef}` : 'not pushed'
}

export function committedWord(state: RepoState | undefined): string {
  return isComparing(state) ? 'committed' : 'unpushed'
}

export function isComparing(state: RepoState | undefined): state is ComparedState {
  return state !== undefined && state.compareRef !== null && !state.compareMissing
}
