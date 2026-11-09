/**
 * Togglely Core SDK - Framework agnostic feature flag management
 *
 * Professionalized refresh model:
 * - Cached reads are side-effect free by default
 * - Network refresh is explicit and configurable
 * - Optional interval refresh strategy
 * - Optional stale-while-revalidate with cooldown
 * - update events only emit on actual toggle changes
 * - Realtime (default): Server-Sent Events trigger conditional (ETag)
 *   refreshes; falls back to ETag polling when streaming is unavailable
 */

import { createSseParser, SseEvent, SseLimitError } from './sse'

// --- Typed Error Classes ---

export class TogglelyError extends Error {
  public readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'TogglelyError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class TogglelyNetworkError extends TogglelyError {
  public readonly statusCode: number | undefined
  public readonly response: Response | undefined

  constructor(
    message: string,
    statusCode?: number,
    response?: Response
  ) {
    super(message, 'NETWORK_ERROR')
    this.name = 'TogglelyNetworkError'
    this.statusCode = statusCode
    this.response = response
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class TogglelyConfigError extends TogglelyError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR')
    this.name = 'TogglelyConfigError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class TogglelyTimeoutError extends TogglelyError {
  constructor(message: string = 'Request timeout') {
    super(message, 'TIMEOUT_ERROR')
    this.name = 'TogglelyTimeoutError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// --- Interfaces ---

export interface TogglelyConfig {
  apiKey: string
  project: string
  environment: string
  baseUrl: string
  timeout?: number
  offlineFallback?: boolean
  offlineJsonPath?: string
  offlineToggles?: Record<string, ToggleValue>
  envPrefix?: string
  autoFetch?: boolean
  brandKey?: string
  tenantId?: string
  context?: ToggleContext
  /**
   * - 'realtime' (default): live stream, refetch only on changes,
   *   ETag polling as fallback
   * - 'manual': fetch only on refresh() (behaviour before 1.3.0)
   * - 'interval': refresh every refreshIntervalMs
   * - 'stale-while-revalidate': background refresh on cached reads
   */
  refreshStrategy?: RefreshStrategy
  /** Polling interval (interval strategy and realtime fallback), default 30000 */
  refreshIntervalMs?: number
  minRefreshIntervalMs?: number
  /** Path of the change stream endpoint (default '/sdk/stream') */
  streamPath?: string
  /**
   * Browser: close the stream after the page was hidden for 5 minutes and
   * reconnect (with a conditional refresh) once it is visible (default true)
   */
  pauseWhenHidden?: boolean
  /** Shortcut for on('update', handler) */
  onChange?: TogglelyEventHandler
}

export type RefreshStrategy =
  | 'realtime'
  | 'manual'
  | 'interval'
  | 'stale-while-revalidate'

export interface ToggleContext {
  userId?: string
  email?: string
  country?: string
  region?: string
  [key: string]: any
}

export interface ToggleValue {
  value: any
  enabled: boolean
  flagType?: 'BOOLEAN' | 'STRING' | 'NUMBER' | 'JSON'
}

export interface AllTogglesResponse {
  [key: string]: ToggleValue
}

export interface TogglelyState {
  isReady: boolean
  isOffline: boolean
  lastError: Error | null
  lastFetch: Date | null
}

export type TogglelyEventType =
  | 'ready'
  | 'update'
  | 'error'
  | 'offline'
  | 'online'
  | 'stream-connected'
  | 'stream-disconnected'
export type TogglelyEventHandler = (state: TogglelyState) => void

type Timer = ReturnType<typeof setTimeout>

const EVENT_TYPES: TogglelyEventType[] = [
  'ready',
  'update',
  'error',
  'offline',
  'online',
  'stream-connected',
  'stream-disconnected',
]

/** Reconnect backoff bounds for the change stream */
const STREAM_BACKOFF_MIN_MS = 1000
const STREAM_BACKOFF_MAX_MS = 30000
/** No bytes (events or heartbeats) for this long: reconnect */
const STREAM_WATCHDOG_MS = 60000
/** Consecutive stream failures before falling back to polling */
const STREAM_MAX_FAILURES = 5
/** Polling fallback: try the stream again after this delay */
const STREAM_RETRY_MS = 5 * 60000
/** Hidden browser tab: close the stream after this delay */
const HIDDEN_PAUSE_MS = 5 * 60000
/** Stream request: response headers must arrive within this time */
const STREAM_CONNECT_TIMEOUT_MS = 15000

/** fetch + ReadableStream + TextDecoder are available (not React Native) */
function canStream(): boolean {
  return (
    typeof fetch === 'function' &&
    typeof TextDecoder !== 'undefined' &&
    typeof ReadableStream !== 'undefined' &&
    typeof AbortController !== 'undefined' &&
    !(typeof navigator !== 'undefined' && navigator?.product === 'ReactNative')
  )
}

/**
 * Default refresh strategy for the current platform: 'realtime' in browsers
 * with streaming fetch, 'manual' everywhere else (Node, SSR, React Native,
 * workers). Explicit `refreshStrategy` options always win.
 */
export function detectDefaultRefreshStrategy(): RefreshStrategy {
  return typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    canStream()
    ? 'realtime'
    : 'manual'
}

/** Seconds of a Retry-After header in ms (HTTP-date is not supported) */
function retryAfterMs(response: Response): number {
  const value = Number(response.headers?.get?.('Retry-After'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0
}

const noop = () => {}

/** setTimeout that does not keep a Node process alive */
function later(fn: () => void, ms: number): Timer {
  const timer = setTimeout(fn, ms)
  ;(timer as any)?.unref?.()
  return timer
}

/** Version part of an SDK ETag (W/"<version>-<hash>"), if present */
function versionFromEtag(etag: string | null): string {
  const match = etag ? /^(?:W\/)?"(\d+)-/.exec(etag) : null
  return match ? match[1] : ''
}

/** JSON with sorted object keys at every level (order-independent compare) */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

export class TogglelyClient {
  private config: TogglelyConfig & {
    timeout: number
    offlineFallback: boolean
    envPrefix: string
    autoFetch: boolean
    offlineJsonPath: string | undefined
    refreshStrategy: RefreshStrategy
    refreshIntervalMs: number
    minRefreshIntervalMs: number
    streamPath: string
    pauseWhenHidden: boolean
  }

  private toggles: Map<string, ToggleValue> = new Map()
  private context: ToggleContext = {}
  private state: TogglelyState = {
    isReady: false,
    isOffline: false,
    lastError: null,
    lastFetch: null,
  }
  private eventHandlers: Map<TogglelyEventType, Set<TogglelyEventHandler>> =
    new Map()
  private offlineTogglesLoaded = false

  private pendingKeys: Set<string> = new Set()
  private pendingPromises: Map<
    string,
    Array<{
      resolve: (value: ToggleValue | null) => void
      reject: (error: any) => void
    }>
  > = new Map()
  private batchTimeout: Timer | null = null
  private refreshTimeout: Timer | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private inFlightRefresh: Promise<void> | null = null
  private refreshQueued = false
  private lastRefreshTime = 0
  private readonly BATCH_DELAY = 10

  private destroyed = false
  /** ETag of the response the cached toggles came from */
  private etag: string | null = null
  private requests: Set<AbortController> = new Set()
  /** Server data has been applied: late offline data must not override it */
  private serverDataApplied = false

  // Realtime (change stream + polling fallback)
  private realtimeStarted = false
  private stream: AbortController | null = null
  /** Incremented whenever the current stream is replaced or closed */
  private streamGen = 0
  private streamConnected = false
  private streamFailures = 0
  private serverRetryMs = 0
  /** 404/405 or no streaming support: poll until restart */
  private streamUnsupported = false
  private lastEventId = ''
  private reconnectTimer: Timer | null = null
  private watchdogTimer: Timer | null = null
  private streamRetryTimer: Timer | null = null
  private pollHandle: ReturnType<typeof setInterval> | null = null
  private hiddenTimer: Timer | null = null
  private paused = false
  private visibilityHandler: (() => void) | null = null

  constructor(config: TogglelyConfig) {
    if (!config.apiKey) {
      throw new TogglelyConfigError('apiKey is required')
    }
    if (!config.project) {
      throw new TogglelyConfigError('project is required')
    }
    if (!config.environment) {
      throw new TogglelyConfigError('environment is required')
    }
    if (!config.baseUrl) {
      throw new TogglelyConfigError('baseUrl is required')
    }

    this.config = {
      timeout: 5000,
      offlineFallback: true,
      envPrefix: 'TOGGLELY_',
      autoFetch: true,
      offlineJsonPath: undefined,
      refreshStrategy: detectDefaultRefreshStrategy(),
      refreshIntervalMs: 30000,
      minRefreshIntervalMs: 5000,
      streamPath: '/sdk/stream',
      pauseWhenHidden: true,
      ...config,
    }

    for (const event of EVENT_TYPES) this.eventHandlers.set(event, new Set())
    if (config.onChange) this.on('update', config.onChange)

    const initialContext: ToggleContext = { ...config.context }
    if (config.brandKey) initialContext.brandKey = config.brandKey
    if (config.tenantId) initialContext.tenantId = config.tenantId
    this.context = initialContext

    if (this.config.offlineFallback) {
      this.loadOfflineToggles()
    }

    if (this.config.autoFetch) {
      this.refresh().catch(noop)
    }

    this.setupRefreshStrategy()
  }

  on(event: TogglelyEventType, handler: TogglelyEventHandler): () => void {
    const handlers = this.eventHandlers.get(event)
    if (handlers) {
      handlers.add(handler)
    }
    return () => this.off(event, handler)
  }

  off(event: TogglelyEventType, handler: TogglelyEventHandler): void {
    const handlers = this.eventHandlers.get(event)
    if (handlers) {
      handlers.delete(handler)
    }
  }

  private emit(event: TogglelyEventType): void {
    const handlers = this.eventHandlers.get(event)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler({ ...this.state })
        } catch (error) {
          console.error(`[Togglely] ${event} handler failed:`, error)
        }
      })
    }
  }

  setContext(context: ToggleContext): void {
    const next = { ...this.context, ...context }
    const keys = Object.keys(next)
    const changed =
      keys.length !== Object.keys(this.context).length ||
      keys.some((key) => next[key] !== this.context[key])
    this.context = next
    if (changed) this.onContextChanged()
  }

  getContext(): ToggleContext {
    return { ...this.context }
  }

  clearContext(): void {
    const changed = Object.keys(this.context).length > 0
    this.context = {}
    if (changed) this.onContextChanged()
  }

  /** Realtime: values depend on the context, fetch them right away */
  private onContextChanged(): void {
    if (
      this.config.refreshStrategy === 'realtime' &&
      (this.realtimeStarted || this.inFlightRefresh)
    ) {
      this.queueRefresh()
    }
  }

  getState(): TogglelyState {
    return { ...this.state }
  }

  isReady(): boolean {
    return this.state.isReady
  }

  isOffline(): boolean {
    return this.state.isOffline
  }

  async isEnabled(
    key: string,
    defaultValue: boolean = false
  ): Promise<boolean> {
    const value = await this.getValue(key)
    if (value === null) return defaultValue
    if (typeof value.value === 'boolean') {
      return value.enabled && value.value
    }
    return value.enabled
  }

  async getString(key: string, defaultValue: string = ''): Promise<string> {
    const value = await this.getValue(key)
    if (value === null || !value.enabled) return defaultValue
    return String(value.value)
  }

  async getNumber(key: string, defaultValue: number = 0): Promise<number> {
    const value = await this.getValue(key)
    if (value === null || !value.enabled) return defaultValue
    return Number(value.value)
  }

  async getJSON<T = any>(key: string, defaultValue: T = {} as T): Promise<T> {
    const value = await this.getValue(key)
    if (value === null || !value.enabled) return defaultValue
    if (typeof value.value === 'string') {
      try {
        return JSON.parse(value.value) as T
      } catch {
        return defaultValue
      }
    }
    return value.value as T
  }

  async getValue(key: string): Promise<ToggleValue | null> {
    const cachedValue = this.toggles.get(key)
    if (cachedValue !== undefined) {
      if (this.config.refreshStrategy === 'stale-while-revalidate') {
        this.scheduleBackgroundRefresh()
      }
      return cachedValue
    }

    if (this.destroyed) {
      return null
    }

    const existingPromise = this.pendingPromises.get(key)
    if (existingPromise) {
      return new Promise((resolve, reject) => {
        existingPromise.push({ resolve, reject })
      })
    }

    this.pendingKeys.add(key)

    return new Promise((resolve, reject) => {
      const promises = this.pendingPromises.get(key) || []
      promises.push({ resolve, reject })
      this.pendingPromises.set(key, promises)
      this.scheduleBatchExecution()
    })
  }

  private setupRefreshStrategy(): void {
    if (this.config.refreshStrategy !== 'interval') {
      return
    }

    this.intervalHandle = setInterval(() => {
      this.refresh().catch(noop)
    }, this.config.refreshIntervalMs)
    ;(this.intervalHandle as any)?.unref?.()
  }

  private shouldRefreshNow(): boolean {
    return Date.now() - this.lastRefreshTime >= this.config.minRefreshIntervalMs
  }

  private scheduleBackgroundRefresh(): void {
    if (this.refreshTimeout || !this.shouldRefreshNow()) {
      return
    }

    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null
      this.refresh().catch(noop)
    }, this.BATCH_DELAY)
  }

  private scheduleBatchExecution(): void {
    if (this.batchTimeout) {
      return
    }

    this.batchTimeout = setTimeout(() => {
      this.executeBatch()
    }, this.BATCH_DELAY)
  }

  private async executeBatch(): Promise<void> {
    this.batchTimeout = null

    const keys = Array.from(this.pendingKeys)
    const promises = new Map(this.pendingPromises)

    this.pendingKeys.clear()
    this.pendingPromises.clear()

    if (keys.length === 0) {
      return
    }

    try {
      await this.refresh()

      for (const key of keys) {
        const keyPromises = promises.get(key) || []
        const value = this.toggles.get(key) || null
        for (const { resolve } of keyPromises) {
          resolve(value)
        }
      }
    } catch (error) {
      for (const key of keys) {
        const keyPromises = promises.get(key) || []
        for (const { resolve, reject } of keyPromises) {
          // destroy() during the request: settle like a missing flag
          if (this.destroyed) resolve(null)
          else reject(error)
        }
      }
    }
  }

  getAllToggles(): Record<string, ToggleValue> {
    const result: Record<string, ToggleValue> = {}
    this.toggles.forEach((value, key) => {
      result[key] = value
    })
    return result
  }

  private loadOfflineToggles(): void {
    try {
      if (
        this.config.offlineToggles &&
        Object.keys(this.config.offlineToggles).length > 0
      ) {
        for (const [key, value] of Object.entries(this.config.offlineToggles)) {
          this.toggles.set(key, value)
        }
        this.offlineTogglesLoaded = true
        console.log('[Togglely] Loaded offline toggles from config')
        return
      }

      if (this.config.offlineJsonPath && typeof window !== 'undefined') {
        this.loadOfflineJsonFile(this.config.offlineJsonPath)
      }

      if (typeof window !== 'undefined' && (window as any).__TOGGLELY_TOGGLES) {
        const offlineToggles = (window as any).__TOGGLELY_TOGGLES
        for (const [key, value] of Object.entries(offlineToggles)) {
          this.toggles.set(key, this.parseOfflineValue(value))
        }
        this.offlineTogglesLoaded = true
        console.log(
          '[Togglely] Loaded offline toggles from window.__TOGGLELY_TOGGLES'
        )
        return
      }

      if (typeof process !== 'undefined' && process.env) {
        const prefix = this.config.envPrefix
        for (const [envKey, envValue] of Object.entries(process.env)) {
          if (envKey?.startsWith(prefix) && envValue !== undefined) {
            const toggleKey = envKey
              .slice(prefix.length)
              .toLowerCase()
              .replace(/_/g, '-')
            this.toggles.set(toggleKey, this.parseOfflineValue(envValue))
          }
        }
        this.offlineTogglesLoaded = true
        console.log(
          '[Togglely] Loaded offline toggles from environment variables'
        )
      }
    } catch (error) {
      console.warn('[Togglely] Failed to load offline toggles:', error)
    }
  }

  private async loadOfflineJsonFile(path: string): Promise<void> {
    try {
      if (typeof window !== 'undefined') {
        const response = await fetch(path)
        if (response.ok) {
          const data = await response.json()
          if (this.serverDataApplied || this.destroyed) return
          for (const [key, value] of Object.entries(data)) {
            this.toggles.set(key, this.parseOfflineValue(value))
          }
          this.offlineTogglesLoaded = true
          console.log('[Togglely] Loaded offline toggles from JSON file:', path)
        }
      } else if (typeof require !== 'undefined') {
        const fs = require('fs')
        const pathModule = require('path')
        const fullPath = pathModule.resolve(path)
        if (fs.existsSync(fullPath)) {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
          for (const [key, value] of Object.entries(data)) {
            this.toggles.set(key, this.parseOfflineValue(value))
          }
          this.offlineTogglesLoaded = true
          console.log(
            '[Togglely] Loaded offline toggles from JSON file:',
            fullPath
          )
        }
      }
    } catch (error) {
      console.warn('[Togglely] Failed to load offline JSON file:', error)
    }
  }

  private parseOfflineValue(value: any): ToggleValue {
    if (typeof value === 'string') {
      const lower = value.toLowerCase()
      if (lower === 'true') return { value: true, enabled: true }
      if (lower === 'false') return { value: false, enabled: true }
      if (!isNaN(Number(value))) {
        return { value: Number(value), enabled: true }
      }
      try {
        const parsed = JSON.parse(value)
        return { value: parsed, enabled: true }
      } catch {
        return { value, enabled: true }
      }
    }
    return { value, enabled: true }
  }

  /**
   * Fetches all flags (conditional request with the last ETag). Concurrent
   * calls share one request. Resolves without network access after destroy().
   */
  async refresh(): Promise<void> {
    if (this.destroyed) {
      return
    }
    if (this.inFlightRefresh) {
      return this.inFlightRefresh
    }

    this.inFlightRefresh = this.performRefresh().finally(() => {
      this.inFlightRefresh = null
      if (this.refreshQueued) {
        this.refreshQueued = false
        this.queueRefresh()
      }
    })

    return this.inFlightRefresh
  }

  /**
   * Refresh without overlapping: a change signalled while a request is in
   * flight may not be contained in its response, so one more request
   * follows it.
   */
  private queueRefresh(): void {
    if (this.destroyed) return
    if (this.inFlightRefresh) {
      this.refreshQueued = true
      return
    }
    this.refresh().catch(noop)
  }

  private async performRefresh(): Promise<void> {
    try {
      await this.fetchToggles()
    } catch (error) {
      // Invalid key / origin: the stream would fail the same way
      const status = (error as TogglelyNetworkError).statusCode
      if (!this.destroyed && status !== 401 && status !== 403) {
        this.startRealtimeSafely()
      }
      throw error
    }
    this.startRealtimeSafely()
  }

  private async fetchToggles(): Promise<void> {
    try {
      const params = new URLSearchParams()
      if (this.context.brandKey)
        params.set('brandKey', String(this.context.brandKey))
      if (this.context.tenantId)
        params.set('tenantId', String(this.context.tenantId))
      if (Object.keys(this.context).length > 0) {
        params.set('context', JSON.stringify(this.context))
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`
      }
      if (this.etag) {
        headers['If-None-Match'] = this.etag
      }

      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/sdk/flags/${encodeURIComponent(this.config.project)}/${encodeURIComponent(this.config.environment)}?${params.toString()}`,
        { headers }
      )
      if (this.destroyed) return

      let changed = false
      if (response.status === 304) {
        // Not modified: cached toggles stay valid
      } else if (!response.ok) {
        throw new TogglelyNetworkError(
          `HTTP ${response.status}`,
          response.status,
          response
        )
      } else {
        const data: AllTogglesResponse = await response.json()
        if (this.destroyed) return
        changed = this.replaceTogglesIfChanged(data)
        this.etag = response.headers?.get?.('ETag') || null
      }
      this.serverDataApplied = true

      this.state.lastFetch = new Date()
      this.state.lastError = null
      this.lastRefreshTime = Date.now()

      if (!this.state.isReady) {
        this.state.isReady = true
        this.emit('ready')
      }

      if (this.state.isOffline) {
        this.state.isOffline = false
        this.emit('online')
      }

      if (changed) {
        this.emit('update')
      }
    } catch (error) {
      if (this.destroyed) throw error
      this.state.lastError = error as Error

      if (
        this.config.offlineFallback &&
        this.offlineTogglesLoaded &&
        !this.state.isOffline
      ) {
        this.state.isOffline = true
        this.emit('offline')
      }

      this.emit('error')
      console.error('[Togglely] Failed to refresh toggles:', error)
      throw error
    }
  }

  private replaceTogglesIfChanged(next: AllTogglesResponse): boolean {
    if (stableStringify(this.getAllToggles()) === stableStringify(next)) {
      return false
    }

    this.toggles.clear()
    for (const [key, value] of Object.entries(next)) {
      this.toggles.set(key, value)
    }
    return true
  }

  // ==================== Realtime ====================

  /** Errors while starting the stream never fail a refresh. */
  private startRealtimeSafely(): void {
    try {
      this.startRealtime()
    } catch (error) {
      this.state.lastError = error as Error
      this.emit('error')
      console.error('[Togglely] Failed to start realtime updates:', error)
    }
  }

  /** Starts the change stream once (realtime strategy only). */
  private startRealtime(): void {
    if (
      this.realtimeStarted ||
      this.destroyed ||
      this.config.refreshStrategy !== 'realtime'
    ) {
      return
    }
    this.realtimeStarted = true
    this.watchVisibility()
    if (this.paused) return
    // No streaming fetch (React Native, old browsers): poll directly
    if (!canStream()) this.streamUnsupported = true
    if (this.streamUnsupported) this.startPolling(false)
    else this.connectStream()
  }

  private connectStream(): void {
    this.closeStream()
    if (this.destroyed || this.paused) return

    const controller = new AbortController()
    const gen = this.streamGen
    this.stream = controller

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.config.apiKey}`,
    }
    // Known version: the server sends a catch-up event if it differs
    const lastId = this.lastEventId || versionFromEtag(this.etag)
    if (lastId) headers['Last-Event-ID'] = lastId

    // Response headers must arrive in time (XHR-based fetch polyfills
    // may never settle)
    this.armWatchdog(gen, STREAM_CONNECT_TIMEOUT_MS)
    fetch(
      `${this.config.baseUrl}${this.config.streamPath}/${encodeURIComponent(this.config.project)}/${encodeURIComponent(this.config.environment)}`,
      { headers, signal: controller.signal }
    )
      .then((response) => this.readStream(response, gen))
      .catch((error) => {
        if (error instanceof SseLimitError && gen === this.streamGen) {
          // Oversized event: give up on the stream for a while
          this.startPolling(true)
          this.queueRefresh()
        } else {
          this.onStreamFailure(gen)
        }
      })
  }

  private async readStream(response: Response, gen: number): Promise<void> {
    if (gen !== this.streamGen) return
    const status = response.status

    if (status === 401 || status === 403) {
      // Invalid key / origin: report once, no reconnect or polling loop
      this.closeStream()
      this.stopPolling()
      this.state.lastError = new TogglelyNetworkError(
        `Stream HTTP ${status}`,
        status,
        response
      )
      this.emit('error')
      return
    }
    if (status === 404 || status === 405) {
      // Server without change stream: poll until restart
      this.streamUnsupported = true
      this.startPolling(false)
      return
    }
    if (status === 429) {
      const retryAfter = retryAfterMs(response)
      let code: unknown
      try {
        code = (await response.json())?.code
      } catch {
        // no JSON body
      }
      if (gen !== this.streamGen) return
      if (code === 'STREAM_LIMIT') {
        // Stream limit reached (fallback: 'etag-polling')
        this.startPolling(
          true,
          retryAfter ? Math.min(retryAfter, STREAM_RETRY_MS) : STREAM_RETRY_MS
        )
      } else {
        // General rate limit: reconnect later, not before Retry-After
        this.onStreamFailure(gen, retryAfter)
      }
      return
    }

    const body = response.body as ReadableStream<Uint8Array> | null
    if (response.ok && (!body || typeof body.getReader !== 'function')) {
      // fetch without streaming support (e.g. some React Native versions)
      this.streamUnsupported = true
      this.startPolling(false)
      return
    }
    const contentType = response.headers?.get?.('Content-Type') || ''
    if (!response.ok || !body || contentType.indexOf('text/event-stream') < 0) {
      throw new TogglelyNetworkError(`Stream HTTP ${status}`, status)
    }

    this.stopPolling()
    this.streamConnected = true
    this.emit('stream-connected')

    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parse = createSseParser(
      {
        onEvent: (event) => this.onStreamEvent(event),
        onRetry: (ms) => {
          this.serverRetryMs = ms
        },
      },
      this.lastEventId
    )

    this.armWatchdog(gen)
    for (;;) {
      const { done, value } = await reader.read()
      if (gen !== this.streamGen) {
        reader.cancel().catch(noop)
        return
      }
      if (done) break
      this.armWatchdog(gen)
      parse(decoder.decode(value, { stream: true }))
      if (gen !== this.streamGen) {
        reader.cancel().catch(noop)
        return
      }
    }
    parse(decoder.decode())
    throw new Error('Stream closed')
  }

  private onStreamEvent(event: SseEvent): void {
    // An empty id field resets the last event ID (WHATWG)
    this.lastEventId = event.id
    if (event.type === 'ready') {
      this.streamFailures = 0
      // Recover after an outage even when no flag changed meanwhile
      if (this.state.isOffline || this.state.lastError) this.queueRefresh()
    } else if (event.type === 'flags-changed') {
      this.queueRefresh()
    }
  }

  private onStreamFailure(gen: number, minDelayMs = 0): void {
    if (gen !== this.streamGen || this.destroyed) return
    this.closeStream()
    this.streamFailures++
    if (this.streamFailures >= STREAM_MAX_FAILURES) {
      this.startPolling(true)
      // Changes may have been missed while reconnecting
      this.queueRefresh()
      return
    }
    this.reconnectTimer = later(() => {
      this.reconnectTimer = null
      this.connectStream()
    }, Math.max(minDelayMs, this.reconnectDelay()))
  }

  /** Exponential backoff (1 s ... 30 s, at least the server's retry) + jitter */
  private reconnectDelay(): number {
    const exponential =
      STREAM_BACKOFF_MIN_MS * 2 ** Math.max(0, this.streamFailures - 1)
    const base = Math.min(
      STREAM_BACKOFF_MAX_MS,
      Math.max(exponential, this.serverRetryMs)
    )
    return base + Math.floor(Math.random() * base * 0.3)
  }

  private armWatchdog(gen: number, ms = STREAM_WATCHDOG_MS): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer)
    this.watchdogTimer = later(() => {
      this.watchdogTimer = null
      this.onStreamFailure(gen)
    }, ms)
  }

  /** Aborts the current stream (if any) and its timers. */
  private closeStream(): void {
    this.streamGen++
    if (this.stream) {
      this.stream.abort()
      this.stream = null
    }
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.watchdogTimer = null
    this.reconnectTimer = null
    if (this.streamConnected) {
      this.streamConnected = false
      this.emit('stream-disconnected')
    }
  }

  /** ETag polling; optionally retries the stream (default after 5 min). */
  private startPolling(
    retryStream: boolean,
    retryAfterMs = STREAM_RETRY_MS
  ): void {
    this.closeStream()
    if (!this.pollHandle) {
      this.pollHandle = setInterval(
        () => this.refresh().catch(noop),
        Math.max(this.config.refreshIntervalMs, this.config.minRefreshIntervalMs)
      )
      ;(this.pollHandle as any)?.unref?.()
    }
    if (retryStream && !this.streamRetryTimer) {
      this.streamRetryTimer = later(() => {
        this.streamRetryTimer = null
        this.streamFailures = 0
        this.connectStream()
      }, retryAfterMs)
    }
  }

  private stopPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle)
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer)
    this.pollHandle = null
    this.streamRetryTimer = null
  }

  /** Browser: pause the stream while the page is hidden for long. */
  private watchVisibility(): void {
    if (
      this.visibilityHandler ||
      !this.config.pauseWhenHidden ||
      typeof document === 'undefined' ||
      typeof document.addEventListener !== 'function'
    ) {
      return
    }
    this.visibilityHandler = () => {
      if (this.destroyed) return
      if (document.visibilityState === 'hidden') {
        if (!this.hiddenTimer && !this.paused) {
          this.hiddenTimer = later(() => {
            this.hiddenTimer = null
            this.paused = true
            this.stopPolling()
            this.closeStream()
          }, HIDDEN_PAUSE_MS)
        }
        return
      }
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
      this.hiddenTimer = null
      if (this.paused) {
        this.paused = false
        this.streamFailures = 0
        this.queueRefresh()
        if (this.streamUnsupported) this.startPolling(false)
        else this.connectStream()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
    this.visibilityHandler()
  }

  forceOfflineMode(): void {
    this.state.isOffline = true
    this.emit('offline')
  }

  forceOnlineMode(): void {
    this.state.isOffline = false
    this.refresh().catch(noop)
    this.emit('online')
  }

  /**
   * Stops everything: closes the change stream, aborts pending requests,
   * clears timers, listeners and cached toggles. The client cannot be
   * restarted afterwards; create a new one instead.
   */
  destroy(): void {
    this.destroyed = true
    this.eventHandlers.forEach((handlers) => handlers.clear())
    this.closeStream()
    this.stopPolling()
    this.requests.forEach((controller) => controller.abort())
    this.requests.clear()
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
    }
    this.visibilityHandler = null
    this.toggles.clear()
    this.etag = null
    this.refreshQueued = false
    if (this.batchTimeout) clearTimeout(this.batchTimeout)
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout)
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
    this.batchTimeout = null
    this.refreshTimeout = null
    this.intervalHandle = null
    this.hiddenTimer = null
    // Settle reads waiting for the next batch (like a missing flag)
    this.pendingPromises.forEach((waiting) =>
      waiting.forEach(({ resolve }) => resolve(null))
    )
    this.pendingPromises.clear()
    this.pendingKeys.clear()
  }

  private fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) {
      this.requests.add(controller)
      options = { ...options, signal: controller.signal }
    }
    return new Promise<Response>((resolve, reject) => {
      const timeoutId = later(() => {
        reject(new TogglelyTimeoutError())
        controller?.abort()
      }, this.config.timeout)

      fetch(url, options)
        .then((response) => {
          clearTimeout(timeoutId)
          resolve(response)
        })
        .catch((error) => {
          clearTimeout(timeoutId)
          if (error instanceof TogglelyError) {
            reject(error)
          } else {
            reject(
              new TogglelyNetworkError(
                error instanceof Error ? error.message : String(error)
              )
            )
          }
        })
    }).finally(() => {
      if (controller) this.requests.delete(controller)
    })
  }
}

export function createOfflineTogglesScript(
  toggles: Record<string, any>
): string {
  return `<script>window.__TOGGLELY_TOGGLES = ${JSON.stringify(toggles)};</script>`
}

export function togglesToEnvVars(
  toggles: Record<string, any>,
  prefix: string = 'TOGGLELY_'
): Record<string, string> {
  const envVars: Record<string, string> = {}
  for (const [key, value] of Object.entries(toggles)) {
    const envKey = prefix + key.toUpperCase().replace(/-/g, '_')
    envVars[envKey] =
      typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return envVars
}

export default TogglelyClient
