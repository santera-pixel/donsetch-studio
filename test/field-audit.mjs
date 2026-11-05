// One-off audit: which fields does the panel read from the state payload?
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
for (const name of ['run', 'page', 'engine', 'state', 'stats', 'probe', 'result', 'item', 'entry']) {
  const pattern = new RegExp(`\\b${name}\\.([A-Za-z0-9_]+)`, 'g')
  const keys = new Set([...source.matchAll(pattern)].map((match) => match[1]))
  if (keys.size > 0) console.log(`${name}: ${[...keys].sort().join(' ')}`)
}
