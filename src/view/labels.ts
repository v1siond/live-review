import * as path from 'node:path'
import type { Player } from '../core/players'
import { PROJECTS_ROOT } from '../core/repoIndex'
import type { RepoState } from '../core/repoState'

export function repoName(root: string): string {
  const relative = path.relative(PROJECTS_ROOT, root)
  return relative.startsWith('..') ? root : relative
}

export function playerTag(player: Player): string {
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
  const parts = [state.branch, `${state.uncommitted.length} changed`, `${state.ahead} unpushed`]
  if (state.behind > 0) parts.push(`${state.behind} behind`)
  return parts.join(', ')
}
