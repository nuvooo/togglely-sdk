/**
 * Realtime integration test against a running Togglely backend.
 *
 * Flow: log in to the dashboard API, create a temporary API key for the
 * organization of the project, start a client with refreshStrategy
 * 'realtime', toggle a flag through the dashboard API and expect the
 * client's `update` event within a few seconds. The flag is toggled back
 * and the API key deleted afterwards.
 *
 * Environment (defaults match the demo data):
 *   TOGGLELY_IT_URL       http://127.0.0.1:4000
 *   TOGGLELY_IT_EMAIL     demo@togglely.io
 *   TOGGLELY_IT_PASSWORD  demo123!
 *   TOGGLELY_IT_PROJECT   sample-project
 *   TOGGLELY_IT_ENV       development
 *
 * Run with: npm run test:integration -- realtime
 */

import { TogglelyClient, ToggleValue } from '../index'

const BASE_URL = process.env.TOGGLELY_IT_URL || 'http://127.0.0.1:4000'
const EMAIL = process.env.TOGGLELY_IT_EMAIL || 'demo@togglely.io'
const PASSWORD = process.env.TOGGLELY_IT_PASSWORD || 'demo123!'
const PROJECT = process.env.TOGGLELY_IT_PROJECT || 'sample-project'
const ENVIRONMENT = process.env.TOGGLELY_IT_ENV || 'development'
const UPDATE_TIMEOUT_MS = 4000

async function api<T = any>(
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method: init.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path}: HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

function waitFor<T>(
  register: (resolve: (value: T) => void) => void,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout after ${timeoutMs} ms: ${label}`)),
      timeoutMs
    )
    register((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

describe('Realtime updates (integration)', () => {
  let token: string
  let apiKeyId: string | null = null
  let apiKey: string
  let flagId: string
  let flagKey: string
  let environmentId: string
  let originalEnabled: boolean
  let client: TogglelyClient | null = null
  const statuses: string[] = []
  const realFetch = global.fetch

  beforeAll(async () => {
    const login = await api<{ token: string }>('/auth/login', null, {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    })
    token = login.token

    const projects = await api<{ projects: any[] } | any[]>('/projects', token)
    const project = (Array.isArray(projects) ? projects : projects.projects).find(
      (candidate: any) => candidate.key === PROJECT
    )
    if (!project) throw new Error(`Project ${PROJECT} not found`)

    const { environments } = await api<{ environments: any[] }>(
      `/projects/${project.id}/environments`,
      token
    )
    const environment = environments.find((env) => env.key === ENVIRONMENT)
    if (!environment) throw new Error(`Environment ${ENVIRONMENT} not found`)
    environmentId = environment.id

    const { featureFlags } = await api<{ featureFlags: any[] }>(
      `/feature-flags/project/${project.id}`,
      token
    )
    const flag = featureFlags.find((candidate) =>
      candidate.environments?.some(
        (env: any) => env.environmentId === environmentId
      )
    )
    if (!flag) throw new Error('No flag in the environment')
    flagId = flag.id
    flagKey = flag.key
    originalEnabled = flag.environments.find(
      (env: any) => env.environmentId === environmentId
    ).enabled

    const created = await api<{ apiKey: { id: string; key: string } }>(
      `/api-keys/organization/${project.organizationId}`,
      token,
      {
        method: 'POST',
        body: { name: `sdk-realtime-it-${Date.now()}`, type: 'SERVER' },
      }
    )
    apiKeyId = created.apiKey.id
    apiKey = created.apiKey.key

    // Record the SDK's requests (status per endpoint)
    global.fetch = (async (input: any, init?: any) => {
      const response = await realFetch(input, init)
      const url = String(input)
      if (url.includes('/sdk/')) {
        statuses.push(
          `${url.includes('/sdk/stream/') ? 'stream' : 'flags'} ${response.status}`
        )
      }
      return response
    }) as typeof fetch
  })

  afterAll(async () => {
    client?.destroy()
    global.fetch = realFetch
    if (flagId && environmentId && originalEnabled !== undefined) {
      await api(`/feature-flags/${flagId}/toggle`, token, {
        method: 'POST',
        body: { environmentId, enabled: originalEnabled },
      }).catch((error) => console.error('Restoring flag failed:', error))
    }
    if (apiKeyId) {
      await api(`/api-keys/${apiKeyId}`, token, { method: 'DELETE' }).catch(
        (error) => console.error('Deleting API key failed:', error)
      )
    }
  })

  it('receives a flag toggle through the stream within a few seconds', async () => {
    client = new TogglelyClient({
      apiKey,
      baseUrl: BASE_URL,
      project: PROJECT,
      environment: ENVIRONMENT,
      refreshStrategy: 'realtime',
      offlineFallback: false,
    })
    const current = client
    await waitFor<void>(
      (resolve) => current.on('stream-connected', () => resolve()),
      10000,
      'stream-connected'
    )
    expect(current.isReady()).toBe(true)
    const before: ToggleValue = current.getAllToggles()[flagKey]
    expect(before).toBeDefined()
    expect(before.enabled).toBe(originalEnabled)

    // ETag: unchanged flags cost a 304 without update event
    const onUpdate = jest.fn()
    current.on('update', onUpdate)
    await current.refresh()
    expect(statuses).toContain('flags 304')
    expect(onUpdate).not.toHaveBeenCalled()

    const started = Date.now()
    const updated = waitFor<ToggleValue>(
      (resolve) =>
        current.on('update', () => {
          const value = current.getAllToggles()[flagKey]
          if (value && value.enabled !== before.enabled) resolve(value)
        }),
      UPDATE_TIMEOUT_MS,
      'update event after toggle'
    )
    await api(`/feature-flags/${flagId}/toggle`, token, {
      method: 'POST',
      body: { environmentId, enabled: !originalEnabled },
    })
    const after = await updated
    const latency = Date.now() - started

    expect(after.enabled).toBe(!originalEnabled)
    console.log(
      `[realtime-it] ${flagKey}: enabled ${before.enabled} -> ${after.enabled} ` +
        `in ${latency} ms; requests: ${statuses.join(', ')}`
    )

    // Toggle back: the client follows again
    const restored = waitFor<ToggleValue>(
      (resolve) =>
        current.on('update', () => {
          const value = current.getAllToggles()[flagKey]
          if (value && value.enabled === originalEnabled) resolve(value)
        }),
      UPDATE_TIMEOUT_MS,
      'update event after toggling back'
    )
    await api(`/feature-flags/${flagId}/toggle`, token, {
      method: 'POST',
      body: { environmentId, enabled: originalEnabled },
    })
    expect((await restored).enabled).toBe(originalEnabled)
  })
})
