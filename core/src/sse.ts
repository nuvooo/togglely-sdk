/**
 * Minimal incremental Server-Sent Events parser following the WHATWG
 * "event stream interpretation" rules (no dependencies, works in browsers
 * and Node >= 18).
 *
 * Feed it already decoded text in chunks of any size; lines may be split
 * across chunks. Supports CRLF / LF / CR line endings, multi-line `data`,
 * `event`, `id` (ignored when it contains NUL), `retry` and comments.
 * Unknown fields are ignored.
 */

export interface SseEvent {
  /** Event type (`event:` field), `message` when absent */
  type: string
  /** `data:` lines joined with `\n` */
  data: string
  /** Last event ID of the stream at dispatch time */
  id: string
}

/** Thrown when a line or event exceeds the size limit of the parser. */
export class SseLimitError extends Error {
  constructor() {
    super('SSE event too large')
    this.name = 'SseLimitError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Default maximum size (characters) of a pending line / event data */
export const SSE_MAX_SIZE = 1024 * 1024

export interface SseParserHandlers {
  onEvent: (event: SseEvent) => void
  /** Reconnection time requested by the server (`retry:` field) */
  onRetry?: (ms: number) => void
}

/**
 * @param initialId last event ID known from a previous connection (the
 *   WHATWG "last event ID buffer" survives reconnects)
 * @param maxSize maximum size of a pending line and of an event's data;
 *   exceeding it throws {@link SseLimitError}
 */
export function createSseParser(
  handlers: SseParserHandlers,
  initialId = '',
  maxSize = SSE_MAX_SIZE
): (chunk: string) => void {
  const LINE_END = /\r\n|\r|\n/g
  // Pieces of the current (unterminated) line: joined once it ends
  let pending: string[] = []
  let pendingLength = 0
  let data = ''
  let type = ''
  let id = initialId
  let started = false
  // The previous chunk ended with CR: a leading LF belongs to that line end
  let skipLF = false

  const processLine = (line: string) => {
    if (line === '') {
      if (data !== '') {
        handlers.onEvent({
          type: type || 'message',
          data: data.slice(0, -1),
          id,
        })
      }
      data = ''
      type = ''
      return
    }
    // Comment (e.g. heartbeat)
    if (line.charCodeAt(0) === 58) return

    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)

    if (field === 'event') type = value
    else if (field === 'data') {
      data += value + '\n'
      if (data.length > maxSize) throw new SseLimitError()
    } else if (field === 'id') {
      // An empty id resets the last event ID
      if (value.indexOf('\0') < 0) id = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) handlers.onRetry?.(parseInt(value, 10))
    }
  }

  return (chunk: string) => {
    if (!chunk) return
    if (!started) {
      started = true
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
    }
    if (skipLF) {
      skipLF = false
      if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1)
    }

    if (chunk.indexOf('\n') < 0 && chunk.indexOf('\r') < 0) {
      // No line end: no rescan of the pending line (linear time)
      pending.push(chunk)
      pendingLength += chunk.length
      if (pendingLength > maxSize) throw new SseLimitError()
      return
    }
    pending.push(chunk)
    const buffer = pending.join('')
    let pos = 0
    LINE_END.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = LINE_END.exec(buffer))) {
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        skipLF = true
      }
      const line = buffer.slice(pos, match.index)
      pos = LINE_END.lastIndex
      processLine(line)
    }
    const rest = buffer.slice(pos)
    pending = rest ? [rest] : []
    pendingLength = rest.length
    if (pendingLength > maxSize) throw new SseLimitError()
  }
}
