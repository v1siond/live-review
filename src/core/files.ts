import { promises as fs } from 'node:fs'

// 0 for a file that is gone: it falls outside every call window, so a deleted file is never
// credited by its mtime.
export async function modifiedAt(file: string): Promise<number> {
  const stat = await fs.stat(file).catch(() => null)
  return stat ? stat.mtimeMs : 0
}
