import type * as vscode from 'vscode'
import type { History } from '../core/players'

const PICKED = 'liveReview.picked'
const PINNED = 'liveReview.pinned'
const ADDED = 'liveReview.added'
const REMOVED = 'liveReview.removed'
const SESSION = 'liveReview.session'
const HISTORY = 'liveReview.history'
const CLEARED = 'liveReview.cleared'

type StoredHistory = { session: string; byAgent: Record<string, string[]> }
type StoredCleared = { session: string; agents: string[] }

// What he chose about repos lives in globalState, so every window shows the same picks. What
// belongs to one Claude session (its history, the players he cleared) lives in workspaceState
// and is dropped when the session changes.
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

  // null means "follow the newest session".
  chosenSession(): string | null {
    return this.workspace.get<string | null>(SESSION, null)
  }

  chooseSession(id: string | null): Thenable<void> {
    return this.workspace.update(SESSION, id)
  }

  history(session: string): History {
    const stored = this.workspace.get<StoredHistory>(HISTORY)
    if (stored?.session !== session) return new Map()
    return new Map(Object.entries(stored.byAgent).map(([agent, files]) => [agent, new Set(files)]))
  }

  saveHistory(session: string, history: History): Thenable<void> {
    const byAgent = Object.fromEntries([...history].map(([agent, files]) => [agent, [...files]]))
    return this.workspace.update(HISTORY, { session, byAgent })
  }

  cleared(session: string): Set<string> {
    const stored = this.workspace.get<StoredCleared>(CLEARED)
    if (stored?.session !== session) return new Set()
    return new Set(stored.agents)
  }

  saveCleared(session: string, cleared: Set<string>): Thenable<void> {
    return this.workspace.update(CLEARED, { session, agents: [...cleared] })
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
