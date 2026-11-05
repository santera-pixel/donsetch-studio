# donsetch studio

[DonSeTch](https://github.com/dondai44423/donsetch) as a harness plugin, with a panel that shows
what actually happened: every query, every engine that answered or refused, every result with the
engines that produced it, and how many milliseconds each stage took.

The plugin drives the `donsetch` binary (pinned to v4.10.5) as a child process and reads its
`--json` output. No keys, no accounts.

## What you get

**Tools** (also visible to the model):

| tool | what it does |
| --- | --- |
| `donsetch_search` | keyless web/code/paper/news search, returns ranked results with engine provenance |
| `donsetch_fetch` | fetch up to 12 URLs and return the extracted markdown (6 000 chars per page in the tool result, full text in the panel); `mode` scan/read/deep, `tier` auto/1/2, `toc`, `links`, `maxChars` |
| `donsetch_engines` | per-engine health from the run ledger (ok / empty / blocked / failed, average ms) |

**Panel**: a full-width view in the main panel plus a sidebar icon. Left column is the run ledger
(newest first, live elapsed time while a run is in flight); right column is the selected run.

- **Search detail**: run time vs. internal `meta.elapsed_ms`, per-engine timing bars (wall time per
  engine, coloured by status), result count, how many engines were blocked or failed, the
  corroboration count behind each result, the post-processing stages from `meta.stage_ms`
  (`enrich`, `filters`, `topup`), and the raw markdown the tool returned.
- **Fetch detail**: one card per page with characters, words, whether the extraction was complete,
  language/script/content kind, HTTP status, the escalation trail (`route` / `tier` / `outcome`),
  and the extracted markdown.
- **Composer**: run a search or a fetch straight from the panel, using the same code path as the
  tools.

Timings are measured on the host (`process.hrtime.bigint()` around the child process), so they
include process start-up — that is the number a caller actually waits for. The internal number the
binary reports is shown next to it so the overhead is visible.

## Install

The package is a bundle (`dsh.bundle.patch`): installing it adds the dependency and activates the
row `donsetch-studio` in the profile's `cordis.patch.yml`. This repository *is* the package, so it
installs from a git spec — the same `github:` form the plugin hub records for bundles that are not
on npm (check any profile: `graph-memory` → `github:adoresever/graph-memory`):

```sh
dsh plugin --profile <profile> add github:dondai44423/donsetch-studio
```

Or in the app: **Settings → Plugins → install by spec**, paste
`github:dondai44423/donsetch-studio`. To pick up later commits, run the same command with `update`.

Nothing is built and nothing is bundled — the checkout is plain ESM, so `pnpm` cloning the
repository is the whole installation.

### The runtime is downloaded on first use

The npm package carries no binary. On first use the plugin downloads the pinned upstream release
for the host platform (`donsetch-win32-x64.tar.gz` and friends), verifies it against the `.sha256`
published next to it, and caches it in:

```
~/.dsh/.donsetch-studio/runtime/4.10.5/bin/donsetch.exe
```

That is one ~17 MB download per machine (not per profile, not per install), and it is recorded in
the run ledger as a `setup` chip. To pay the cost up front instead of inside the first search:

```sh
node node_modules/donsetch-studio/scripts/setup.mjs
```

Set `DONSETCH_BIN` to skip the download entirely and use an existing `donsetch` executable.

## Verified

- cold install from `npm pack` with an empty runtime cache → probe downloads 17 587 446 bytes,
  checksum `43787624…9a7df8` matches, extracts `donsetch.exe` + `onnxruntime.dll` + `pdfium.dll`
  into `bin/`, writes the CA bundle, `DonSeTch 4.10.5` answers
- probe → `DonSeTch 4.10.5`
- search from the panel (`POST /run`) → 202, then `status: ok`, 9.9 s wall / 9.7 s internal, 10
  engines (bing ok 500 ms, yahoo ok 889 ms, ddg ok 896 ms, google/mojeek/brave blocked), 4 results
- search from the tool → recorded with `source: agent`, `tool: donsetch_search`, 9.5 s, 3 results
- fetch `https://www.rust-lang.org/` → 2 835 chars, 422 words, `complete: true`, `lang: en`
- fetch that donsetch cannot extract (`doc.rust-lang.org`, `content.extract`) → the failure, the
  escalation trail and `next_action` all reach the panel
- `donsetch_engines` → per-engine health across the recorded searches

## Data

Runs are persisted to `runs.json`, capped at the 200 most recent runs: under
`<DSH_PROFILE_DIR>/.donsetch-studio/` when the host exports that variable, otherwise under
`<DSH_HOME>/.donsetch-studio/`, otherwise `~/.dsh/.donsetch-studio/`. On the machine this was built
on the desktop shell exports the three `DSH_*` path variables as empty strings, so the live ledger
is `C:\Users\Santera\.dsh\.donsetch-studio\runs.json`; `GET /api/donsetch-studio/state` reports the
resolved path as `ledgerPath`. The ledger survives harness restarts; a run that was in flight when
the host stopped is marked as interrupted on load.

## Environment

| variable | effect |
| --- | --- |
| `DONSETCH_BIN` | use this `donsetch` executable instead of downloading one |
| `DONSETCH_STUDIO_HOME` | cache root for the runtime (default `~/.dsh/.donsetch-studio/runtime`) |
| `SSL_CERT_FILE` | respected by the child as usual; when unset the plugin points it at a generated PEM of Node's trust store |

That last part matters: donsetch builds its own TLS context and fails closed with
`tls: no root certs loaded` when `rustls-native-certs` cannot see an OS store (common in sandboxes
and containers). The plugin writes Node's own roots to `node-roots.pem` in the runtime cache and
points `SSL_CERT_FILE` at it, so searches work without touching the host.

## HTTP bridge

The panel talks to the host over same-origin JSON, with SSE for revisions:

- `GET  /api/donsetch-studio/state?limit=N` — probe state, stats, runtime state, runs (content clipped)
- `GET  /api/donsetch-studio/run?id=…` — one run
- `POST /api/donsetch-studio/run` — start a search or fetch (202, fire and forget)
- `POST /api/donsetch-studio/probe` — re-run `donsetch --version`
- `POST /api/donsetch-studio/clear` — empty the ledger
- `GET  /api/donsetch-studio/events` — SSE `hello` / `revision` frames

Writes are rejected for cross-origin callers (`sec-fetch-site: cross-site`, or a mismatched
`Origin`).

## Tests

```
node test/smoke.mjs        # real search + fetch, then the whole host half on a fake ctx
node test/smoke.mjs --offline
node test/render.mjs       # renders the panel against the live /state bridge
node test/render.mjs --dump  # …and prints the text it painted
node test/field-audit.mjs  # which fields the panel reads from the payload
```

`smoke.mjs` drives the prefix handler with fake `IncomingMessage`/`ServerResponse` objects, so it
covers routing, the origin guard, validation and a real run without starting the harness. It needs
`DONSETCH_BIN` or a downloaded runtime, exactly like the plugin.

## Licence

The plugin code is AGPL-3.0-only. The `donsetch` runtime is downloaded from
[dondai44423/donsetch](https://github.com/dondai44423/donsetch) at install/first-use time and stays
under the upstream AGPL-3.0 licence; nothing of it is redistributed in this package.
