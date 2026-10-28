import * as vscode from 'vscode'
import { HEAD_PICK, listBranches } from '../core/compare'
import type { Controller } from './controller'

// value is what the store keeps for the repo: "HEAD", a branch name, or undefined for the default.
type PickItem = vscode.QuickPickItem & { value?: string }

const DEFAULT_PICK: PickItem = { label: 'Use the default (liveReview.defaultCompareBranch)', value: undefined }
const HEAD_ITEM: PickItem = { label: 'HEAD (uncommitted and unpushed work)', value: HEAD_PICK }

// Escape leaves the repo as it was; every other choice is stored and the repo read again.
export async function pickCompareTarget(root: string, controller: Controller): Promise<void> {
  const branches = await listBranches(root)
  const items: PickItem[] = [
    HEAD_ITEM,
    DEFAULT_PICK,
    ...section('Local branches', branches.local),
    ...section('Remote branches', branches.remote),
  ]
  const picked = await vscode.window.showQuickPick(items, { title: 'Compare to a branch', placeHolder: 'Pick what this repo is compared to' })
  if (!picked) return
  await controller.compareTo(root, picked.value)
}

function section(title: string, names: string[]): PickItem[] {
  if (names.length === 0) return []
  return [{ label: title, kind: vscode.QuickPickItemKind.Separator }, ...names.map((name) => ({ label: name, value: name }))]
}
