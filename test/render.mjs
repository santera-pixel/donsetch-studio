/**
 * Render the panel's React tree outside a browser.
 *
 * The shell supplies React and the real data source; here both are stubbed so a
 * plain `node` run can prove the panel paints real ledger data (search detail,
 * fetch detail, rows, timing bars) instead of throwing on a missing field.
 *
 *   node test/render.mjs            # reads the live state bridge
 *   node test/render.mjs state.json # reads a saved /state payload
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FRAGMENT = Symbol('fragment')

// ------------------------------------------------------------------ fake React

let cursors = []
let cursor = 0
let dirty = false
const effects = []

const React = {
  Fragment: FRAGMENT,
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in cursors)) cursors[index] = typeof initial === 'function' ? initial() : initial
    return [cursors[index], (next) => {
      cursors[index] = typeof next === 'function' ? next(cursors[index]) : next
      dirty = true
    }]
  },
  useEffect(run) {
    const index = cursor++
    effects.push({ index, run })
  },
  useCallback(fn) {
    cursor += 1
    return fn
  },
}

function resetCursors() {
  cursor = 0
}

function flushEffects() {
  const pending = effects.splice(0)
  for (const effect of pending) {
    const cleanup = effect.run()
    if (typeof cleanup === 'function') effect.cleanup = cleanup
  }
}

/** Walk one rendered element tree, calling every function component. */
function walk(node, label, out, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, label, out, depth)
    return
  }
  if (typeof node.type === 'function') {
    assert.ok(depth < 40, `component tree too deep under ${label}`)
    const rendered = node.type({ ...node.props, children: node.children })
    walk(rendered, label, out, depth + 1)
    return
  }
  if (node.type === FRAGMENT) {
    walk(node.children, label, out, depth + 1)
    return
  }
  out.tags.push(node.type)
  if (node.props && typeof node.props.style === 'object') out.styles += 1
  walk(node.children, label, out, depth + 1)
}

// ------------------------------------------------------------------- stubs

const target = process.argv[2] !== undefined && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:64551').replace(/\/+$/, '')
const stateUrl = `${base}/api/donsetch-studio/state?limit=20`

async function loadState() {
  if (target !== undefined) {
    const raw = JSON.parse(readFileSync(path.resolve(target), 'utf8'))
    return raw.value ?? raw
  }
  const response = await fetch(stateUrl)
  const body = await response.json()
  return body.value
}

const live = await loadState()
assert.ok(Array.isArray(live.runs) && live.runs.length > 0, 'no runs in the ledger to render')

const searches = live.runs.filter((run) => run.kind === 'search')
const fetches = live.runs.filter((run) => run.kind === 'fetch')
console.log(`state: ${live.runs.length} run(s), ${searches.length} search(es), ${fetches.length} fetch(es)`)

let served = live
globalThis.fetch = async (url) => {
  assert.match(String(url), /\/api\/donsetch-studio\/state/)
  return { ok: true, status: 200, json: async () => ({ ok: true, value: served }) }
}
globalThis.EventSource = class {
  constructor() {}
  addEventListener() {}
  close() {}
}
const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'donsetch-studio')
      const module = factory((specifier) => {
        if (specifier === 'react') return React
        throw new Error(`unexpected require: ${specifier}`)
      })
      captured.exports = module
    },
  },
}

await import(pathToFileURL(path.resolve('lib/client.js')).href)
assert.equal(typeof captured.exports.apply, 'function')
assert.deepEqual(captured.exports.inject, ['slots'])

// ---------------------------------------------------------------- mount

const slots = {}
const ctx = {
  slots: {
    inject(ownerKey, register) {
      register()
      return () => {}
    },
    register(declaration, component) {
      slots[`${declaration.name}:${declaration.key ?? declaration.id}`] = { declaration, component }
      return () => {}
    },
  },
  effect(run) {
    const dispose = run()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}
captured.exports.apply(ctx)

const panelKey = 'main:donsetch-studio'
const sidebarKey = 'sidebar.panellist:donsetch-studio'
assert.ok(slots[panelKey], 'the panel never registered into main')
assert.ok(slots[sidebarKey], 'the sidebar icon never registered')
assert.equal(slots[sidebarKey].declaration.order, 11)
assert.equal(slots[sidebarKey].declaration.label(), 'donsetch studio')
console.log(`slots: ${Object.keys(slots).join(', ')}`)

async function render(label) {
  const out = { tags: [], text: [], styles: 0 }
  // The hook store survives passes; only the read cursor resets, like React.
  cursors = []
  // Several passes: the state hook settles, then the tree renders with data.
  for (let pass = 0; pass < 6; pass += 1) {
    resetCursors()
    dirty = false
    out.tags.length = 0
    out.text.length = 0
    out.styles = 0
    walk(React.createElement(slots[panelKey].component, {}), label, out, 0)
    flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) break
  }
  const text = out.text.join(' ')
  console.log(`render ${label}: ${out.tags.length} node(s), ${out.styles} styled, ${text.length} char(s)`)
  return { ...out, text }
}

const icon = { tags: [], text: [], styles: 0 }
walk(React.createElement(slots[sidebarKey].component, { size: 16, active: false }), 'icon', icon, 0)
assert.equal(icon.tags[0], 'svg', 'the sidebar entry is not an svg')
assert.ok(icon.text.length === 0 && icon.styles === 0, 'the icon must not carry text')
console.log(`icon: svg with ${icon.tags.length} node(s)`)

// Fetch run first → FetchDetail paints page cards.
served = { ...live, runs: [...fetches, ...searches] }
const fetchView = await render('fetch')
if (fetches.length > 0) {
  assert.ok(fetchView.tags.includes('main'), `no main column: ${fetchView.text.slice(0, 200)}`)
  assert.ok(/Extracted|characters|words|Complete|complete/i.test(fetchView.text), `fetch detail has no extraction stats: ${fetchView.text.slice(0, 200)}`)
  assert.ok(fetchView.text.includes(fetches[0].label ?? fetches[0].pages[0].url), `the fetched url is missing from the panel: ${fetchView.text.slice(0, 300)}`)
}

// Search run first → SearchDetail paints engines and results.
served = { ...live, runs: [...searches, ...fetches] }
const searchView = await render('search')
if (searches.length > 0) {
  const run = searches[0]
  const engineNames = [...new Set(run.engines.map((engine) => engine.engine))]
  for (const name of engineNames) {
    assert.ok(searchView.text.includes(name), `engine ${name} is missing from the timing panel`)
  }
  for (const result of run.results.slice(0, 3)) {
    assert.ok(searchView.text.includes(result.domain), `result domain ${result.domain} is missing`)
  }
  assert.ok(searchView.text.includes(run.label), 'the query is missing from the detail header')
  assert.ok(searchView.text.includes('donsetch studio'), 'the header is missing')
}

// Empty ledger → the empty state must still paint.
served = { ...live, runs: [], total: 0 }
const emptyView = await render('empty')
assert.ok(/Nothing recorded yet|No runs|record/i.test(emptyView.text), 'the empty state has no copy')

if (process.argv.includes('--dump')) {
  const width = 100
  for (const [name, view] of [['fetch', fetchView], ['search', searchView]]) {
    console.log(`\n=== ${name} ===`)
    let line = ''
    for (const word of view.text.split(/\s+/)) {
      if (line.length + word.length + 1 > width) {
        console.log(line)
        line = word
      } else {
        line = line.length === 0 ? word : `${line} ${word}`
      }
    }
    if (line.length > 0) console.log(line)
  }
}

console.log('\nOK — the panel renders every state from real ledger data')
