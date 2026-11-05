/**
 * donsetch runtime provisioning.
 *
 * The npm package carries no binaries: a 40 MB payload inside a plugin tarball
 * is hostile to every install path (pnpm store, CI caches, offline mirrors) and
 * drags AGPL redistribution along with it. Instead the runtime is fetched once
 * from the upstream release, verified against the published SHA-256, and kept
 * in a user cache shared by every harness profile:
 *
 *   %USERPROFILE%\.dsh\.donsetch-studio\runtime\<version>\bin\donsetch.exe
 *
 * Nothing here writes into the plugin directory, so it also works when
 * node_modules is read-only (pnpm) or lives in a content-addressed store.
 *
 * @module donsetch-studio/runtime
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/** Upstream release the studio is built and tested against. */
export const RUNTIME_VERSION = '4.10.5'

const REPO = 'dondai44423/donsetch'
const EXE_NAME = process.platform === 'win32' ? 'donsetch.exe' : 'donsetch'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Digests pinned in this package, per release and target.
 *
 * The .sha256 published beside an asset comes from the same GitHub release as
 * the asset itself, so it proves the download is intact but not who produced
 * it: whoever can replace an asset can replace its checksum in the same edit.
 * Pinning the digest here means a forged archive has to match bytes this
 * repository already names, which takes a second compromised account.
 *
 * Entries exist only for targets that were downloaded and checked on a real
 * machine; anything else falls back to the release checksum and is labelled
 * unpinned in the marker and in describeRuntime().
 */
const PINNED_SHA256 = {
  '4.10.5': {
    'win32-x64': '437876243936063c2f9148cb842073b531469787ee0f344da35d3646fa9a7df8',
  },
}

/** Release asset published for each supported target. */
const ASSETS = {
  'win32-x64': 'donsetch-win32-x64.tar.gz',
  'darwin-arm64': 'donsetch-darwin-arm64.tar.gz',
  'darwin-x64': 'donsetch-darwin-x64.tar.gz',
  'linux-x64': 'donsetch-linux-x64.tar.gz',
  'linux-arm64': 'donsetch-linux-arm64.tar.gz',
}

/** Root of the shared runtime cache (override with DONSETCH_STUDIO_HOME). */
export function runtimeHome() {
  const custom = process.env.DONSETCH_STUDIO_HOME
  if (typeof custom === 'string' && custom.trim().length > 0) return path.resolve(custom.trim())
  return path.join(os.homedir(), '.dsh', '.donsetch-studio', 'runtime')
}

/** Paths for one runtime version. */
export function runtimeLayout(version = RUNTIME_VERSION) {
  const home = runtimeHome()
  const dir = path.join(home, version)
  return {
    home,
    dir,
    binary: path.join(dir, 'bin', EXE_NAME),
    marker: path.join(dir, 'runtime.json'),
    cert: path.join(home, 'node-roots.pem'),
  }
}

/**
 * Targets that run someone else's asset.
 *
 * Upstream publishes no ARM64 Windows build, but Windows 11 on ARM runs x64
 * binaries under emulation, and a native ARM64 Node reports `win32-arm64`.
 * Pointing that at the x64 archive is the supported route; refusing to start
 * would have looked like the plugin being broken on exactly those machines.
 */
const TARGET_ALIASES = {
  'win32-arm64': 'win32-x64',
}

/** Target key used for asset lookup and digest pinning. */
export function targetKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  return TARGET_ALIASES[key] ?? key
}

/** Release asset name for a platform/arch pair, if upstream ships one. */
export function assetName(platform = process.platform, arch = process.arch) {
  return ASSETS[targetKey(platform, arch)]
}

/** Digest this package pins for one release target, or undefined. */
export function pinnedDigest(version = RUNTIME_VERSION, key = targetKey()) {
  return PINNED_SHA256[version]?.[key]
}

/**
 * Compare archive bytes against a digest known in advance. Pure and exported
 * so the tampered path can be tested without a 17 MB download.
 */
export function verifyArchiveDigest(archive, expected, label = 'runtime archive') {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(`${label}: no valid digest to verify against`)
  }
  const actual = sha256(archive)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`)
  }
  return actual
}

function readMarker(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function certIfPresent(file) {
  try {
    return existsSync(file) && statSync(file).size > 0 ? file : undefined
  } catch {
    return undefined
  }
}

/**
 * Write a PEM bundle of Node's own trust store once, for sandboxes where
 * donsetch cannot read the OS certificate store (it fails closed with
 * "tls: no root certs loaded" instead of falling back).
 */
export function ensureCertFile() {
  const layout = runtimeLayout()
  const existing = certIfPresent(layout.cert)
  if (existing !== undefined) return existing
  const roots = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : []
  if (roots.length === 0) return undefined
  try {
    mkdirSync(layout.home, { recursive: true })
    writeFileSync(layout.cert, `${roots.join('\n')}\n`, 'utf8')
    return layout.cert
  } catch {
    return undefined
  }
}

/** A runtime that already exists on this machine, without touching the network. */
export function cachedRuntime(version = RUNTIME_VERSION) {
  const layout = runtimeLayout(version)
  if (!existsSync(layout.binary)) return undefined
  const marker = readMarker(layout.marker)
  return {
    source: 'cache',
    version,
    binary: layout.binary,
    cert: certIfPresent(layout.cert) ?? ensureCertFile(),
    dir: layout.dir,
    bytes: Number(marker?.bytes) || undefined,
    installedAt: typeof marker?.installedAt === 'string' ? marker.installedAt : undefined,
  }
}

/**
 * Best-effort synchronous view used for status display before anything runs.
 * Never downloads.
 */
export function peekRuntime(version = RUNTIME_VERSION) {
  const explicit = process.env.DONSETCH_BIN
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const binary = path.resolve(explicit.trim())
    if (existsSync(binary)) return { source: 'env', binary, cert: ensureCertFile(), dir: path.dirname(binary) }
  }
  const bundled = path.join(PACKAGE_ROOT, 'bin', EXE_NAME)
  if (existsSync(bundled)) {
    const bundledCert = path.join(PACKAGE_ROOT, 'certs', 'node-roots.pem')
    return { source: 'bundled', version: undefined, binary: bundled, cert: certIfPresent(bundledCert) ?? ensureCertFile(), dir: path.dirname(bundled) }
  }
  return cachedRuntime(version)
}

let inflight

/**
 * Resolve a usable runtime, downloading it once when it is not present.
 *
 * Resolution order: explicit binary (config) → DONSETCH_BIN → bundled copy
 * (development checkout) → cached download → fresh download.
 *
 * @param {{version?: string, binary?: string, onProgress?: (event: {phase: string, [key: string]: unknown}) => void}} [options]
 * @returns {Promise<{source: string, version?: string, binary: string, cert?: string, dir: string, bytes?: number}>}
 */
export function ensureRuntime(options = {}) {
  const version = options.version ?? RUNTIME_VERSION
  const explicit = options.binary ?? process.env.DONSETCH_BIN
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const binary = path.resolve(explicit.trim())
    if (!existsSync(binary)) throw new Error(`donsetch binary not found at ${binary}`)
    return Promise.resolve({ source: 'config', binary, cert: ensureCertFile(), dir: path.dirname(binary) })
  }
  const ready = peekRuntime(version)
  if (ready !== undefined) return Promise.resolve(ready)
  if (inflight === undefined) {
    inflight = provision(version, options.onProgress).finally(() => {
      inflight = undefined
    })
  }
  return inflight
}

/** Clear the memoised in-flight download (tests). */
export function resetRuntimeCache() {
  inflight = undefined
}

/** Human-readable state for the panel header. */
export function describeRuntime(version = RUNTIME_VERSION) {
  const asset = assetName()
  const layout = runtimeLayout(version)
  const current = peekRuntime(version)
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    asset,
    supported: asset !== undefined,
    pinned: pinnedDigest(version) !== undefined,
    emulated: targetKey() !== `${process.platform}-${process.arch}`,
    home: layout.home,
    binary: current?.binary,
    source: current?.source ?? 'download-needed',
    bytes: current?.bytes,
    installedAt: current?.installedAt,
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'donsetch-studio' } })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error(`GET ${url} returned an empty body`)
  return buffer
}

function parseSha256(text) {
  const match = /^([0-9a-f]{64})\b/i.exec(String(text).trim())
  if (match === null) throw new Error('the upstream .sha256 file did not contain a checksum')
  return match[1].toLowerCase()
}

/** The release's own checksum file, when it can be fetched at all. */
async function publishedChecksum(url) {
  try {
    return parseSha256((await download(url)).toString('utf8'))
  } catch {
    return undefined
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function provision(version, onProgress) {
  const asset = assetName()
  if (asset === undefined) {
    throw new Error(`donsetch publishes no prebuilt runtime for ${process.platform}-${process.arch}; set DONSETCH_BIN to a donsetch executable`)
  }
  const layout = runtimeLayout(version)
  const pinned = pinnedDigest(version, targetKey())
  const base = `https://github.com/${REPO}/releases/download/v${version}`
  mkdirSync(layout.home, { recursive: true })

  onProgress?.({ phase: 'download', asset, url: `${base}/${asset}`, pinned: pinned !== undefined })
  const archive = await download(`${base}/${asset}`)
  onProgress?.({ phase: 'verify', bytes: archive.length, pinned: pinned !== undefined })
  const published = await publishedChecksum(`${base}/${asset}.sha256`)
  const label = `donsetch ${version} (${asset})`
  if (pinned !== undefined && published !== undefined && published !== pinned) {
    throw new Error(`${label}: the release now advertises ${published}, but this package pins ${pinned}; refusing to install bytes this version does not describe`)
  }
  const expected = pinned ?? published
  if (expected === undefined) {
    throw new Error(`${label}: no digest is pinned in this package and the release publishes none; refusing to extract`)
  }
  const actual = verifyArchiveDigest(archive, expected, label)

  onProgress?.({ phase: 'extract', bytes: archive.length })
  const staging = `${layout.dir}.staging-${process.pid}-${Date.now().toString(36)}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    extractTarGz(archive, staging)
    // Upstream ships a flat archive (donsetch.exe next to its DLLs); the cache
    // keeps them together in bin/ so the loader finds the DLLs beside the exe.
    const flatBinary = path.join(staging, EXE_NAME)
    if (!existsSync(path.join(staging, 'bin', EXE_NAME)) && existsSync(flatBinary)) {
      const binDir = path.join(staging, 'bin')
      mkdirSync(binDir, { recursive: true })
      for (const entry of readdirSync(staging)) {
        if (entry === 'bin') continue
        renameSync(path.join(staging, entry), path.join(binDir, entry))
      }
    }
    const binary = path.join(staging, 'bin', EXE_NAME)
    if (!existsSync(binary)) throw new Error(`donsetch archive ${asset} did not contain ${EXE_NAME}`)
    if (process.platform !== 'win32') chmodSync(binary, 0o755)
    writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify({
      version,
      asset,
      sha256: actual,
      pinned: pinned !== undefined,
      checksumSource: pinned !== undefined ? 'package' : 'release',
      bytes: archive.length,
      installedAt: new Date().toISOString(),
    }, null, 2))
    // Another process may have won the race; either way the files are identical.
    if (existsSync(layout.dir)) rmSync(layout.dir, { recursive: true, force: true })
    renameSync(staging, layout.dir)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  onProgress?.({ phase: 'ready', bytes: archive.length })
  const runtime = cachedRuntime(version)
  if (runtime === undefined) throw new Error('donsetch runtime vanished after extraction')
  return { ...runtime, source: 'download', bytes: archive.length }
}

/** Read a NUL-terminated string out of a tar header slice. */
function field(header, offset, length) {
  const slice = header.subarray(offset, offset + length)
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString('utf8').trim()
}

/**
 * Minimal ustar/gzip extraction. donsetch ships a flat archive (three files in
 * bin/), so only regular files, directories and PAX/GNU long names matter.
 */
export function extractTarGz(buffer, destination) {
  const tar = gunzipSync(buffer)
  let offset = 0
  let longName
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const size = Number.parseInt(field(header, 124, 12) || '0', 8)
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    const data = tar.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString('utf8')
      continue
    }
    if (type === 'x' || type === 'g' || type === 'K') continue

    const relative = (longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name)).replace(/^\.\//, '')
    longName = undefined
    if (relative.length === 0) continue
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new Error(`refusing to extract a tar entry outside the target: ${relative}`)
    }
    const target = path.join(destination, relative)
    if (type === '5') {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\u0000') continue
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}
