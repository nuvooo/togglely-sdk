/**
 * @jest-environment node
 */
import { TogglelyClient, TogglelyConfig, ToggleValue } from '../index'

const encoder = new TextEncoder()

type Init = { headers: Record<string, string>; signal?: AbortSignal }
type Call = { url: string; headers: Record<string, string> }

interface FakeStream {
  response: Response
  send(text: string): void
  sendBytes(bytes: Uint8Array): void
  close(): void
  signal?: AbortSignal
}

function sseStream(signal?: AbortSignal): FakeStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  signal?.addEventListener('abort', () => {
    try {
      controller.error(new Error('aborted'))
    } catch {
      // already closed
    }
  })
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    sendBytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
    signal,
  }
}

const flag = (value: boolean): ToggleValue => ({
  value,
  enabled: true,
  flagType: 'BOOLEAN',
})

function flagsResponse(flags: Record<string, ToggleValue>, etag?: string) {
  return new Response(JSON.stringify(flags), {
    status: 200,
    headers: etag ? { ETag: etag } : {},
  })
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Lets promises, stream reads and setImmediate callbacks settle. */
async function flush() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms)
  await flush()
}

/** Advances time like a live server: heartbeat every 25 s on the stream. */
async function keepAlive(stream: () => FakeStream, ms: number) {
  for (let elapsed = 0; elapsed < ms; ) {
    const step = Math.min(25000, ms - elapsed)
    await advance(step)
    elapsed += step
    try {
      stream().send(': heartbeat\n\n')
    } catch {
      // stream closed
    }
    await flush()
  }
}

function harness() {
  const flagCalls: Call[] = []
  const streamCalls: Call[] = []
  const streams: FakeStream[] = []
  let flagsResponder: () => Response | Promise<Response> = () =>
    flagsResponse({ a: flag(true) }, 'W/"1-abc"')
  let streamResponder: (init: Init) => Response = (init) => {
    const stream = sseStream(init.signal)
    streams.push(stream)
    return stream.response
  }

  ;(global.fetch as jest.Mock).mockImplementation(
    async (url: string, init: Init) => {
      const call = { url, headers: { ...init.headers } }
      if (url.includes('/stream/')) {
        streamCalls.push(call)
        return streamResponder(init)
      }
      flagCalls.push(call)
      return flagsResponder()
    }
  )

  return {
    flagCalls,
    streamCalls,
    streams,
    lastStream: () => streams[streams.length - 1],
    onFlags(responder: () => Response | Promise<Response>) {
      flagsResponder = responder
    },
    onStream(responder: (init: Init) => Response) {
      streamResponder = responder
    },
  }
}

const baseConfig: TogglelyConfig = {
  apiKey: 'test-key',
  project: 'my-project',
  environment: 'production',
  baseUrl: 'https://flags.example.com',
  offlineFallback: false,
}

describe('TogglelyClient realtime', () => {
  let client: TogglelyClient | undefined
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    ;(global.fetch as jest.Mock).mockReset()
    jest.spyOn(Math, 'random').mockReturnValue(0)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    client?.destroy()
    client = undefined
    jest.useRealTimers()
    jest.restoreAllMocks()
    delete (global as any).document
  })

  async function start(config: Partial<TogglelyConfig> = {}) {
    client = new TogglelyClient({ ...baseConfig, ...config })
    await flush()
    return client
  }

  it('uses realtime as default and opens the stream after the initial fetch', async () => {
    const h = harness()
    const connected = jest.fn()
    client = new TogglelyClient(baseConfig)
    client.on('stream-connected', connected)
    await flush()

    expect(h.flagCalls).toHaveLength(1)
    expect(h.streamCalls).toHaveLength(1)
    expect(h.streamCalls[0].url).toBe(
      'https://flags.example.com/sdk/stream/my-project/production'
    )
    expect(h.streamCalls[0].headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer test-key',
      // version from the ETag: server sends a catch-up event if it moved on
      'Last-Event-ID': '1',
    })
    expect(h.streamCalls[0].url).not.toContain('apiKey')
    expect(connected).toHaveBeenCalledTimes(1)
  })

  it('honours a custom streamPath', async () => {
    const h = harness()
    await start({ streamPath: '/custom/stream' })
    expect(h.streamCalls[0].url).toBe(
      'https://flags.example.com/custom/stream/my-project/production'
    )
  })

  it('does not open a stream with refreshStrategy manual', async () => {
    const h = harness()
    await start({ refreshStrategy: 'manual' })
    await client!.refresh()
    await flush()
    expect(h.streamCalls).toHaveLength(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('starts the stream on the first refresh when autoFetch is false', async () => {
    const h = harness()
    await start({ autoFetch: false })
    expect(h.flagCalls).toHaveLength(0)
    expect(h.streamCalls).toHaveLength(0)

    await client!.refresh()
    await flush()
    expect(h.streamCalls).toHaveLength(1)
  })

  it('sends If-None-Match and treats 304 as unchanged without update event', async () => {
    const h = harness()
    const onUpdate = jest.fn()
    await start({ onChange: onUpdate })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const lastFetchBefore = client!.getState().lastFetch!

    h.onFlags(() => new Response(null, { status: 304 }))
    jest.advanceTimersByTime(1000)
    await client!.refresh()

    expect(h.flagCalls[1].headers['If-None-Match']).toBe('W/"1-abc"')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(client!.getAllToggles()).toEqual({ a: flag(true) })
    expect(client!.getState().lastFetch!.getTime()).toBeGreaterThan(
      lastFetchBefore.getTime()
    )
  })

  it('omits If-None-Match when the server sends no ETag', async () => {
    const h = harness()
    h.onFlags(() => flagsResponse({ a: flag(true) }))
    await start()
    await client!.refresh()
    expect(h.flagCalls[1].headers['If-None-Match']).toBeUndefined()
    expect(h.streamCalls[0].headers['Last-Event-ID']).toBeUndefined()
  })

  it('flags-changed triggers exactly one conditional fetch and an update', async () => {
    const h = harness()
    await start()
    const onUpdate = jest.fn()
    client!.on('update', onUpdate)

    h.onFlags(() => flagsResponse({ a: flag(false) }, 'W/"2-abc"'))
    h.lastStream().send('retry: 5000\n\nevent: ready\nid: 1\ndata: {"version":1}\n\n')
    await flush()
    expect(h.flagCalls).toHaveLength(1)

    h.lastStream().send(
      'event: flags-changed\nid: 2\ndata: {"version":2,"changes":[{"flagKey":"a","action":"toggled"}]}\n\n'
    )
    await flush()

    expect(h.flagCalls).toHaveLength(2)
    expect(h.flagCalls[1].headers['If-None-Match']).toBe('W/"1-abc"')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(client!.getAllToggles().a.value).toBe(false)
  })

  it('queues one follow-up fetch for changes during an in-flight refresh', async () => {
    const h = harness()
    await start()

    let release!: () => void
    h.onFlags(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(flagsResponse({ a: flag(false) }, 'W/"3-abc"'))
        })
    )
    const stream = h.lastStream()
    stream.send('event: flags-changed\nid: 2\ndata: {"version":2,"changes":[]}\n\n')
    await flush()
    stream.send('event: flags-changed\nid: 3\ndata: {"version":3,"changes":[]}\n\n')
    stream.send('event: flags-changed\nid: 4\ndata: {"version":4,"changes":[]}\n\n')
    await flush()
    expect(h.flagCalls).toHaveLength(2)

    release()
    await flush()
    expect(h.flagCalls).toHaveLength(3)
    release()
    await flush()
    expect(h.flagCalls).toHaveLength(3)
  })

  it('handles UTF-8 sequences split across stream chunks', async () => {
    const h = harness()
    await start()
    const bytes = encoder.encode(
      'event: flags-changed\nid: 5\ndata: {"version":5,"note":"Grüße 🚀"}\n\n'
    )
    for (let i = 0; i < bytes.length; i += 2) {
      h.lastStream().sendBytes(bytes.slice(i, i + 2))
    }
    await flush()
    expect(h.flagCalls).toHaveLength(2)
  })

  it('heartbeats keep the stream alive; silence triggers the watchdog', async () => {
    const h = harness()
    await start()
    const disconnected = jest.fn()
    client!.on('stream-disconnected', disconnected)

    for (let i = 0; i < 4; i++) {
      await advance(25000)
      h.lastStream().send(': heartbeat\n\n')
      await flush()
    }
    expect(h.streamCalls).toHaveLength(1)

    await advance(60000)
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(h.lastStream().signal?.aborted).toBe(true)
    // first reconnect after 1 s
    await advance(1000)
    expect(h.streamCalls).toHaveLength(2)
  })

  it('reconnects with exponential backoff and respects the server retry', async () => {
    const h = harness()
    await start()
    h.onStream(() => {
      throw new Error('network down')
    })

    // first stream ends (server closed)
    h.lastStream().close()
    await flush()
    expect(h.streamCalls).toHaveLength(1)
    await advance(999)
    expect(h.streamCalls).toHaveLength(1)
    await advance(1)
    expect(h.streamCalls).toHaveLength(2)
    await advance(1999)
    expect(h.streamCalls).toHaveLength(2)
    await advance(1)
    expect(h.streamCalls).toHaveLength(3)
    await advance(4000)
    expect(h.streamCalls).toHaveLength(4)
  })

  it('uses the server retry as minimum delay and resets after ready', async () => {
    const h = harness()
    await start()
    h.lastStream().send('retry: 5000\nevent: ready\nid: 1\ndata: {"version":1}\n\n')
    await flush()
    h.lastStream().close()
    await flush()

    await advance(4999)
    expect(h.streamCalls).toHaveLength(1)
    await advance(1)
    expect(h.streamCalls).toHaveLength(2)
    // resumes with the last event id
    expect(h.streamCalls[1].headers['Last-Event-ID']).toBe('1')
  })

  it('applies jitter and caps the backoff at 30 s', async () => {
    const h = harness()
    ;(Math.random as jest.Mock).mockReturnValue(0.5)
    await start()
    h.lastStream().close()
    await flush()
    // 1000 + 15 % jitter
    await advance(1149)
    expect(h.streamCalls).toHaveLength(1)
    await advance(1)
    expect(h.streamCalls).toHaveLength(2)
  })

  it('falls back to ETag polling after repeated failures and retries the stream after 5 min', async () => {
    const h = harness()
    await start()
    h.onStream(() => jsonResponse(500, { error: 'Internal error' }))
    h.lastStream().close()
    await flush()

    // reconnects after 1, 2, 4, 8 s; the 5th failure switches to polling
    await advance(1000 + 2000 + 4000 + 8000)
    expect(h.streamCalls).toHaveLength(5)
    // catch-up fetch when entering polling
    expect(h.flagCalls).toHaveLength(2)

    await advance(30000)
    expect(h.flagCalls).toHaveLength(3)
    expect(h.flagCalls[2].headers['If-None-Match']).toBe('W/"1-abc"')
    expect(h.streamCalls).toHaveLength(5)

    h.onStream((init) => {
      const stream = sseStream(init.signal)
      h.streams.push(stream)
      return stream.response
    })
    await advance(5 * 60000 - 30000)
    expect(h.streamCalls).toHaveLength(6)

    // stream is back: polling stops
    const flagsBefore = h.flagCalls.length
    await keepAlive(h.lastStream, 5 * 60000)
    expect(h.flagCalls).toHaveLength(flagsBefore)
    expect(h.streamCalls).toHaveLength(6)
  })

  it('429 STREAM_LIMIT switches to polling and retries the stream after 5 min', async () => {
    const h = harness()
    h.onStream(() =>
      jsonResponse(429, {
        code: 'STREAM_LIMIT',
        fallback: 'etag-polling',
        message: 'Stream limit reached',
      })
    )
    await start({ refreshIntervalMs: 10000 })
    expect(h.streamCalls).toHaveLength(1)

    await advance(10000)
    expect(h.flagCalls).toHaveLength(2)
    await advance(10000)
    expect(h.flagCalls).toHaveLength(3)

    await advance(5 * 60000 - 20000)
    expect(h.streamCalls).toHaveLength(2)
  })

  it('polling respects minRefreshIntervalMs', async () => {
    const h = harness()
    h.onStream(() => jsonResponse(429, { code: 'STREAM_LIMIT' }))
    await start({ refreshIntervalMs: 100, minRefreshIntervalMs: 5000 })
    await advance(4999)
    expect(h.flagCalls).toHaveLength(1)
    await advance(1)
    expect(h.flagCalls).toHaveLength(2)
  })

  it.each([404, 405])(
    '%i (server without stream) polls until restart without stream retries',
    async (status) => {
      const h = harness()
      h.onStream(() => jsonResponse(status, { error: 'Not found' }))
      await start()
      await advance(30000)
      expect(h.flagCalls).toHaveLength(2)
      await advance(60 * 60000)
      expect(h.streamCalls).toHaveLength(1)
    }
  )

  it.each([401, 403])(
    'stream %i emits one error and does not reconnect',
    async (status) => {
      const h = harness()
      h.onStream(() => jsonResponse(status, { error: 'Invalid API key' }))
      const onError = jest.fn()
      client = new TogglelyClient(baseConfig)
      client.on('error', onError)
      await flush()

      expect(onError).toHaveBeenCalledTimes(1)
      expect((client.getState().lastError as any).statusCode).toBe(status)
      await advance(60 * 60000)
      expect(h.streamCalls).toHaveLength(1)
      expect(h.flagCalls).toHaveLength(1)
    }
  )

  it('stops polling when a stream retry is rejected with 401', async () => {
    const h = harness()
    h.onStream(() => jsonResponse(429, { code: 'STREAM_LIMIT' }))
    await start()
    h.onStream(() => jsonResponse(401, { error: 'Invalid API key' }))
    await advance(5 * 60000)
    expect(h.streamCalls).toHaveLength(2)
    const flags = h.flagCalls.length
    await advance(60 * 60000)
    expect(h.flagCalls).toHaveLength(flags)
    expect(h.streamCalls).toHaveLength(2)
  })

  it('does not open a stream when the initial fetch is unauthorized', async () => {
    const h = harness()
    h.onFlags(() => jsonResponse(401, { error: 'Invalid API key' }))
    await start()
    await advance(60000)
    expect(h.streamCalls).toHaveLength(0)
  })

  it('opens the stream after a failed initial fetch (network) and recovers on ready', async () => {
    const h = harness()
    let fail = true
    h.onFlags(() => {
      if (fail) throw new TypeError('fetch failed')
      return flagsResponse({ a: flag(true) }, 'W/"1-abc"')
    })
    const onReady = jest.fn()
    client = new TogglelyClient(baseConfig)
    client.on('ready', onReady)
    await flush()
    expect(h.streamCalls).toHaveLength(1)

    fail = false
    h.lastStream().send('event: ready\nid: 1\ndata: {"version":1}\n\n')
    await flush()
    expect(h.flagCalls).toHaveLength(2)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('context change fetches immediately and keeps the stream', async () => {
    const h = harness()
    await start()
    client!.setContext({ userId: 'u1' })
    await flush()

    expect(h.flagCalls).toHaveLength(2)
    expect(decodeURIComponent(h.flagCalls[1].url)).toContain('"userId":"u1"')
    expect(h.streamCalls).toHaveLength(1)
    expect(h.lastStream().signal?.aborted).toBe(false)

    // unchanged context: no request
    client!.setContext({ userId: 'u1' })
    await flush()
    expect(h.flagCalls).toHaveLength(2)

    client!.clearContext()
    await flush()
    expect(h.flagCalls).toHaveLength(3)
  })

  it('context change during the initial fetch refetches with the new context', async () => {
    const h = harness()
    client = new TogglelyClient(baseConfig)
    client.setContext({ tenantId: 'acme' })
    await flush()
    expect(h.flagCalls).toHaveLength(2)
    expect(h.flagCalls[1].url).toContain('tenantId=acme')
  })

  it('destroy() aborts the stream and clears all timers', async () => {
    const h = harness()
    await start()
    const stream = h.lastStream()
    client!.destroy()

    expect(stream.signal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
    await advance(10 * 60000)
    expect(h.flagCalls).toHaveLength(1)
    expect(h.streamCalls).toHaveLength(1)
    await client!.refresh()
    expect(h.flagCalls).toHaveLength(1)
    expect(client!.getAllToggles()).toEqual({})
  })

  it('destroy() during the initial fetch prevents the stream', async () => {
    const h = harness()
    let release!: () => void
    h.onFlags(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(flagsResponse({ a: flag(true) }, 'W/"1-a"'))
        })
    )
    client = new TogglelyClient(baseConfig)
    await flush()
    client.destroy()
    release()
    await flush()
    expect(h.streamCalls).toHaveLength(0)
    expect(client.getAllToggles()).toEqual({})
    expect(jest.getTimerCount()).toBe(0)
  })

  describe('visibility (browser)', () => {
    function fakeDocument() {
      const listeners = new Set<() => void>()
      const doc = {
        visibilityState: 'visible',
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) =>
          listeners.delete(fn),
        set(state: 'visible' | 'hidden') {
          doc.visibilityState = state
          listeners.forEach((fn) => fn())
        },
        listeners,
      }
      ;(global as any).document = doc
      return doc
    }

    it('closes the stream after 5 min hidden and reconnects with a refresh when visible', async () => {
      const doc = fakeDocument()
      const h = harness()
      await start()
      const disconnected = jest.fn()
      client!.on('stream-disconnected', disconnected)

      doc.set('hidden')
      await keepAlive(h.lastStream, 5 * 60000 - 1)
      expect(disconnected).not.toHaveBeenCalled()
      await advance(1)
      expect(disconnected).toHaveBeenCalledTimes(1)
      expect(h.lastStream().signal?.aborted).toBe(true)

      await advance(30 * 60000)
      expect(h.streamCalls).toHaveLength(1)
      expect(h.flagCalls).toHaveLength(1)

      doc.set('visible')
      await flush()
      expect(h.streamCalls).toHaveLength(2)
      expect(h.flagCalls).toHaveLength(2)
      expect(h.flagCalls[1].headers['If-None-Match']).toBe('W/"1-abc"')
    })

    it('short hidden periods keep the stream open', async () => {
      const doc = fakeDocument()
      const h = harness()
      await start()
      doc.set('hidden')
      await keepAlive(h.lastStream, 4 * 60000)
      doc.set('visible')
      await keepAlive(h.lastStream, 10 * 60000)
      expect(h.streamCalls).toHaveLength(1)
      expect(h.flagCalls).toHaveLength(1)
      expect(h.lastStream().signal?.aborted).toBe(false)
    })

    it('pauseWhenHidden: false never pauses', async () => {
      const doc = fakeDocument()
      harness()
      await start({ pauseWhenHidden: false })
      expect(doc.listeners.size).toBe(0)
    })

    it('destroy() removes the visibility listener', async () => {
      const doc = fakeDocument()
      harness()
      await start()
      expect(doc.listeners.size).toBe(1)
      client!.destroy()
      expect(doc.listeners.size).toBe(0)
    })
  })

  it('a throwing update handler does not break the stream', async () => {
    const h = harness()
    await start()
    client!.on('update', () => {
      throw new Error('boom')
    })
    h.onFlags(() => flagsResponse({ a: flag(false) }, 'W/"2-abc"'))
    h.lastStream().send('event: flags-changed\nid: 2\ndata: {"version":2}\n\n')
    await flush()
    expect(client!.getAllToggles().a.value).toBe(false)
    expect(h.streamCalls).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalled()
  })
})
