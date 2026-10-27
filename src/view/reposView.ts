import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Player } from '../core/players'
import type { RepoEntry } from '../core/repoIndex'
import { changedPaths, hasWork, type Commit } from '../core/repoState'
import { OTHER_SYSTEM } from '../core/systems'
import type { Controller } from './controller'
import type { DiffTarget } from './documents'
import { playerTag, repoName, repoSummary } from './labels'
import type { Store } from './store'

export type FileNode = { kind: 'file'; root: string; relative: string; status: string; committedOnly: boolean }

type Node = { kind: 'system'; name: string } | { kind: 'repo'; root: string } | FileNode | { kind: 'commit'; root: string; commit: Commit }

// Rank inside a system: repos a player of the session edited, then pinned, then repos with
// work to review; a repo with nothing uncommitted or unpushed sorts last.
const RANK = { played: 0, pinned: 1, work: 2, idle: 3 }

export class ReposView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private playersByRepo = new Map<string, string[]>()

  private readonly children: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => Node[] } = {
    system: (node) => this.reposOf(node.name),
    repo: (node) => this.workOf(node.root),
    file: () => [],
    commit: (node) =>
      node.commit.files.map((relative) => ({ kind: 'file', root: node.root, relative, status: 'committed', committedOnly: true })),
  }

  private readonly items: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => vscode.TreeItem } = {
    system: (node) => this.systemItem(node.name),
    repo: (node) => this.repoItem(node.root),
    file: (node) => fileItem(node),
    commit: (node) => commitItem(node.commit),
  }

  constructor(
    private readonly controller: Controller,
    private readonly store: Store,
  ) {
    controller.onDidChange(() => {
      this.playersByRepo = tagsByRepo(controller.model.players)
      this.changed.fire()
    })
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.systemNames().map((name) => ({ kind: 'system', name }))
    return (this.children[node.kind] as (node: Node) => Node[])(node)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return (this.items[node.kind] as (node: Node) => vscode.TreeItem)(node)
  }

  async onCheckbox(event: vscode.TreeCheckboxChangeEvent<Node>): Promise<void> {
    for (const [node, state] of event.items) {
      if (node.kind !== 'repo') continue
      await this.store.setPicked(node.root, state === vscode.TreeItemCheckboxState.Checked)
    }
    await this.controller.refresh()
  }

  private systemNames(): string[] {
    const names = this.controller.model.systems.map((system) => system.name)
    const hasOther = this.controller.model.repos.some((entry) => entry.system === OTHER_SYSTEM)
    return hasOther ? [...names, OTHER_SYSTEM] : names
  }

  private reposOf(system: string): Node[] {
    const pinned = this.store.pinned()
    return this.controller.model.repos
      .filter((entry) => entry.system === system)
      .map((entry) => ({ entry, rank: this.rank(entry, pinned) }))
      .sort((a, b) => a.rank - b.rank || a.entry.root.localeCompare(b.entry.root))
      .map(({ entry }) => ({ kind: 'repo', root: entry.root }))
  }

  private rank(entry: RepoEntry, pinned: Set<string>): number {
    if (this.playersByRepo.has(entry.root)) return RANK.played
    if (pinned.has(entry.root)) return RANK.pinned
    const state = this.controller.model.states.get(entry.root)
    return state && hasWork(state) ? RANK.work : RANK.idle
  }

  private workOf(root: string): Node[] {
    const state = this.controller.model.states.get(root)
    if (!state) return []
    const changed = changedPaths(state)
    const files: Node[] = state.uncommitted.map((file) => ({
      kind: 'file',
      root,
      relative: file.path,
      status: file.status,
      committedOnly: changed.get(file.path) === 'unpushed',
    }))
    const commits: Node[] = state.unpushed.map((commit) => ({ kind: 'commit', root, commit }))
    return [...files, ...commits]
  }

  private systemItem(name: string): vscode.TreeItem {
    const count = this.controller.model.repos.filter((entry) => entry.system === name).length
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded)
    item.description = `${count} repos`
    item.iconPath = new vscode.ThemeIcon('server')
    return item
  }

  private repoItem(root: string): vscode.TreeItem {
    const state = this.controller.model.states.get(root)
    const work = state ? hasWork(state) : false
    const item = new vscode.TreeItem(repoName(root), work ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    const players = this.playersByRepo.get(root) ?? []
    item.description = [players.join(', '), repoSummary(state)].filter(Boolean).join(' | ')
    item.tooltip = `${root}\norigin: ${this.originOf(root)}`
    item.iconPath = new vscode.ThemeIcon(players.length > 0 ? 'account' : 'repo', work ? undefined : new vscode.ThemeColor('disabledForeground'))
    const picked = this.store.picked().has(root)
    item.checkboxState = picked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
    item.contextValue = this.store.pinned().has(root) ? 'repo.pinned' : 'repo.unpinned'
    return item
  }

  private originOf(root: string): string {
    return this.controller.model.repos.find((entry) => entry.root === root)?.origin ?? 'none'
  }
}

export function fileItem(node: FileNode, tag?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(node.relative), vscode.TreeItemCollapsibleState.None)
  item.description = [tag, path.dirname(node.relative), node.status].filter((part) => part && part !== '.').join(' | ')
  item.resourceUri = vscode.Uri.file(path.join(node.root, node.relative))
  item.tooltip = path.join(node.root, node.relative)
  const target: DiffTarget = {
    file: path.join(node.root, node.relative),
    root: node.root,
    relative: node.relative,
    committedOnly: node.committedOnly,
  }
  item.command = { command: 'liveReview.openDiff', title: 'Open the diff', arguments: [target] }
  return item
}

function tagsByRepo(players: Player[]): Map<string, string[]> {
  const tags = new Map<string, Set<string>>()
  players.forEach((player) =>
    player.files.forEach((file) => {
      if (!file.repo) return
      tags.set(file.repo, (tags.get(file.repo) ?? new Set()).add(playerTag(player)))
    }),
  )
  return new Map([...tags].map(([repo, names]) => [repo, [...names]]))
}

function commitItem(commit: Commit): vscode.TreeItem {
  const item = new vscode.TreeItem(commit.subject, vscode.TreeItemCollapsibleState.Collapsed)
  item.description = `${commit.sha.slice(0, 8)}, ${new Date(commit.time).toLocaleString()}, not pushed`
  item.iconPath = new vscode.ThemeIcon('git-commit')
  return item
}
