import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Player } from '../core/players'
import type { Controller } from './controller'
import { committedWord, playerTag, repoName, repoSummary, writersByFile } from './labels'
import { fileItem, type FileNode } from './reposView'
import type { Store } from './store'

type Node = { kind: 'repo'; root: string } | FileNode

// No transcript of a live session credits the file: the user saved it, or a session that is no
// longer listed did.
const NO_PLAYER = 'by hand'

export class ChangesView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private writers = new Map<string, Player[]>()

  constructor(
    private readonly controller: Controller,
    private readonly store: Store,
  ) {
    controller.onDidChange(() => {
      this.writers = writersByFile(controller.model.players)
      this.changed.fire()
    })
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.pickedRepos()
    if (node.kind === 'file') return []
    return this.filesOf(node.root)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') return fileItem(node, this.tagOf(path.join(node.root, node.relative)))
    const item = new vscode.TreeItem(repoName(node.root, this.controller.model.settings.projectsRoot), vscode.TreeItemCollapsibleState.Expanded)
    item.description = repoSummary(this.controller.model.states.get(node.root))
    item.iconPath = new vscode.ThemeIcon('repo')
    return item
  }

  private pickedRepos(): Node[] {
    const picked = this.store.picked()
    return this.controller.model.repos.filter((entry) => picked.has(entry.root)).map((entry) => ({ kind: 'repo', root: entry.root }))
  }

  // Dirty files first with their status, then the files only a commit holds: unpushed, or in
  // compare mode committed since the merge base.
  private filesOf(root: string): Node[] {
    const state = this.controller.model.states.get(root)
    if (!state) return []
    const uncommitted: FileNode[] = state.uncommitted.map((file) => ({ kind: 'file', root, relative: file.path, status: file.status, committedOnly: false }))
    const word = committedWord(state)
    const committed: FileNode[] = state.committed.map((file) => ({ kind: 'file', root, relative: file.path, status: word, committedOnly: true }))
    return [...uncommitted, ...committed]
  }

  private tagOf(file: string): string {
    const writers = this.writers.get(file) ?? []
    if (writers.length === 0) return NO_PLAYER
    return writers.map(playerTag).join(', ')
  }
}
