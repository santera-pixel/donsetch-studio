/**
 * donsetch process runner + run ledger.
 *
 * The studio never re-implements search: it spawns the bundled `donsetch`
 * binary with `--json`, measures the wall clock around the child process,
 * and records what came back — every engine, every result, every stage
 * duration the binary reports in `meta`. That record is the single source
 * for the agent tools and for the browser panel, so both see the same trace.
 *
 * @module donsetch-studio/runner
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_VERSION, describeRuntime, ensureRuntime as provisionRuntime, peekRuntime } from './runtime.js'

/** Package root (`lib/..`). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const IS_WIN = process.platform === 'win32'
const EXE_NAME = IS_WIN ? 'donsetch.exe' : 'donsetch'
const LEDGER_VERSION = 1
const STDERR_LINE_CAP = 40

/** Bundled binary path. */
export function bundledBinaryPath() {
  return path.join(PACKAGE_ROOT, 'bin', EXE_NAME)
}

/** Bundled root certificates handed to the child through SSL_CERT_FILE. */
export function bundledCertPath() {
  const file = path.join(PACKAGE_ROOT, 'certs', 'node-roots.pem')
  return existsSync(file) ? file : undefined
}

/** True when a path points at an existing file. */
export function isFile(candidate) {
  try {
    return existsSync(candidate)
  } catch {
    return false
  }
}

/** New ledger id — time sortable, human readable in logs. */
function newId() {
  const stamp = Date.now().toString(36)
  const noise = Math.random().toString(36).slice(2, 7)
  return `ds_${stamp}_${noise}`
}

/** Host without `www.`; empty string for unparsable urls. */
export function domainOf(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return ''
  }
}

/** Filter child stderr down to lines a person wants to see. */
function captureStderr(text) {
  const lines = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    // The vault lock notice is an environment quirk with no bearing on a run.
    if (line.includes('[ghost]') && line.includes('cookie vault')) continue
    if (line.startsWith('#')) continue
    lines.push(line.slice(0, 400))
    if (lines.length >= STDERR_LINE_CAP) break
  }
  return lines
}

/** Parse the `--json` payload: one object, an array, or newline-delimited objects. */
export function parseEnvelope(stdout) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (text.length === 0) return { envelopes: [], format: 'empty' }
  try {
    const value = JSON.parse(text)
    return { envelopes: Array.isArray(value) ? value : [value], format: Array.isArray(value) ? 'array' : 'object' }
  } catch {
    const envelopes = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
      try {
        envelopes.push(JSON.parse(trimmed))
      } catch {
        // Not an envelope line — the trailing human summary lives here.
      }
    }
    return { envelopes, format: envelopes.length > 0 ? 'ndjson' : 'unparsed' }
  }
}

/** Word count for extracted markdown. */
export function wordCount(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  return words.length
}

const STDOUT_CAP = 12_000_000
const STDERR_CAP = 400_000

/**
 * Read at most `cap` bytes from a file.
 * @returns {string} the decoded prefix, or '' when the file is unreadable.
 */
function readCapped(file, cap) {
  let fd
  try {
    const size = statSync(file).size
    if (size === 0) return ''
    const length = Math.min(size, cap)
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Spawn one donsetch invocation and collect everything a trace needs.
 *
 * Child output is redirected to regular files rather than pipes: a confined
 * host may refuse to open the named pipes behind `stdio: 'pipe'`, and a file
 * cannot deadlock when the child fills the pipe buffer.
 *
 * @param {string} binary absolute path to the executable.
 * @param {string[]} args argv after the subcommand.
 * @param {{env?: Record<string,string>, timeoutMs?: number, cwd?: string}} options
 */
export function execute(binary, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const startedHr = process.hrtime.bigint()
    const timeoutMs = options.timeoutMs ?? 120_000
    let timedOut = false
    let settled = false
    let spawnError
    let workDir
    let timer

    const settle = (exitCode, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6
      const stdout = workDir === undefined ? '' : readCapped(path.join(workDir, 'stdout'), STDOUT_CAP)
      const stderr = workDir === undefined ? '' : readCapped(path.join(workDir, 'stderr'), STDERR_CAP)
      if (workDir !== undefined) {
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          // The temp dir is a scratch area; a failed cleanup is harmless.
        }
      }
      resolve({
        startedAt,
        durationMs: Math.round(durationMs),
        exitCode,
        stdout,
        stderr,
        timedOut,
        error: error !== undefined ? String(error?.message ?? error) : undefined,
      })
    }

    let child
    try {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'donsetch-studio-'))
      const outFd = openSync(path.join(workDir, 'stdout'), 'w')
      const errFd = openSync(path.join(workDir, 'stderr'), 'w')
      child = spawn(binary, args, {
        cwd: options.cwd ?? PACKAGE_ROOT,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      })
      // The child owns duplicates; the parent must not keep the files open or
      // the handles stay busy on Windows.
      closeSync(outFd)
      closeSync(errFd)
    } catch (error) {
      settle(null, error)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (error) => {
      spawnError = error
      settle(null, error)
    })
    child.on('close', (code) => settle(code, spawnError))
  })
}

/** Normalize one search envelope into the trace shape. */
export function normalizeSearch(envelope, base) {
  const meta = (envelope && typeof envelope === 'object' ? envelope.meta : undefined) ?? {}
  const engines = Array.isArray(meta.engines) ? meta.engines : []
  const results = Array.isArray(meta.results) ? meta.results : []
  const stages = []
  if (meta.stage_ms && typeof meta.stage_ms === 'object') {
    for (const [name, ms] of Object.entries(meta.stage_ms)) {
      const value = Number(ms)
      if (Number.isFinite(value) && value > 0) stages.push({ name, ms: Math.round(value) })
    }
    stages.sort((a, b) => b.ms - a.ms)
  }
  return {
    ...base,
    intent: typeof meta.intent === 'string' ? meta.intent : undefined,
    requested: Number(meta.requested_results) || 0,
    returned: Number(meta.returned_results) || results.length,
    cached: meta.cached === true,
    degraded: meta.degraded === true,
    weak: meta.weak === true,
    instant: meta.instant === true,
    internalMs: Number(meta.elapsed_ms) || 0,
    failedEngines: Number(meta.failed_engines) || 0,
    stages,
    engines: engines.map((entry) => ({
      engine: String(entry.engine ?? '?'),
      status: String(entry.status ?? 'unknown'),
      hits: Number(entry.hits) || 0,
      ms: Number(entry.ms) || 0,
      egress: entry.egress === undefined ? undefined : String(entry.egress),
    })),
    results: results.map((entry, index) => ({
      rank: index + 1,
      title: String(entry.title ?? '').slice(0, 500),
      url: String(entry.url ?? ''),
      domain: domainOf(entry.url),
      snippet: String(entry.snippet ?? ''),
      score: Number(entry.score) || 0,
      consensus: Number(entry.consensus) || 1,
      engines: Array.isArray(entry.engines) ? entry.engines.map(String) : [],
    })),
    content: typeof envelope?.content === 'string' ? envelope.content : '',
    ok: Boolean(envelope?.ok ?? meta.ok),
  }
}

/** Normalize one fetch envelope into the trace shape. */
export function normalizeFetch(envelope) {
  const meta = (envelope && typeof envelope === 'object' ? envelope.meta : undefined) ?? {}
  const content = typeof envelope?.content === 'string' ? envelope.content : ''
  const escalation = Array.isArray(meta.escalation)
    ? meta.escalation.map((step) => ({
      tier: String(step.tier ?? ''),
      action: String(step.action ?? ''),
      ms: Number(step.ms) || 0,
      outcome: String(step.outcome ?? ''),
    }))
    : []
  return {
    url: String(meta.url ?? envelope?.url ?? ''),
    ok: Boolean(envelope?.ok ?? meta.ok),
    status: meta.status === undefined ? undefined : Number(meta.status),
    code: typeof meta.code === 'string' ? meta.code : undefined,
    errorKind: typeof meta.errorKind === 'string' ? meta.errorKind : undefined,
    readStatus: typeof meta.read_status === 'string' ? meta.read_status : undefined,
    contentKind: typeof meta.content_kind === 'string' ? meta.content_kind : undefined,
    lang: typeof meta.lang === 'string' ? meta.lang : undefined,
    script: typeof meta.script === 'string' ? meta.script : undefined,
    changed: typeof meta.changed === 'string' ? meta.changed : undefined,
    complete: meta.content_complete === true,
    nextAction: typeof meta.next_action === 'string' ? meta.next_action : undefined,
    fetchError: typeof meta.fetch_error === 'string' ? meta.fetch_error : undefined,
    recentNetworkFailures: Number(meta.recent_network_failures) || 0,
    escalation,
    content,
    chars: content.length,
    words: wordCount(content),
  }
}

/** Clamp an integer coming from the model or the browser. */
function clampInteger(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), min), max)
}

/**
 * Character budget for stored page text.
 *
 * Zero is a real setting — keep the metrics, drop the markdown — so it has to
 * bypass the clamp's 1,000-character floor.
 */
function contentCapOf(value) {
  if (value === null || value === undefined || value === '') return 20_000
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 20_000
  return Math.round(parsed) === 0 ? 0 : clampInteger(parsed, 1_000, 200_000, 20_000)
}

/**
 * Run ledger + donsetch invocations. One instance per host plugin.
 */
export class Studio {
  constructor(options = {}) {
    this.binary = options.binary
    this.certFile = options.certFile
    this.runtimeVersion = options.runtimeVersion ?? RUNTIME_VERSION
    /** Resolved runtime ({binary, cert, source}); undefined until first use. */
    this.runtime
    this.runtimePromise
    /** Live provisioning state shown while a first-run download is in flight. */
    this.setupState = { phase: 'idle' }
    this.dataDir = options.dataDir
    this.maxRuns = clampInteger(options.maxRuns, 20, 1000, 200)
    this.searchTimeoutMs = clampInteger(options.searchTimeoutMs, 5_000, 300_000, 120_000)
    this.fetchTimeoutMs = clampInteger(options.fetchTimeoutMs, 5_000, 300_000, 90_000)
    this.contentCap = contentCapOf(options.contentCap)
    this.runs = []
    this.listeners = new Set()
    this.revision = 0
    this.active = 0
    this.probeState = { checked: false, ok: false, version: undefined, error: undefined, path: this.binary }
    this.saveTimer
    this.loaded = false
  }

  /** Resolve the executable for display: provisioned runtime first, then PATH. */
  resolveBinary() {
    if (this.runtime !== undefined) return this.runtime.binary
    if (typeof this.binary === 'string' && this.binary.length > 0) return this.binary
    const ready = peekRuntime(this.runtimeVersion)
    if (ready !== undefined) return ready.binary
    return EXE_NAME
  }

  /**
   * Resolve (and, on first use, download) the donsetch runtime.
   *
   * Memoised per host process: concurrent tool calls share one download, and a
   * failed download is not cached, so the next call retries.
   */
  async ensureRuntime() {
    if (this.runtime !== undefined) return this.runtime
    if (this.runtimePromise === undefined) {
      this.runtimePromise = provisionRuntime({
        version: this.runtimeVersion,
        binary: this.binary,
        onProgress: (event) => {
          this.setupState = event
          this.emit()
        },
      }).then(
        (runtime) => {
          this.runtime = runtime
          this.runtimePromise = undefined
          this.setupState = { phase: 'ready', source: runtime.source }
          this.emit()
          return runtime
        },
        (error) => {
          this.runtimePromise = undefined
          this.setupState = { phase: 'failed', error: error instanceof Error ? error.message : String(error) }
          this.emit()
          throw error
        },
      )
    }
    return this.runtimePromise
  }

  /** Child environment: provisioned roots only when the user has not chosen their own. */
  childEnv() {
    const env = { ...process.env, NO_COLOR: '1', CLICOLOR: '0' }
    const cert = this.runtime?.cert ?? bundledCertPath()
    if (cert !== undefined && !env.SSL_CERT_FILE) env.SSL_CERT_FILE = cert
    return env
  }

  /** Load the persisted ledger (best effort — a corrupt file starts a fresh one). */
  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const file = path.join(this.dataDir, 'runs.json')
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.runs)) return
      this.runs = parsed.runs.filter((run) => run && typeof run.id === 'string')
      // A run that was in flight when the host stopped can never finish.
      for (const run of this.runs) {
        if (run.status === 'running') {
          run.status = 'failed'
          run.ok = false
          run.error = run.error ?? 'interrupted: the host stopped while this run was in flight'
          run.endedAt = run.endedAt ?? run.startedAt
        }
      }
      this.revision += 1
    } catch {
      // Ignore: a broken ledger must not take the plugin down.
    }
  }

  /** Trim + persist the ledger. */
  trim() {
    if (this.runs.length > this.maxRuns) this.runs = this.runs.slice(0, this.maxRuns)
  }

  /** Debounced atomic write of the ledger. */
  scheduleSave() {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 600)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /** Write the ledger now. */
  save() {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      const file = path.join(this.dataDir, 'runs.json')
      const temp = `${file}.tmp`
      writeFileSync(temp, JSON.stringify({ version: LEDGER_VERSION, savedAt: new Date().toISOString(), runs: this.runs }), 'utf8')
      renameSync(temp, file)
    } catch {
      // Persistence is a convenience; the in-memory ledger keeps working.
    }
  }

  /** Subscribe to ledger changes. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Notify subscribers (never throws into the runtime). */
  emit() {
    this.revision += 1
    for (const listener of [...this.listeners]) {
      try {
        listener(this.revision)
      } catch {
        // A broken subscriber must not affect a run.
      }
    }
  }

  /** Insert or replace a run and notify subscribers. */
  upsert(run) {
    const index = this.runs.findIndex((entry) => entry.id === run.id)
    if (index === -1) this.runs.unshift(run)
    else this.runs[index] = run
    this.trim()
    this.scheduleSave()
    this.emit()
    return run
  }

  /** Every recorded run, newest first. */
  list() {
    return this.runs
  }

  /** One run by id. */
  get(id) {
    return this.runs.find((run) => run.id === id)
  }

  /** Drop the history (files stay on disk until the next save). */
  clear() {
    this.runs = []
    this.save()
    this.emit()
  }

  /** Engine health derived from the ledger. */
  stats() {
    const engines = new Map()
    let searches = 0
    let fetches = 0
    let searchMs = 0
    let searchOk = 0
    let fetchOk = 0
    let resultsTaken = 0
    for (const run of this.runs) {
      if (run.kind === 'search') {
        searches += 1
        if (run.ok) {
          searchOk += 1
          searchMs += run.durationMs
        }
        resultsTaken += run.results?.length ?? 0
        for (const engine of run.engines ?? []) {
          const current = engines.get(engine.engine) ?? { engine: engine.engine, runs: 0, ok: 0, empty: 0, blocked: 0, failed: 0, hits: 0, ms: 0, msSamples: 0 }
          current.runs += 1
          const status = String(engine.status ?? '')
          if (status === 'ok') {
            current.ok += 1
            if (engine.hits === 0) current.empty += 1
            current.hits += engine.hits ?? 0
            if (engine.ms > 0) {
              current.ms += engine.ms
              current.msSamples += 1
            }
          } else if (status.startsWith('blocked')) {
            current.blocked += 1
          } else {
            current.failed += 1
          }
          engines.set(engine.engine, current)
        }
      } else if (run.kind === 'fetch') {
        fetches += 1
        if (run.ok) fetchOk += 1
      }
    }
    return {
      revisions: this.revision,
      runs: this.runs.length,
      searches,
      fetches,
      searchOk,
      fetchOk,
      avgSearchMs: searchOk > 0 ? Math.round(searchMs / searchOk) : 0,
      resultsTaken,
      engines: [...engines.values()]
        .map((entry) => ({
          engine: entry.engine,
          runs: entry.runs,
          ok: entry.ok,
          empty: entry.empty,
          blocked: entry.blocked,
          failed: entry.failed,
          hits: entry.hits,
          avgMs: entry.msSamples > 0 ? Math.round(entry.ms / entry.msSamples) : 0,
        }))
        .sort((a, b) => b.ok - a.ok || a.avgMs - b.avgMs),
    }
  }

  /**
   * Compact a run for list payloads: extracted text clipped, heavy fields dropped.
   * Page text travels with the run, so it needs the same budget as the search
   * markdown — otherwise one crawl-sized fetch would dominate the state payload.
   */
  digest(run, contentChars = 4000, pageChars = 8_000) {
    const { content, ...rest } = run
    const clipped = typeof content === 'string' ? content.slice(0, contentChars) : ''
    const pages = Array.isArray(run.pages)
      ? run.pages.map((page) => {
        const text = typeof page.content === 'string' ? page.content : ''
        return {
          ...page,
          content: text.slice(0, pageChars),
          contentClipped: text.length > pageChars,
        }
      })
      : run.pages
    return {
      ...rest,
      pages,
      content: clipped,
      contentChars: typeof content === 'string' ? content.length : 0,
      contentClipped: typeof content === 'string' ? content.length > contentChars : false,
    }
  }

  /** Snapshot for the browser panel. */
  snapshot(limit = 60) {
    return {
      revision: this.revision,
      stats: this.stats(),
      probe: this.probeState,
      setup: this.setupState,
      runtime: describeRuntime(this.runtimeVersion),
      runs: this.runs.slice(0, limit).map((run) => this.digest(run)),
      total: this.runs.length,
    }
  }

  /** Probe the binary once; cached until {@link resetProbe}. */
  async probe(force = false) {
    if (this.probeState.checked && !force) return this.probeState
    let runtime
    try {
      runtime = await this.ensureRuntime()
    } catch (error) {
      this.probeState = {
        checked: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        path: undefined,
        runtime: describeRuntime(this.runtimeVersion),
        checkedAt: new Date().toISOString(),
      }
      this.emit()
      return this.probeState
    }
    const binary = runtime.binary
    const result = await execute(binary, ['--version'], { env: this.childEnv(), timeoutMs: 15_000 })
    const text = `${result.stdout}\n${result.stderr}`.trim()
    const versionLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
    this.probeState = {
      checked: true,
      ok: !result.timedOut && result.exitCode === 0,
      version: versionLine === undefined ? undefined : versionLine.slice(0, 160),
      error: result.error ?? (result.timedOut ? 'probe timed out' : result.exitCode === 0 ? undefined : text.slice(0, 400)),
      path: binary,
      bundled: runtime.source === 'bundled',
      source: runtime.source,
      runtimeVersion: runtime.version,
      certFile: runtime.cert,
      checkedAt: new Date().toISOString(),
    }
    this.emit()
    return this.probeState
  }

  /** Reset the probe cache (after a binary change). */
  resetProbe() {
    this.probeState = { checked: false, ok: false, path: this.resolveBinary() }
  }

  /** Shared run scaffolding. */
  begin(kind, input, meta) {
    const run = {
      id: newId(),
      kind,
      status: 'running',
      ok: false,
      source: meta.source ?? 'ui',
      tool: meta.tool,
      label: input.label,
      input: input.payload,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      endedAt: null,
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      error: null,
      engines: [],
      results: [],
      pages: [],
      stages: [],
      stderr: [],
      content: '',
      contentChars: 0,
    }
    this.upsert(run)
    return run
  }

  /** Finish a run: attach the process result, derive notes, notify. */
  finish(run, execution, notes = []) {
    run.endedAt = new Date().toISOString()
    run.durationMs = execution.durationMs
    run.exitCode = execution.exitCode
    run.timedOut = execution.timedOut
    run.stderr = captureStderr(execution.stderr)
    run.notes = notes
    if (run.content.length > 0 && run.content.length > this.contentCap) {
      run.contentClipped = true
      run.content = run.content.slice(0, this.contentCap)
    }
    run.contentChars = run.content.length
    run.status = run.ok ? 'ok' : 'failed'
    if (run.error === null) delete run.error
    return this.upsert(run)
  }

  /**
   * Run a web search and record the trace.
   * @param {{query: string, maxResults?: number, intent?: string, source?: string, tool?: string}} params
   */
  async runSearch(params) {
    const query = String(params.query ?? '').trim()
    if (query.length === 0) throw new Error('query is required')
    const maxResults = clampInteger(params.maxResults, 1, 12, 8)
    const intent = params.intent === undefined || params.intent === '' ? undefined : String(params.intent)
    const args = ['search', query, '--json', '--max-results', String(maxResults)]
    if (intent !== undefined) args.push('--intent', intent)

    const run = this.begin('search', {
      label: query,
      payload: { query, maxResults, intent },
    }, { source: params.source, tool: params.tool })

    this.active += 1
    try {
      const setupStarted = Date.now()
      const runtime = await this.ensureRuntime()
      const setupMs = Date.now() - setupStarted
      if (setupMs > 250) {
        run.setup = { ms: setupMs, source: runtime.source, version: runtime.version, bytes: runtime.bytes }
      }
      const execution = await execute(runtime.binary, args, {
        env: this.childEnv(),
        timeoutMs: this.searchTimeoutMs,
      })
      const parsed = parseEnvelope(execution.stdout)
      const envelope = parsed.envelopes[0]
      const notes = []
      if (run.setup?.source === 'download') {
        notes.push(`one-time runtime setup: downloaded donsetch ${run.setup.version} (${Math.round((run.setup.bytes ?? 0) / 1_048_576)} MB) in ${(run.setup.ms / 1000).toFixed(1)} s and verified its SHA-256`)
      }
      if (execution.timedOut) {
        run.ok = false
        run.error = `search timed out after ${this.searchTimeoutMs} ms`
      } else if (envelope === undefined) {
        run.ok = false
        const raw = execution.stdout.trim()
        run.error = raw.length > 0 ? `could not parse the search payload: ${raw.slice(0, 400)}` : `search failed with exit code ${execution.exitCode}`
        run.content = raw.slice(0, 4000)
      } else {
        Object.assign(run, normalizeSearch(envelope, {}))
        run.exitCode = execution.exitCode
        run.overheadMs = Math.max(0, execution.durationMs - (run.internalMs || 0))
        const answered = run.engines.filter((engine) => engine.status === 'ok').length
        const blocked = run.engines.filter((engine) => engine.status.startsWith('blocked')).length
        if (run.cached) notes.push('served from the donsetch result cache — no network call')
        if (run.degraded) notes.push(`degraded: ${run.returned} of ${run.requested} requested results, ${run.failedEngines} engine failure(s)`)
        notes.push(`${answered} engine(s) answered, ${blocked} blocked, ${run.engines.length} consulted`)
        if (run.failedEngines > 0) {
          const names = run.engines.filter((engine) => engine.status.startsWith('blocked')).map((engine) => `${engine.engine} (${engine.status})`)
          if (names.length > 0) run.notesBlocked = names
        }
        if (run.results.length === 0 && run.ok) notes.push('no results survived filtering')
        run.ok = Boolean(run.ok)
        if (!run.ok) run.error = run.error ?? 'search reported failure'
      }
      return this.finish(run, execution, notes)
    } catch (error) {
      run.ok = false
      run.error = error instanceof Error ? error.message : String(error)
      return this.finish(run, { durationMs: Date.now() - run.startedMs, exitCode: null, timedOut: false, stderr: '' }, ['the runner threw before the child produced a payload'])
    } finally {
      this.active -= 1
    }
  }

  /**
   * Fetch one or more urls and record the extraction trace.
   * @param {{urls: string[]|string, mode?: string, maxChars?: number, toc?: boolean, links?: boolean, source?: string, tool?: string}} params
   */
  async runFetch(params) {
    const list = (Array.isArray(params.urls) ? params.urls : String(params.urls ?? '').split(/[\s,]+/))
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 12)
    if (list.length === 0) throw new Error('at least one url is required')
    const mode = ['scan', 'read', 'deep'].includes(String(params.mode)) ? String(params.mode) : undefined
    const tier = ['auto', '1', '2'].includes(String(params.tier)) ? String(params.tier) : undefined
    const maxChars = params.maxChars === undefined ? undefined : clampInteger(params.maxChars, 200, 200_000, 20_000)
    const toc = params.toc === true
    const links = params.links === true

    const args = ['fetch', ...list, '--json']
    if (mode !== undefined) args.push('--mode', mode)
    if (tier !== undefined) args.push('--tier', tier)
    if (maxChars !== undefined) args.push('--max-chars', String(maxChars))
    if (toc) args.push('--toc')
    if (links) args.push('--links')

    const run = this.begin('fetch', {
      label: list.length === 1 ? list[0] : `${list.length} urls`,
      payload: { urls: list, mode, tier, maxChars, toc, links },
    }, { source: params.source, tool: params.tool })

    this.active += 1
    try {
      const setupStarted = Date.now()
      const runtime = await this.ensureRuntime()
      const setupMs = Date.now() - setupStarted
      if (setupMs > 250) {
        run.setup = { ms: setupMs, source: runtime.source, version: runtime.version, bytes: runtime.bytes }
      }
      const execution = await execute(runtime.binary, args, {
        env: this.childEnv(),
        timeoutMs: this.fetchTimeoutMs,
      })
      const parsed = parseEnvelope(execution.stdout)
      const notes = []
      if (run.setup?.source === 'download') {
        notes.push(`one-time runtime setup: downloaded donsetch ${run.setup.version} (${Math.round((run.setup.bytes ?? 0) / 1_048_576)} MB) in ${(run.setup.ms / 1000).toFixed(1)} s and verified its SHA-256`)
      }
      if (execution.timedOut) {
        run.ok = false
        run.error = `fetch timed out after ${this.fetchTimeoutMs} ms`
      } else if (parsed.envelopes.length === 0) {
        run.ok = false
        const raw = execution.stdout.trim()
        run.error = raw.length > 0 ? `could not parse the fetch payload: ${raw.slice(0, 400)}` : `fetch failed with exit code ${execution.exitCode}`
        run.content = raw.slice(0, 4000)
      } else {
        // One URL yields a page object; a batch yields {"results":[page, page, ...]}.
        const pageEnvelopes = parsed.envelopes.flatMap((envelope) =>
          Array.isArray(envelope?.results) ? envelope.results : [envelope],
        )
        run.pages = pageEnvelopes.map((envelope) => normalizeFetch(envelope))
        run.content = run.pages.map((page) => page.content).filter(Boolean).join('\n\n---\n\n')
        run.contentChars = run.content.length
        run.ok = run.pages.some((page) => page.ok)
        const failed = run.pages.filter((page) => !page.ok)
        const okPages = run.pages.filter((page) => page.ok)
        if (okPages.length > 0) {
          const chars = okPages.reduce((sum, page) => sum + page.chars, 0)
          const words = okPages.reduce((sum, page) => sum + page.words, 0)
          notes.push(`${okPages.length} page(s) extracted, ${chars.toLocaleString('en-US')} chars / ${words.toLocaleString('en-US')} words`)
          for (const page of okPages) {
            if (!page.complete) notes.push(`${domainOf(page.url) || page.url}: content hit the char budget and is truncated`)
          }
        }
        for (const page of failed) {
          notes.push(`${domainOf(page.url) || page.url}: ${page.code ?? page.readStatus ?? 'failed'}${page.errorKind ? ` (${page.errorKind})` : ''}${page.nextAction ? ` — ${page.nextAction}` : ''}`)
        }
        if (!run.ok) run.error = failed[0]?.fetchError ?? failed[0]?.code ?? 'every url failed'
      }
      return this.finish(run, execution, notes)
    } catch (error) {
      run.ok = false
      run.error = error instanceof Error ? error.message : String(error)
      return this.finish(run, { durationMs: Date.now() - run.startedMs, exitCode: null, timedOut: false, stderr: '' }, ['the runner threw before the child produced a payload'])
    } finally {
      this.active -= 1
    }
  }

  /** Stop timers (plugin dispose). */
  dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      this.save()
    }
    this.listeners.clear()
  }
}
