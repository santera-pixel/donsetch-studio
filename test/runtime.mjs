/**
 * Runtime trust and target tests. No network, no harness.
 *
 *   node test/runtime.mjs
 *
 * The interesting case is the third one: an archive whose bytes do not match
 * the digest this package pins must be rejected before anything is extracted,
 * even though the release's own .sha256 file would happily bless it.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assetName, describeRuntime, pinnedDigest, RUNTIME_VERSION, verifyArchiveDigest } from '../lib/runtime.js'

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`· ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}\n  ${error.message}`)
  }
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

const good = Buffer.from('the archive we expect')
const bad = Buffer.from('the archive somebody swapped in')

check('the pinned digest for 4.10.5 win32-x64 is a literal, not a fetch', () => {
  assert.equal(RUNTIME_VERSION, '4.10.5')
  assert.equal(pinnedDigest('4.10.5', 'win32-x64'), '437876243936063c2f9148cb842073b531469787ee0f344da35d3646fa9a7df8')
})

check('a matching archive verifies', () => {
  assert.equal(verifyArchiveDigest(good, digest(good)), digest(good))
})

check('a tampered archive is rejected with both digests in the message', () => {
  const expected = digest(good)
  assert.throws(() => verifyArchiveDigest(bad, expected), (error) => {
    assert.match(error.message, /checksum mismatch/)
    assert.ok(error.message.includes(expected), 'message should name the expected digest')
    assert.ok(error.message.includes(digest(bad)), 'message should name the actual digest')
    return true
  })
})

check('a missing or malformed digest refuses instead of skipping the check', () => {
  assert.throws(() => verifyArchiveDigest(good, undefined), /no valid digest/)
  assert.throws(() => verifyArchiveDigest(good, 'deadbeef'), /no valid digest/)
})

check('digest lookup is case-insensitive', () => {
  assert.equal(verifyArchiveDigest(good, digest(good).toUpperCase()), digest(good))
})

check('unpinned releases are visible as unpinned rather than silently trusted', () => {
  assert.equal(pinnedDigest('9.9.9', 'win32-x64'), undefined)
  assert.equal(pinnedDigest('4.10.5', 'linux-arm64'), undefined)
})

check('asset lookup maps supported targets and reports the rest as absent', () => {
  assert.equal(assetName('win32', 'x64'), 'donsetch-win32-x64.tar.gz')
  assert.equal(assetName('linux', 'arm64'), 'donsetch-linux-arm64.tar.gz')
  assert.equal(assetName('plan9', 'mips'), undefined)
})

check('describeRuntime reports this host as pinned and supported', () => {
  const described = describeRuntime()
  assert.equal(described.version, '4.10.5')
  assert.equal(described.supported, true)
  assert.equal(described.pinned, true)
  assert.equal(described.asset, 'donsetch-win32-x64.tar.gz')
})

if (failures > 0) {
  console.error(`\n${failures} runtime check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK — pinned digests reject tampered archives before extraction')
}
