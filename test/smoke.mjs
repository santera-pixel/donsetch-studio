/**
 * Smoke test for the donsetch-studio bundle.
 *
 * Runs without the harness: it exercises the real runner against the bundled
 * binary, then mounts the host half behind a stubbed `@deepseek-ai/dsh-tools`
 * and drives the HTTP bridge with fake request/response objects.
 *
 *   node test/smoke.mjs            # full run (search + fetch hit the network)
 *   node test/smoke.mjs --offline  # only wiring and ledger checks
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const offline = process.argv.includes('--offline')
const profileDir = path.join(here, '.tmp-profile')

rmSync(profileDir, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
process.env.DSH_PROFILE_DIR = profileDir

const logs = []
function step(name) {
  logs.push(name)
  console.log(`· ${name}`)
}

/** Minimal Response collector for the route handlers. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: undefined,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
      this.ended = true
    },
    on() {},
  }
}

/** Request stub: iterable for bodies, an EventEmitter for `close`. */
function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:64329', ...headers }
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  }
  return req
}

/** Poll the bridge until the newest run leaves `running`. */
async function settle(handler, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = fakeRes()
    await handler(fakeReq({ url: '/api/donsetch-studio/state?limit=10' }), res)
    const payload = JSON.parse(res.chunks.join(''))
    const run = payload.value.runs[0]
    if (run !== undefined && run.status !== 'running') return payload.value
    if (Date.now() > deadline) throw new Error('timed out waiting for the run to settle')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// ---------------------------------------------------------------- runner

const { Studio } = await import('../lib/donsetch.js')

const studio = new Studio({ dataDir: path.join(profileDir, '.donsetch-studio') })
studio.load()

const probe = await studio.probe()
step(`probe: ${probe.ok ? probe.version : `FAILED ${probe.error}`}`)
assert.equal(probe.ok, true, `donsetch probe failed: ${probe.error}`)
assert.match(String(probe.version), /donsetch/i)

if (!offline) {
  const search = await studio.runSearch({ query: 'rust tokio async runtime tutorial', maxResults: 3, source: 'test' })
  step(`search: ok=${search.ok} results=${search.results.length} engines=${search.engines.length} ${search.durationMs} ms`)
  assert.equal(search.status, 'ok', search.error)
  assert.equal(search.kind, 'search')
  assert.ok(search.durationMs > 0, 'wall clock was not measured')
  assert.ok(search.results.length > 0, 'no results')
  for (const result of search.results) {
    assert.equal(typeof result.url, 'string')
    assert.ok(result.url.startsWith('http'), `bad url ${result.url}`)
    assert.ok(result.domain.length > 0, `no domain for ${result.url}`)
    assert.ok(result.rank >= 1)
    assert.ok(Array.isArray(result.engines))
  }
  assert.ok(search.engines.some((engine) => engine.status === 'ok'), 'no engine answered')

  const fetchRun = await studio.runFetch({ urls: ['https://example.com'], source: 'test' })
  step(`fetch: ok=${fetchRun.ok} pages=${fetchRun.pages.length} chars=${fetchRun.contentChars} ${fetchRun.durationMs} ms`)
  assert.equal(fetchRun.status, 'ok', fetchRun.error)
  assert.equal(fetchRun.pages.length, 1)
  assert.equal(fetchRun.pages[0].ok, true)
  // example.com is a two-sentence page: ~195 characters of real content.
  assert.ok(fetchRun.pages[0].chars > 120, 'example.com extraction looks empty')
  assert.match(fetchRun.pages[0].content, /Example Domain/)
}

const stats = studio.stats()
step(`stats: runs=${stats.runs} engines=${stats.engines.length} avg=${stats.avgSearchMs} ms`)
if (!offline) {
  assert.equal(stats.searches, 1)
  assert.equal(stats.fetches, 1)
  assert.ok(stats.engines.length > 0)
  assert.ok(stats.engines.every((engine) => engine.runs > 0))
}

// Ledger survives a restart of the host half.
studio.save()
const reopened = new Studio({ dataDir: path.join(profileDir, '.donsetch-studio') })
reopened.load()
step(`ledger: ${reopened.list().length} run(s) reloaded`)
assert.equal(reopened.list().length, studio.list().length)

// ----------------------------------------------------------------- wiring

// The harness resolves `@deepseek-ai/dsh-tools` itself; a plain node process
// gets a stub so the host module can be exercised outside DSH.
const stubUrl = new URL('./dsh-tools-stub.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const host = await import('../lib/index.js')
assert.equal(host.name, 'donsetch-studio')
assert.equal(typeof host.apply, 'function')
step('host module: exports name + apply')

const record = { tools: [], routes: [], sections: [], effects: [] }
const ctx = {
  effect(fn, label) {
    record.effects.push(label)
    return fn()
  },
  inject(names, callback) {
    const key = names[0]
    const services = {
      tools: { register: (definition) => { record.tools.push(definition); return () => {} } },
      systemPrompt: { section: (section) => { record.sections.push(section); return () => {} } },
      webServer: { register: (route) => { record.routes.push(route); return () => {} } },
    }
    callback({
      effect: ctx.effect,
      inject: ctx.inject,
      [key]: services[key],
    })
  },
}

host.apply(ctx)

step(`wiring: ${record.tools.length} tool(s), ${record.routes.length} route(s), ${record.sections.length} prompt section(s), effects=${record.effects.join('|')}`)
assert.deepEqual(record.tools.map((tool) => tool.name).sort(), ['donsetch_engines', 'donsetch_fetch', 'donsetch_search'])
for (const tool of record.tools) {
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.ok(tool.description.length > 40, `${tool.name} has no usable description`)
}
assert.equal(record.routes.length, 1)
assert.equal(record.routes[0].kind, 'prefix')
assert.equal(record.routes[0].path, '/api/donsetch-studio')
assert.equal(record.sections.length, 1)
assert.ok(record.sections[0].text.includes('donsetch_search'))
assert.equal(record.sections[0].order, 62)

const handler = record.routes[0].handler

// GET /state before any probe finished.
const stateRes = fakeRes()
await handler(fakeReq({ url: '/api/donsetch-studio/state?limit=5' }), stateRes)
assert.equal(stateRes.statusCode, 200)
const stateBody = JSON.parse(stateRes.chunks.join(''))
assert.equal(stateBody.ok, true)
assert.equal(stateBody.value.panelId, 'donsetch-studio')
assert.ok(Array.isArray(stateBody.value.runs))
assert.ok(stateBody.value.stats !== undefined)
step(`GET /state: ${stateBody.value.runs.length} run(s), binary=${stateBody.value.binary.path}`)

// POST /probe
const probeRes = fakeRes()
await handler(fakeReq({
  method: 'POST',
  url: '/api/donsetch-studio/probe',
  headers: { origin: 'http://127.0.0.1:64329', 'sec-fetch-site': 'same-origin' },
  body: {},
}), probeRes)
assert.equal(probeRes.statusCode, 200)
assert.equal(JSON.parse(probeRes.chunks.join('')).value.ok, true)
step('POST /probe: ok')

// Cross-origin writes are refused.
const denied = fakeRes()
await handler(fakeReq({
  method: 'POST',
  url: '/api/donsetch-studio/run',
  headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  body: { mode: 'search', query: 'x' },
}), denied)
assert.equal(denied.statusCode, 403)
step('POST /run cross-origin: 403')

// Unknown run id.
const missing = fakeRes()
await handler(fakeReq({ url: '/api/donsetch-studio/run?id=nope' }), missing)
assert.equal(missing.statusCode, 404)

if (!offline) {
  // POST /run starts a search the panel would then watch over SSE.
  const accept = fakeRes()
  await handler(fakeReq({
    method: 'POST',
    url: '/api/donsetch-studio/run',
    headers: { origin: 'http://127.0.0.1:64329', 'sec-fetch-site': 'same-origin' },
    body: { mode: 'search', query: 'node.js undici fetch timeout', maxResults: 2 },
  }), accept)
  assert.equal(accept.statusCode, 202)
  const settled = await settle(handler)
  assert.equal(settled.runs[0].status, 'ok', settled.runs[0].error)
  assert.equal(settled.runs[0].source, 'ui')
  step(`POST /run: finished ${settled.runs[0].id} in ${settled.runs[0].durationMs} ms with ${settled.runs[0].results.length} result(s)`)
}

// Tools execute against the same ledger.
const searchTool = record.tools.find((tool) => tool.name === 'donsetch_search')
const emptyCheck = await searchTool.execute({}).then(() => null, (error) => error)
assert.ok(emptyCheck instanceof Error, 'empty query should reject')
step('tool validation: empty query rejected')

const enginesTool = record.tools.find((tool) => tool.name === 'donsetch_engines')
const health = await enginesTool.execute({})
assert.ok(health.engines.length >= 0)
const rendered = enginesTool.output.render({}, health)
assert.equal(rendered[0].type, 'text')
step('tool execute + render: ok')

// Clear
const cleared = fakeRes()
await handler(fakeReq({
  method: 'POST',
  url: '/api/donsetch-studio/clear',
  headers: { origin: 'http://127.0.0.1:64329', 'sec-fetch-site': 'same-origin' },
  body: {},
}), cleared)
assert.equal(cleared.statusCode, 200)
step('POST /clear: ok')

rmSync(profileDir, { recursive: true, force: true })
console.log(`\nOK — ${logs.length} checks passed${offline ? ' (offline)' : ''}`)
