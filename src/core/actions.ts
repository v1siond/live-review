import * as path from 'node:path'
import type { ToolCall } from './transcript'

type Describe = (input: Record<string, unknown>) => string

const fileName = (input: Record<string, unknown>, key = 'file_path') => path.basename(String(input[key] ?? ''))

const firstLine = (text: unknown, limit = 80) => String(text ?? '').split('\n')[0].slice(0, limit)

// A Bash call carries its own one-line description; the rest are named from their input.
const describers: Record<string, Describe> = {
  Write: (input) => `writing ${fileName(input)}`,
  Edit: (input) => `editing ${fileName(input)}`,
  MultiEdit: (input) => `editing ${fileName(input)}`,
  Read: (input) => `reading ${fileName(input)}`,
  Bash: (input) => lowerFirst(String(input.description ?? '')) || `running ${firstLine(input.command)}`,
  Skill: (input) => `loading skill ${String(input.skill ?? '')}`,
  WebFetch: (input) => `fetching ${firstLine(input.url)}`,
  WebSearch: (input) => `searching "${firstLine(input.query)}"`,
  Monitor: (input) => `watching ${lowerFirst(firstLine(input.description ?? input.command))}`,
}

export function describeCall(call: ToolCall): string {
  const describe = describers[call.name]
  if (!describe) return `using ${call.name}`
  return describe(call.input)
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
