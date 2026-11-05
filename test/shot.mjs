/**
 * Render the panel's React tree to standalone HTML, for docs screenshots.
 *
 * Same fake React and same mount path as test/render.mjs, but instead of
 * counting nodes it serializes the tree to HTML with inline styles intact, so a
 * headless browser can paint it. The panel styles itself through
 * `var(--dsw-alias-*, <fallback>)`, and the fallbacks are the harness palette,
 * so the page needs no stylesheet beyond a body background.
 *
 *   node test/shot.mjs                  # writes docs/preview-search.html + docs/preview-fetch.html
 *   node test/shot.mjs state.json       # from a saved /state payload
 *
 * Then (any Chromium):
 *   chrome --headless=new --hide-scrollbars --window-size=1320,1080 \
 *          --screenshot=docs/preview-search.png file:///<abs path>/docs/preview-search.html
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FRAGMENT = Symbol('fragment')
const UNITLESS = new Set([
  'opacity', 'zIndex', 'order', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight',
  'gridColumn', 'gridRow', 'columnCount', 'fillOpacity', 'strokeWidth',
])

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

function flushEffects() {
  for (const effect of effects.splice(0)) effect.run()
}

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function cssValue(property, value) {
  if (typeof value === 'number' && !UNITLESS.has(property)) return `${value}px`
  return String(value)
}

function styleAttribute(style) {
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [property, value] of Object.entries(style)) {
    if (value === null || value === undefined || value === false) continue
    const name = property.startsWith('--') ? property : property.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    parts.push(`${name}:${cssValue(property, value)}`)
  }
  return parts.length > 0 ? ` style="${escapeHtml(parts.join(';'))}"` : ''
}

function attributes(props) {
  let out = ''
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children' || key === 'style') continue
    if (value === null || value === undefined || value === false) continue
    if (typeof value === 'function' || typeof value === 'object') continue
    if (key === 'key' || key === 'ref') continue
    out += ` ${key}="${escapeHtml(value)}"`
  }
  return out
}

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node.type === 'function') {
    return toHtml(node.type({ ...node.props, children: node.children }))
  }
  if (node.type === FRAGMENT) return toHtml(node.children)
  const body = toHtml(node.children)
  const tag = node.type
  if (tag === 'br' || tag === 'img' || tag === 'input' || tag === 'hr') {
    return `<${tag}${attributes(node.props)}${styleAttribute(node.props?.style)}>`
  }
  return `<${tag}${attributes(node.props)}${styleAttribute(node.props?.style)}>${body}</${tag}>`
}

// ------------------------------------------------------------------- stubs

const stateFile = process.argv[2] !== undefined && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:64551').replace(/\/+$/, '')

async function loadState() {
  if (stateFile !== undefined) {
    const raw = JSON.parse(readFileSync(path.resolve(stateFile), 'utf8'))
    return raw.value ?? raw
  }
  const response = await fetch(`${base}/api/donsetch-studio/state?limit=20`)
  const body = await response.json()
  return body.value
}

const live = await loadState()
assert.ok(Array.isArray(live.runs) && live.runs.length > 0, 'the ledger is empty — run a search or a fetch first')

let served = live
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: served }) })
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
}
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      window.__captured = factory((specifier) => {
        if (specifier === 'react') return React
        throw new Error(`unexpected require: ${specifier}`)
      })
    },
  },
}
globalThis.window.__captured = null

await import(pathToFileURL(path.resolve('lib/client.js')).href)
const exported = window.__captured
assert.equal(typeof exported.apply, 'function')

const slots = {}
exported.apply({
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
})

const panel = slots['main:donsetch-studio']?.component
const sidebar = slots['sidebar.panellist:donsetch-studio']?.component
assert.ok(panel, 'the panel did not register into main')

async function paint(label, state) {
  served = state
  cursors = []
  let html = ''
  for (let pass = 0; pass < 6; pass += 1) {
    cursor = 0
    dirty = false
    html = toHtml(React.createElement(panel, {}))
    flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) break
  }
  return { label, html }
}

const searches = live.runs.filter((run) => run.kind === 'search')
const fetches = live.runs.filter((run) => run.kind === 'fetch')
assert.ok(searches.length > 0, 'no search runs in the ledger')
assert.ok(fetches.length > 0, 'no fetch runs in the ledger')

const searchRun = searches[0]
// One fetched page makes for a half-empty screenshot, and the fetch view is
// where the per-page cards live. Show the richest run instead of the newest.
const fetchRun = fetches
  .slice()
  .sort((a, b) => (b.pages?.length ?? 0) - (a.pages?.length ?? 0) || (b.contentChars ?? 0) - (a.contentChars ?? 0))[0]

const sidebarIcon = sidebar
  ? toHtml(React.createElement(sidebar, { size: 18, active: true })).replace(/ style="[^"]*"/, '')
  : ''

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; background: #14151a; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e8e9ed; }
  .frame { display: flex; min-height: 100vh; }
  .rail { width: 56px; flex: 0 0 56px; background: #101116; border-right: 1px solid #23262e;
          display: flex; flex-direction: column; align-items: center; padding: 14px 0 0; gap: 10px; }
  .rail .slot { width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center;
                justify-content: center; color: #a9adb9; }
  .rail .slot.on { background: rgba(106,166,255,0.14); color: #6aa6ff; }
  .rail .slot svg { width: 18px; height: 18px; }
  .canvas { flex: 1; min-width: 0; }
</style></head>
<body><div class="frame">
  <div class="rail"><div class="slot on">${sidebarIcon}</div></div>
  <div class="canvas">${body}</div>
</div></body></html>`
}

mkdirSync('docs', { recursive: true })

const search = await paint('search', { ...live, runs: [searchRun, ...live.runs.filter((r) => r.id !== searchRun.id)] })
const fetchView = await paint('fetch', { ...live, runs: [fetchRun, ...live.runs.filter((r) => r.id !== fetchRun.id)] })

writeFileSync(path.join('docs', 'preview-search.html'), page('donsetch studio - search', search.html))
writeFileSync(path.join('docs', 'preview-fetch.html'), page('donsetch studio - fetch', fetchView.html))

console.log(`search: ${search.html.length} bytes of html, run ${searchRun.id} (${searchRun.label})`)
console.log(`fetch:  ${fetchView.html.length} bytes of html, run ${fetchRun.id} (${fetchRun.pages?.[0]?.url ?? fetchRun.label})`)
console.log('wrote docs/preview-search.html and docs/preview-fetch.html')


