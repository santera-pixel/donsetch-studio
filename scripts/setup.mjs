#!/usr/bin/env node
/**
 * Prefetch the donsetch runtime.
 *
 * The plugin downloads it lazily on the first search, which means that search
 * carries a one-time ~18 MB download. Run this once after install (or as part
 * of a provisioning step) to pay that cost outside a tool call:
 *
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --version 4.10.5
 *   node scripts/setup.mjs --force      # re-download even if already cached
 */
import { existsSync, rmSync } from 'node:fs'
import { describeRuntime, ensureRuntime, RUNTIME_VERSION, runtimeLayout } from '../lib/runtime.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const version = flag('--version') ?? process.env.DONSETCH_VERSION ?? RUNTIME_VERSION

if (args.includes('--force')) {
  const layout = runtimeLayout(version)
  if (existsSync(layout.dir)) {
    console.log(`removing cached runtime at ${layout.dir}`)
    rmSync(layout.dir, { recursive: true, force: true })
  }
}

const started = Date.now()
try {
  const runtime = await ensureRuntime({
    version,
    onProgress: (event) => {
      if (event.phase === 'download') console.log(`downloading ${event.asset}`)
      if (event.phase === 'extract') console.log(`extracting ${(event.bytes / 1_048_576).toFixed(1)} MB`)
    },
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`donsetch ${runtime.version ?? ''} ready in ${seconds}s — ${runtime.binary} (${runtime.source})`)
} catch (error) {
  console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`runtime target: ${JSON.stringify(describeRuntime(version))}`)
  process.exitCode = 1
}
