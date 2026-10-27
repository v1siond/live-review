import type * as vscode from 'vscode'
import type { History } from '../core/players'

const PICKED = 'liveReview.picked'
const PINNED = 'liveReview.pinned'
const ADDED = 'liveReview.added'
const REMOVED = 'liveReview.removed'
const HISTORY = 'liveReview.sessionHistory'
const DISMISSED = 'liveReview.dismissed'

// Per session id, then per agent id, the files credited to it by the Bash window rule.
type StoredHistory = Record<string, Record<string, string[]>>
// Per dismissed key (a session id, or "<session id>/<agent id>"), when he removed it.
type StoredDismissed = Record<string, number>

// What he chose lives in globalState, so every window shows the same picks and the same removed
// sessions and players. The Bash credits seen per session live in workspaceState: each window
// rebuilds them from the transcripts anyway, they only keep a credit a later save would hide.
// Both maps keep only the sessions still listed, so neither grows with every session he ever ran.
export class Store {
  constructor(
    private readonly global: vscode.Memento,
    private readonly workspace: vscode.Memento,
  ) {}

  picked(): Set<string> {
    return this.readSet(this.global, PICKED)
  }

  pinned(): Set<string> {
    return this.readSet(this.global, PINNED)
  }

  added(): Set<string> {
    return this.readSet(this.global, ADDED)
  }

  removed(): Set<string> {
    return this.readSet(this.global, REMOVED)
  }

  setPicked(root: string, picked: boolean): Thenable<void> {
    return this.toggle(this.global, PICKED, root, picked)
  }

  setPinned(root: string, pinned: boolean): Thenable<void> {
    return this.toggle(this.global, PINNED, root, pinned)
  }

  async addRepo(root: string): Promise<void> {
    await this.toggle(this.global, REMOVED, root, false)
    await this.toggle(this.global, ADDED, root, true)
  }

  async removeRepo(root: string): Promise<void> {
    await Promise.all([PICKED, PINNED, ADDED].map((key) => this.toggle(this.global, key, root, false)))
    await this.toggle(this.global, REMOVED, root, true)
  }

  history(session: string): History {
    const stored = this.workspace.get<StoredHistory>(HISTORY, {})[session] ?? {}
    return new Map(Object.entries(stored).map(([agent, files]) => [agent, new Set(files)]))
  }

  saveHistory(session: string, history: History, listed: Set<string>): Thenable<void> {
    const byAgent = Object.fromEntries([...history].map(([agent, files]) => [agent, [...files]]))
    const kept = keepListed(this.workspace.get<StoredHistory>(HISTORY, {}), listed)
    return this.workspace.update(HISTORY, { ...kept, [session]: byAgent })
  }

  dismissed(): Map<string, number> {
    return new Map(Object.entries(this.global.get<StoredDismissed>(DISMISSED, {})))
  }

  dismiss(keys: string[], at: number, listed: Set<string>): Thenable<void> {
    const kept = keepListed(this.global.get<StoredDismissed>(DISMISSED, {}), listed)
    return this.global.update(DISMISSED, { ...kept, ...Object.fromEntries(keys.map((key) => [key, at])) })
  }

  private readSet(memento: vscode.Memento, key: string): Set<string> {
    return new Set(memento.get<string[]>(key, []))
  }

  private toggle(memento: vscode.Memento, key: string, value: string, on: boolean): Thenable<void> {
    const values = this.readSet(memento, key)
    if (on) values.add(value)
    if (!on) values.delete(value)
    return memento.update(key, [...values])
  }
}

// A key is a session id or starts with "<session id>/".
function keepListed<T>(stored: Record<string, T>, listed: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(stored).filter(([key]) => listed.has(key.split('/')[0])))
}
