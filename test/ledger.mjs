/**
 * Ledger retention tests. No network, no harness, no donsetch binary.
 *
 *   node test/ledger.mjs
 *
 * What is worth pinning down here is that the two retention knobs are visible
 * and clamped, and that `contentCap: 0` really means "keep the metrics, drop
 * the markdown" rather than "store an empty string and call it a cap".
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Studio } from '../lib/donsetch.js'

let failures = 0
const home = mkdtempSync(path.join(os.tmpdir(), 'donsetch-ledger-'))

function check(name, fn) {
  try {
    fn()
    console.log(`· ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}\n  ${error.message}`)
  }
}

function studio(options = {}) {
  return new Studio({ dataDir: home, ...options })
}

/** Push a finished run with `content` through the real clipping path. */
function runWith(target, content) {
  const run = target.begin('fetch', { label: 'test' }, { source: 'test' })
  run.ok = true
  run.content = content
  target.finish(run, { durationMs: 12, exitCode: 0, timedOut: false, stderr: '' })
  return run
}

check('the defaults are 200 runs and 20000 characters', () => {
  const target = studio()
  assert.equal(target.maxRuns, 200)
  assert.equal(target.contentCap, 20_000)
})

check('both knobs come from config', () => {
  const target = studio({ maxRuns: 50, contentCap: 5_000 })
  assert.equal(target.maxRuns, 50)
  assert.equal(target.contentCap, 5_000)
})

check('out-of-range values are clamped, not accepted', () => {
  assert.equal(studio({ maxRuns: 5 }).maxRuns, 20)
  assert.equal(studio({ maxRuns: 5_000 }).maxRuns, 1_000)
  assert.equal(studio({ contentCap: 400 }).contentCap, 1_000)
  assert.equal(studio({ contentCap: 999_999 }).contentCap, 200_000)
  assert.equal(studio({ maxRuns: 'nonsense', contentCap: undefined }).maxRuns, 200)
})

check('contentCap 0 is a real setting, not a clamp to the floor', () => {
  assert.equal(studio({ contentCap: 0 }).contentCap, 0)
  assert.equal(studio({ contentCap: '0' }).contentCap, 0)
})

check('the ledger keeps only the most recent maxRuns runs', () => {
  const target = studio({ maxRuns: 20 })
  for (let index = 0; index < 25; index += 1) runWith(target, `run ${index}`)
  assert.equal(target.runs.length, 20)
  assert.equal(target.runs[0].content, 'run 24')
})

check('a 1000-character cap clips the text and flags it', () => {
  const target = studio({ contentCap: 1_000 })
  const run = runWith(target, 'x'.repeat(5_000))
  assert.equal(run.content.length, 1_000)
  assert.equal(run.contentChars, 1_000)
  assert.equal(run.contentClipped, true)
})

check('contentCap 0 keeps the run and its metrics but stores no text', () => {
  const target = studio({ contentCap: 0 })
  const run = runWith(target, 'x'.repeat(5_000))
  assert.equal(run.content, '')
  assert.equal(run.contentChars, 0)
  assert.equal(run.contentClipped, true)
  assert.equal(run.status, 'ok')
  assert.equal(run.durationMs, 12)
  assert.equal(run.exitCode, 0)
  assert.equal(run.kind, 'fetch')
})

check('text under the cap is untouched and unflagged', () => {
  const target = studio({ contentCap: 20_000 })
  const run = runWith(target, 'short page')
  assert.equal(run.content, 'short page')
  assert.equal(run.contentChars, 10)
  assert.notEqual(run.contentClipped, true)
})

rmSync(home, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nOK — the ledger keeps what its config says it keeps')
