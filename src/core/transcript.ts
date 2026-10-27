import { promises as fs } from 'node:fs'

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  cwd: string
  start: number
  // When the call's tool_result (or, for a background call, its task notification) arrived.
  end: number | null
  background: boolean
}

type LastAssistant = 'none' | 'text' | 'tool'

type Line = Record<string, unknown>
type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string }

const NOTIFIED_TOOL_USE = /<tool-use-id>([^<]+)<\/tool-use-id>/

// A transcript only grows, so each read parses the bytes appended since the last one. The
// largest transcripts reach tens of MB; reparsing them on every refresh would stall the host.
export class TranscriptCursor {
  readonly calls: ToolCall[] = []
  lastAssistant: LastAssistant = 'none'
  private readonly byId = new Map<string, ToolCall>()
  private offset = 0
  private partial = ''

  private readonly handlers: Record<string, (line: Line) => void> = {
    assistant: (line) => this.onAssistant(line),
    user: (line) => this.onUser(line),
    attachment: (line) => this.onAttachment(line),
  }

  constructor(readonly file: string) {}

  async readNew(): Promise<void> {
    const handle = await fs.open(this.file, 'r').catch(() => null)
    if (!handle) return
    try {
      const { size } = await handle.stat()
      if (size <= this.offset) return
      const buffer = Buffer.alloc(size - this.offset)
      await handle.read(buffer, 0, buffer.length, this.offset)
      this.offset = size
      this.consume(buffer.toString('utf8'))
    } finally {
      await handle.close()
    }
  }

  private consume(text: string): void {
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    lines.forEach((raw) => this.consumeLine(raw))
  }

  private consumeLine(raw: string): void {
    // Request dumps are most of the bytes and carry no tool call of the player.
    if (raw.startsWith('{"type":"api-request')) return
    const line = parseLine(raw)
    if (!line) return
    this.handlers[String(line.type)]?.(line)
  }

  private onAssistant(line: Line): void {
    for (const block of contentBlocks(line)) {
      if (block.type === 'text') this.lastAssistant = 'text'
      if (block.type === 'tool_use') this.addCall(line, block)
    }
  }

  private addCall(line: Line, block: Block): void {
    this.lastAssistant = 'tool'
    const input = block.input ?? {}
    const call: ToolCall = {
      id: String(block.id),
      name: String(block.name),
      input,
      cwd: String(line.cwd ?? ''),
      start: Date.parse(String(line.timestamp)),
      end: null,
      background: input.run_in_background === true,
    }
    this.calls.push(call)
    this.byId.set(call.id, call)
  }

  // A background call answers at once with "running in background"; its window stays open
  // until the task notification names it.
  private onUser(line: Line): void {
    for (const block of contentBlocks(line)) {
      if (block.type !== 'tool_result') continue
      const call = this.byId.get(String(block.tool_use_id))
      if (!call || call.background) continue
      call.end = Date.parse(String(line.timestamp))
    }
  }

  private onAttachment(line: Line): void {
    const attachment = line.attachment as { type?: string; prompt?: unknown } | undefined
    if (attachment?.type !== 'queued_command' || typeof attachment.prompt !== 'string') return
    const toolUseId = attachment.prompt.match(NOTIFIED_TOOL_USE)?.[1]
    const call = toolUseId ? this.byId.get(toolUseId) : undefined
    if (!call) return
    call.end = Date.parse(String(line.timestamp))
  }
}

function parseLine(raw: string): Line | null {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as Line
  } catch {
    return null
  }
}

function contentBlocks(line: Line): Block[] {
  const message = line.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? (message.content as Block[]) : []
}
