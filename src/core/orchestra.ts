import { promises as fs } from 'node:fs'

export type RecordRow = { number: number; status: string; ticket: string }

const ROW_IN_DESCRIPTION = /\brow\s+(\d+)\b/i

export function rowNumber(description: string): number | null {
  const match = description.match(ROW_IN_DESCRIPTION)
  return match ? Number(match[1]) : null
}

// The job is the description without its "Row <n>" lead, which the row label already says.
export function jobOf(description: string): string {
  return description.replace(ROW_IN_DESCRIPTION, '').replace(/\s+/g, ' ').trim()
}

export async function readRecords(files: string[]): Promise<string[]> {
  return Promise.all(files.map((file) => fs.readFile(file, 'utf8').catch(() => '')))
}

// The first "| <status> | <n> | <ticket> |" line wins: the ticket table sits above every other
// table that reuses row numbers.
export function findRow(records: string[], number: number): RecordRow | null {
  const line = new RegExp(`^\\|\\s*([^|]+?)\\s*\\|\\s*${number}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm')
  for (const text of records) {
    const match = text.match(line)
    if (match) return { number, status: match[1], ticket: match[2] }
  }
  return null
}
