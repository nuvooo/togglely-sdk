/**
 * @jest-environment node
 *
 * Runs the client in a separate Node process against a local HTTP server
 * (flags + an endless SSE stream) and checks that the process can exit.
 */
import { spawn } from 'child_process'
import { createServer, Server, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import path from 'path'

const SRC = path.resolve(__dirname, '..', 'index.ts')

// Loads the TypeScript sources with typescript.transpileModule
const RUNNER = `
const fs = require('fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  module._compile(output, filename)
}
const { TogglelyClient } = require(process.env.SDK_SRC)
const config = JSON.parse(process.env.SDK_CONFIG)
const client = new TogglelyClient(config)
client.on('ready', () => {
  console.log('ready')
  if (process.env.SDK_DESTROY) {
    const done = () => { client.destroy(); console.log('destroyed') }
    if (config.refreshStrategy === 'realtime') client.on('stream-connected', done)
    else done()
  }
})
`

function run(
  config: Record<string, unknown>,
  destroy: boolean,
  timeoutMs: number
): Promise<{ exited: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', RUNNER], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        SDK_SRC: SRC,
        SDK_CONFIG: JSON.stringify(config),
        ...(destroy && { SDK_DESTROY: '1' }),
      },
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ exited: false, code: null, output })
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ exited: true, code, output })
    })
  })
}

describe('Node process lifecycle', () => {
  let server: Server
  let baseUrl: string
  const streams = new Set<ServerResponse>()
  let streamRequests = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/sdk/stream/')) {
        streamRequests++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('retry: 5000\n\nevent: ready\nid: 1\ndata: {"version":1}\n\n')
        streams.add(res)
        res.on('close', () => streams.delete(res))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: 'W/"1-abc"',
      })
      res.end(JSON.stringify({ a: { value: true, enabled: true } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    streams.forEach((res) => res.end())
    await new Promise((resolve) => server.close(resolve))
  })

  const config = () => ({
    apiKey: 'key',
    project: 'p',
    environment: 'e',
    baseUrl,
    offlineFallback: false,
  })

  it('default client (no strategy) lets the process exit', async () => {
    const before = streamRequests
    const result = await run(config(), false, 15000)
    expect(result.output).toContain('ready')
    expect(result.exited).toBe(true)
    expect(result.code).toBe(0)
    expect(streamRequests).toBe(before)
  }, 20000)

  it('explicit realtime: destroy() lets the process exit', async () => {
    const before = streamRequests
    const result = await run(
      { ...config(), refreshStrategy: 'realtime' },
      true,
      15000
    )
    expect(result.output).toContain('destroyed')
    expect(result.exited).toBe(true)
    expect(result.code).toBe(0)
    expect(streamRequests).toBe(before + 1)
  }, 20000)

  it('explicit realtime without destroy() keeps the process alive', async () => {
    const result = await run(
      { ...config(), refreshStrategy: 'realtime' },
      false,
      3000
    )
    expect(result.output).toContain('ready')
    expect(result.exited).toBe(false)
  }, 10000)
})
