import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Player, PlayerFile, PlayerState } from '../core/players'
import type { WorkspaceFile } from '../core/workspace'
import type { Controller, SessionView } from './controller'
import type { DiffTarget } from './documents'
import { repoName, writersByFile } from './labels'

export type SessionNode = { kind: 'session'; view: SessionView }
export type PlayerNode = { kind: 'player'; player: Player }

type Node =
  | SessionNode
  | PlayerNode
  | { kind: 'repo'; player: Player; repo: string | null }
  | { kind: 'file'; player: Player; file: PlayerFile }
  | { kind: 'workspace'; view: SessionView }
  | { kind: 'workspaceFile'; view: SessionView; file: WorkspaceFile }

const OUTSIDE_GIT = 'outside git'
const WORKSPACE_FILES = 'Workspace files'

const STATE_ICONS: Record<PlayerState, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green')),
  waiting: new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow')),
  done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('disabledForeground')),
}

const STATE_ORDER: Record<PlayerState, number> = { working: 0, waiting: 1, done: 2 }

// Every node carries an id built from what it shows (session, agent, repo, file), never from its
// position, so a refresh finds the same nodes and the ones he expanded stay expanded.
export class SessionsView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private writers = new Map<string, Player[]>()

  private readonly children: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => Node[] } = {
    session: (node) => sessionChildren(node.view),
    player: (node) => reposOf(node.player),
    repo: (node) =>
      node.player.files.filter((file) => file.repo === node.repo).map((file) => ({ kind: 'file', player: node.player, file })),
    file: () => [],
    workspace: (node) => node.view.workspace.map((file) => ({ kind: 'workspaceFile', view: node.view, file })),
    workspaceFile: () => [],
  }

  private readonly items: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => vscode.TreeItem } = {
    session: (node) => sessionItem(node.view),
    player: (node) => playerItem(node.player),
    repo: (node) => repoItem(node.player, node.repo),
    file: (node) => this.fileItem(node.player, node.file),
    workspace: (node) => workspaceItem(node.view),
    workspaceFile: (node) => workspaceFileItem(node.view, node.file),
  }

  constructor(private readonly controller: Controller) {
    controller.onDidChange(() => {
      this.writers = writersByFile(controller.model.players)
      this.changed.fire()
    })
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.controller.model.sessions.map((view) => ({ kind: 'session', view }))
    return (this.children[node.kind] as (node: Node) => Node[])(node)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return (this.items[node.kind] as (node: Node) => vscode.TreeItem)(node)
  }

  // A file this player changed with Edit and that another player also wrote shows only this
  // player's own hunks; any other file shows the whole diff of the repo.
  private fileItem(player: Player, file: PlayerFile): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(file.file), vscode.TreeItemCollapsibleState.None)
    item.id = `file:${player.key}:${file.file}`
    const sharedWith = (this.writers.get(file.file) ?? []).filter((writer) => writer.key !== player.key)
    const ownHunks = file.how === 'edit' && (file.repo === null || sharedWith.length > 0)
    item.description = [path.dirname(file.relative ?? file.file), file.status, sharedWith.length > 0 ? 'also written by another player' : '']
      .filter((part) => part && part !== '.')
      .join(' | ')
    item.resourceUri = vscode.Uri.file(file.file)
    item.tooltip = `${file.file}\nfound by ${file.how}`
    const target: DiffTarget = {
      file: file.file,
      root: file.repo,
      relative: file.relative,
      committedOnly: file.status === 'unpushed',
      agent: ownHunks ? player.key : undefined,
    }
    item.command = { command: 'liveReview.openDiff', title: 'Open the diff', arguments: [target] }
    return item
  }
}

// The session's own agent first, then its players by state; the workspace files close the list.
function sessionChildren(view: SessionView): Node[] {
  const players: Node[] = sortPlayers(view.players).map((player) => ({ kind: 'player', player }))
  return [...players, { kind: 'workspace', view }]
}

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort(
    (a, b) => Number(b.main) - Number(a.main) || STATE_ORDER[a.verdict.state] - STATE_ORDER[b.verdict.state] || a.label.localeCompare(b.label),
  )
}

function reposOf(player: Player): Node[] {
  const repos = [...new Set(player.files.map((file) => file.repo))]
  return repos.map((repo) => ({ kind: 'repo', player, repo }))
}

function sessionItem(view: SessionView): vscode.TreeItem {
  const item = new vscode.TreeItem(`${view.ref.project}, ${startLabel(view.ref.startedAt)}`, vscode.TreeItemCollapsibleState.Expanded)
  item.id = `session:${view.ref.id}`
  const working = view.players.filter((player) => player.verdict.state === 'working').length
  item.description = `${view.players.length} players, ${working} working`
  item.tooltip = `${view.ref.project}\nsession ${view.ref.id}\nstarted ${new Date(view.ref.startedAt).toLocaleString()}`
  item.iconPath = new vscode.ThemeIcon('comment-discussion')
  item.contextValue = 'session'
  return item
}

// Today's sessions by their hour; an older one also carries its day.
function startLabel(startedAt: number): string {
  const start = new Date(startedAt)
  const time = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (start.toDateString() === new Date().toDateString()) return time
  return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function playerItem(player: Player): vscode.TreeItem {
  const collapsed = player.files.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(player.label, collapsed)
  item.id = `player:${player.key}`
  item.description = `${player.verdict.state}, ${player.lastAction}`
  item.tooltip = `${player.label}\n${player.id}\n${player.verdict.state}: ${player.verdict.rule}\nClick for its timeline.`
  item.iconPath = STATE_ICONS[player.verdict.state]
  item.contextValue = 'player'
  item.command = { command: 'liveReview.openTimeline', title: 'Open the timeline', arguments: [player.key] }
  return item
}

function repoItem(player: Player, repo: string | null): vscode.TreeItem {
  const count = player.files.filter((file) => file.repo === repo).length
  const item = new vscode.TreeItem(repo ? repoName(repo) : OUTSIDE_GIT, vscode.TreeItemCollapsibleState.Expanded)
  item.id = `repo:${player.key}:${repo ?? OUTSIDE_GIT}`
  item.description = `${count} files`
  item.iconPath = new vscode.ThemeIcon(repo ? 'repo' : 'folder')
  return item
}

function workspaceItem(view: SessionView): vscode.TreeItem {
  const collapsed = view.workspace.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(WORKSPACE_FILES, collapsed)
  item.id = `workspace:${view.ref.id}`
  item.description = `${view.workspace.length} files since the session started`
  item.iconPath = new vscode.ThemeIcon('notebook')
  return item
}

function workspaceFileItem(view: SessionView, file: WorkspaceFile): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(file.file), vscode.TreeItemCollapsibleState.None)
  item.id = `workspaceFile:${view.ref.id}:${file.file}`
  item.description = `${path.dirname(file.relative)} | ${new Date(file.mtime).toLocaleTimeString()}`
  item.resourceUri = vscode.Uri.file(file.file)
  item.tooltip = file.file
  item.command = { command: 'vscode.open', title: 'Open the file', arguments: [vscode.Uri.file(file.file)] }
  return item
}
