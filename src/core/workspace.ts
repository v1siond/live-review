import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { changedFileOf } from './attribution'
import type { ToolCall } from './transcript'

export type WorkspaceFile = { file: string; relative: string; mtime: number }

type Scan = { at: number; files: { file: string; mtime: number }[] }

// Folders that hold tools and dependencies, never notes a session wrote.
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
// A workspace folder holds up to tens of thousands of files; one walk serves every session that
// maps to it for this long, so the 4 s refresh beat does not stat them all on every beat.
const SCAN_TTL_MS = 15_000

// The workspace folders a session writes its notes in: the first folder under the workspace root
// of every file its Write and Edit calls name there. A folder can be a symlink to another
// (website -> app), so each is resolved and listed once. An empty root turns the feature off.
export async function workspaceFolders(calls: ToolCall[], root: string): Promise<string[]> {
  if (!root) return []
  const names = new Set(calls.map((call) => folderUnder(changedFileOf(call), root)).filter((name): name is string => name !== null))
  const resolved = await Promise.all([...names].map((name) => fs.realpath(path.join(root, name)).catch(() => null)))
  return [...new Set(resolved.filter((folder): folder is string => folder !== null))]
}

function folderUnder(file: string | null, root: string): string | null {
  if (!file) return null
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  const [first, ...rest] = relative.split(path.sep)
  return rest.length > 0 ? first : null
}

export class WorkspaceScanner {
  private readonly scans = new Map<string, Scan>()

  // Files of the folders saved at or after the session started, newest first, each named relative
  // to the workspace root.
  async filesSince(root: string, folders: string[], since: number, now: number): Promise<WorkspaceFile[]> {
    const scans = await Promise.all(folders.map((folder) => this.scanOf(folder, now)))
    return scans
      .flatMap((scan) => scan.files)
      .filter((entry) => entry.mtime >= since)
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => ({ ...entry, relative: path.relative(root, entry.file) }))
  }

  private async scanOf(folder: string, now: number): Promise<Scan> {
    const known = this.scans.get(folder)
    if (known && now - known.at < SCAN_TTL_MS) return known
    const scan = { at: now, files: await walk(folder) }
    this.scans.set(folder, scan)
    return scan
  }
}

// Symlinks are not followed: a link inside a folder points back into the workspace or at a tool.
async function walk(dir: string): Promise<{ file: string; mtime: number }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(full)
      if (!entry.isFile()) return []
      const stat = await fs.stat(full).catch(() => null)
      return stat ? [{ file: full, mtime: stat.mtimeMs }] : []
    }),
  )
  return nested.flat()
}
