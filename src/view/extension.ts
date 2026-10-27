import * as vscode from 'vscode'
import { CLAUDE_PROJECTS, listCurrentSessions } from '../core/sessions'
import { ChangesView } from './changesView'
import { Controller } from './controller'
import { openDiff, openTimeline, ReviewDocuments, SCHEME, type DiffTarget } from './documents'
import { PlayersView } from './playersView'
import { ReposView } from './reposView'
import { Store } from './store'

type RepoNode = { kind: 'repo'; root: string }

const FOLLOW_NEWEST = 'Follow the newest session'
// A save is on disk before the event fires; a short wait lets git see it.
const SAVE_DELAY_MS = 300

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context.globalState, context.workspaceState)
  const log = vscode.window.createOutputChannel('Live Review')
  const controller = new Controller(store, log)
  const documents = new ReviewDocuments(controller)
  const repos = new ReposView(controller, store)
  const reposTree = vscode.window.createTreeView('liveReview.repos', { treeDataProvider: repos, manageCheckboxStateManually: true })
  const playersTree = vscode.window.createTreeView('liveReview.players', { treeDataProvider: new PlayersView(controller) })
  const changesTree = vscode.window.createTreeView('liveReview.changes', { treeDataProvider: new ChangesView(controller, store) })
  const trees = [reposTree, playersTree, changesTree]

  context.subscriptions.push(
    log,
    controller,
    documents,
    ...trees,
    ...trees.map((tree) => tree.onDidChangeVisibility((event) => controller.viewVisible(event.visible))),
    reposTree.onDidChangeCheckboxState((event) => repos.onCheckbox(event)),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.workspace.onDidSaveTextDocument(() => controller.scheduleRefresh(SAVE_DELAY_MS)),
    vscode.commands.registerCommand('liveReview.refresh', () => controller.rescanRepos()),
    vscode.commands.registerCommand('liveReview.fetch', () => controller.fetchPicked()),
    vscode.commands.registerCommand('liveReview.addRepo', () => addRepo(controller)),
    vscode.commands.registerCommand('liveReview.pinRepo', (node: RepoNode) => pin(store, controller, node.root, true)),
    vscode.commands.registerCommand('liveReview.unpinRepo', (node: RepoNode) => pin(store, controller, node.root, false)),
    vscode.commands.registerCommand('liveReview.removeRepo', (node: RepoNode) => controller.removeRepo(node.root)),
    vscode.commands.registerCommand('liveReview.pickSession', () => pickSession(controller)),
    vscode.commands.registerCommand('liveReview.clearFinished', () => controller.clearFinished()),
    vscode.commands.registerCommand('liveReview.openTimeline', (agent: string) => openTimeline(agent)),
    vscode.commands.registerCommand('liveReview.openDiff', (target: DiffTarget) => openDiff(target, controller)),
  )
  trees.filter((tree) => tree.visible).forEach(() => controller.viewVisible(true))
  void controller.start()
}

async function addRepo(controller: Controller): Promise<void> {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Add repo' })
  const folder = picked?.[0]
  if (!folder) return
  await controller.addRepo(folder.fsPath)
}

async function pin(store: Store, controller: Controller, root: string, pinned: boolean): Promise<void> {
  await store.setPinned(root, pinned)
  await controller.refresh()
}

async function pickSession(controller: Controller): Promise<void> {
  const sessions = await listCurrentSessions(CLAUDE_PROJECTS)
  const items = [
    { label: FOLLOW_NEWEST, description: '', id: null },
    ...sessions.map((session) => ({
      label: session.id,
      description: `${session.project}, last write ${new Date(session.lastWrite).toLocaleString()}`,
      id: session.id as string | null,
    })),
  ]
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Claude session to review' })
  if (!choice) return
  await controller.useSession(choice.id)
}
