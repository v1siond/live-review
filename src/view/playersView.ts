import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Player, PlayerFile, PlayerState } from '../core/players'
import type { Controller } from './controller'
import type { DiffTarget } from './documents'
import { repoName, writersByFile } from './labels'

type Node = { kind: 'player'; player: Player } | { kind: 'repo'; player: Player; repo: string | null } | { kind: 'file'; player: Player; file: PlayerFile }

const OUTSIDE_GIT = 'outside git'

const STATE_ICONS: Record<PlayerState, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green')),
  waiting: new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow')),
  done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('disabledForeground')),
}

const STATE_ORDER: Record<PlayerState, number> = { working: 0, waiting: 1, done: 2 }

export class PlayersView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private writers = new Map<string, Player[]>()

  private readonly children: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => Node[] } = {
    player: (node) => reposOf(node.player),
    repo: (node) =>
      node.player.files.filter((file) => file.repo === node.repo).map((file) => ({ kind: 'file', player: node.player, file })),
    file: () => [],
  }

  private readonly items: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => vscode.TreeItem } = {
    player: (node) => playerItem(node.player),
    repo: (node) => repoItem(node.player, node.repo),
    file: (node) => this.fileItem(node.player, node.file),
  }

  constructor(private readonly controller: Controller) {
    controller.onDidChange(() => {
      this.writers = writersByFile(controller.model.players)
      this.changed.fire()
    })
  }

  getChildren(node?: Node): Node[] {
    if (!node) return sortPlayers(this.controller.model.players).map((player) => ({ kind: 'player', player }))
    return (this.children[node.kind] as (node: Node) => Node[])(node)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return (this.items[node.kind] as (node: Node) => vscode.TreeItem)(node)
  }

  // A file this player changed with Edit and that another player also wrote shows only this
  // player's own hunks; any other file shows the whole diff of the repo.
  private fileItem(player: Player, file: PlayerFile): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(file.file), vscode.TreeItemCollapsibleState.None)
    const sharedWith = (this.writers.get(file.file) ?? []).filter((writer) => writer.id !== player.id)
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
      agent: ownHunks ? player.id : undefined,
    }
    item.command = { command: 'liveReview.openDiff', title: 'Open the diff', arguments: [target] }
    return item
  }
}

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => STATE_ORDER[a.verdict.state] - STATE_ORDER[b.verdict.state] || a.label.localeCompare(b.label))
}

function reposOf(player: Player): Node[] {
  const repos = [...new Set(player.files.map((file) => file.repo))]
  return repos.map((repo) => ({ kind: 'repo', player, repo }))
}

function playerItem(player: Player): vscode.TreeItem {
  const collapsed = player.files.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(player.label, collapsed)
  item.id = player.id
  item.description = `${player.verdict.state}, ${player.lastAction}`
  item.tooltip = `${player.label}\n${player.id}\n${player.verdict.state}: ${player.verdict.rule}\nClick for its timeline.`
  item.iconPath = STATE_ICONS[player.verdict.state]
  item.command = { command: 'liveReview.openTimeline', title: 'Open the timeline', arguments: [player.id] }
  return item
}

function repoItem(player: Player, repo: string | null): vscode.TreeItem {
  const count = player.files.filter((file) => file.repo === repo).length
  const item = new vscode.TreeItem(repo ? repoName(repo) : OUTSIDE_GIT, vscode.TreeItemCollapsibleState.Expanded)
  item.description = `${count} files`
  item.iconPath = new vscode.ThemeIcon(repo ? 'repo' : 'folder')
  return item
}
