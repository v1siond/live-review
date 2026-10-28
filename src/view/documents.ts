import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { runGit } from '../core/git'
import type { Hunk } from '../core/attribution'
import type { RepoState } from '../core/repoState'
import type { Controller } from './controller'
import { isComparing } from './labels'

export const SCHEME = 'live-review'

type Request =
  | { kind: 'revision'; root: string; relative: string; rev: string }
  | { kind: 'empty' }
  | { kind: 'hunks'; agent: string; file: string; side: keyof Hunk }
  | { kind: 'timeline'; agent: string }

export type DiffTarget = {
  file: string
  root: string | null
  relative: string | null
  // A file only in unpushed commits is compared with what the remote has; a dirty one with HEAD.
  // In compare mode every file is compared with the merge base.
  committedOnly: boolean
  // The player's key, set when its own Edit hunks are the diff to show (see Sessions view).
  agent?: string
}

const HUNK_SEPARATOR = '\n\n@@ next edit @@\n\n'

// Read-only documents for the left side of a diff (a file at a revision), a player's own edits
// and a player's timeline. Nothing here writes to a repo: `git show` only reads objects.
export class ReviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.changed.event
  private readonly subscription: vscode.Disposable
  private readonly providers: { [K in Request['kind']]: (request: Extract<Request, { kind: K }>) => Promise<string> | string }

  // An open diff re-reads its left side on every refresh: a commit moves HEAD under it.
  constructor(private readonly controller: Controller) {
    this.subscription = controller.onDidChange(() =>
      vscode.workspace.textDocuments.filter((document) => document.uri.scheme === SCHEME).forEach((document) => this.changed.fire(document.uri)),
    )
    this.providers = {
      revision: (request) => this.revision(request),
      empty: () => '',
      hunks: (request) => this.hunks(request),
      timeline: (request) => this.timeline(request),
    }
  }

  dispose(): void {
    this.subscription.dispose()
    this.changed.dispose()
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const request = JSON.parse(uri.query) as Request
    const provide = this.providers[request.kind] as (request: Request) => Promise<string> | string
    return provide(request)
  }

  // A file added after the revision has no blob there; an empty left side shows it as all new.
  private async revision(request: Extract<Request, { kind: 'revision' }>): Promise<string> {
    const shown = await runGit(request.root, ['show', `${request.rev}:${request.relative}`])
    if (shown.ok) return shown.stdout
    if (/does not exist|exists on disk, but not in/.test(shown.error)) return ''
    throw new Error(`git show ${request.rev}:${request.relative} in ${request.root}: ${shown.error}`)
  }

  private hunks(request: Extract<Request, { kind: 'hunks' }>): string {
    const player = this.controller.model.players.find((candidate) => candidate.key === request.agent)
    const hunks = player?.hunks.get(request.file) ?? []
    return hunks.map((hunk) => hunk[request.side]).join(HUNK_SEPARATOR)
  }

  private timeline(request: Extract<Request, { kind: 'timeline' }>): string {
    const player = this.controller.model.players.find((candidate) => candidate.key === request.agent)
    if (!player) return `Player ${request.agent} is no longer listed.`
    const lines = player.timeline.map((entry) => `${new Date(entry.time).toLocaleTimeString()}  ${entry.words}`)
    return [`${player.label}`, `${player.verdict.state}: ${player.verdict.rule}`, '', ...lines].join('\n')
  }
}

export function openTimeline(agent: string): Thenable<unknown> {
  return vscode.window.showTextDocument(requestUri(`timeline-${agent.replace('/', '-')}.txt`, { kind: 'timeline', agent }), { preview: true })
}

export async function openDiff(target: DiffTarget, controller: Controller): Promise<void> {
  const name = path.basename(target.file)
  if (target.agent) {
    const before = requestUri(name, { kind: 'hunks', agent: target.agent, file: target.file, side: 'before' })
    const after = requestUri(name, { kind: 'hunks', agent: target.agent, file: target.file, side: 'after' })
    await vscode.commands.executeCommand('vscode.diff', before, after, `${name}: edits of ${target.agent}`)
    return
  }
  if (!target.root || !target.relative) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.file))
    return
  }
  const base = leftSide(controller.model.states.get(target.root), target.committedOnly)
  const left = requestUri(name, { kind: 'revision', root: target.root, relative: target.relative, rev: base.rev })
  // A file deleted since the base (status D) is gone from disk: its right side is empty.
  const right = existsSync(target.file) ? vscode.Uri.file(target.file) : requestUri(name, { kind: 'empty' })
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${base.label} vs working tree)`)
}

// The revision the left side is read at, and the name the diff title gives it.
function leftSide(state: RepoState | undefined, committedOnly: boolean): { rev: string; label: string } {
  if (isComparing(state)) return { rev: state.baseRev, label: state.compareRef }
  const rev = committedOnly ? (state?.baseRev ?? 'HEAD') : 'HEAD'
  return { rev, label: rev }
}

// The path keeps the file name so the diff editor picks the right language.
function requestUri(name: string, request: Request): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}`, query: JSON.stringify(request) })
}
