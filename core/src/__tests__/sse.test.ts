/**
 * @jest-environment node
 */
import { createSseParser, SseEvent, SseLimitError } from '../sse'

function collect() {
  const events: SseEvent[] = []
  const retries: number[] = []
  const push = createSseParser({
    onEvent: (event) => events.push(event),
    onRetry: (ms) => retries.push(ms),
  })
  return { events, retries, push }
}

describe('createSseParser', () => {
  it('parses event, id and data', () => {
    const { events, push } = collect()
    push('event: ready\nid: 7\ndata: {"version":7}\n\n')
    expect(events).toEqual([
      { type: 'ready', data: '{"version":7}', id: '7' },
    ])
  })

  it('joins multi-line data with \\n and defaults the type to message', () => {
    const { events, push } = collect()
    push('data: first\ndata: second\ndata\n\n')
    expect(events).toEqual([{ type: 'message', data: 'first\nsecond\n', id: '' }])
  })

  it('ignores comments (heartbeats) and unknown fields', () => {
    const { events, push } = collect()
    push(': heartbeat\n\nfoo: bar\nevent: x\ndata: 1\n\n')
    expect(events).toEqual([{ type: 'x', data: '1', id: '' }])
  })

  it('does not dispatch events without data and resets the type', () => {
    const { events, push } = collect()
    push('event: ready\n\ndata: a\n\n')
    expect(events).toEqual([{ type: 'message', data: 'a', id: '' }])
  })

  it('keeps the last event id across events and ignores ids with NUL', () => {
    const { events, push } = collect()
    push('id: 1\ndata: a\n\ndata: b\n\nid: 2\u00003\ndata: c\n\n')
    expect(events.map((event) => event.id)).toEqual(['1', '1', '1'])
  })

  it('reports numeric retry values only', () => {
    const { retries, push } = collect()
    push('retry: 5000\n\nretry: abc\n\nretry: 10s\n\n')
    expect(retries).toEqual([5000])
  })

  it('handles CRLF, CR and LF line endings', () => {
    const { events, push } = collect()
    push('data: a\r\n\r\ndata: b\r\rdata: c\n\n')
    expect(events.map((event) => event.data)).toEqual(['a', 'b', 'c'])
  })

  it('handles CRLF split across chunks', () => {
    const { events, push } = collect()
    push('data: a\r')
    push('\n\r')
    push('\ndata: b\r\n\r\n')
    expect(events.map((event) => event.data)).toEqual(['a', 'b'])
  })

  it('handles chunk boundaries in the middle of lines and fields', () => {
    const { events, push } = collect()
    const raw = 'event: flags-changed\nid: 42\ndata: {"version":42,"changes":[]}\n\n'
    for (const char of raw) push(char)
    expect(events).toEqual([
      {
        type: 'flags-changed',
        data: '{"version":42,"changes":[]}',
        id: '42',
      },
    ])
  })

  it('decodes UTF-8 split across byte chunks with a streaming TextDecoder', () => {
    const { events, push } = collect()
    const bytes = new TextEncoder().encode('data: Grüße 🚀\n\n')
    const decoder = new TextDecoder('utf-8')
    // split inside the multi-byte sequences
    for (let i = 0; i < bytes.length; i += 3) {
      push(decoder.decode(bytes.subarray(i, i + 3), { stream: true }))
    }
    push(decoder.decode())
    expect(events).toEqual([{ type: 'message', data: 'Grüße 🚀', id: '' }])
  })

  it('strips a leading BOM and only one space after the colon', () => {
    const { events, push } = collect()
    push('﻿data:  two spaces\n\n')
    expect(events[0].data).toBe(' two spaces')
  })

  it('resets the last event id on an empty id field', () => {
    const { events, push } = collect()
    push('id: 5\ndata: a\n\nid\ndata: b\n\nid: 6\ndata: c\n\nid:\ndata: d\n\n')
    expect(events.map((event) => event.id)).toEqual(['5', '', '6', ''])
  })

  it('starts with the last event id of a previous connection', () => {
    const events: SseEvent[] = []
    const push = createSseParser(
      { onEvent: (event) => events.push(event) },
      '41'
    )
    push('data: a\n\nid: \ndata: b\n\n')
    expect(events.map((event) => event.id)).toEqual(['41', ''])
  })

  it('throws SseLimitError for oversized lines and events', () => {
    const line = createSseParser({ onEvent: () => {} }, '', 10)
    line('data: 12')
    expect(() => line('345')).toThrow(SseLimitError)

    const event = createSseParser({ onEvent: () => {} }, '', 10)
    event('data: 12345\n')
    expect(() => event('data: 67890\n')).toThrow(SseLimitError)
  })

  it('scans long lines split into many chunks in linear time', () => {
    const { events, push } = collect()
    const started = Date.now()
    push('data: ')
    for (let i = 0; i < 20000; i++) push('x'.repeat(40))
    push('\n\n')
    expect(events[0].data.length).toBe(20000 * 40)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('does not dispatch an incomplete trailing event', () => {
    const { events, push } = collect()
    push('data: partial\n')
    expect(events).toHaveLength(0)
  })
})
