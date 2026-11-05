# Battle test — 2026-11-05

Host: Windows, DSH desktop profile, donsetch 4.10.5 (bundled), keyless search.
Goal: exercise the plugin against real, hostile sites (Reddit) and record what broke.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| 1 | `search site:reddit.com/r/StableDiffusion` | 0 results (ddg reported 10 hits, all filtered) |
| 2 | `search site:reddit.com/r/DeepSeek` | 0 results, same shape |
| 3 | `fetch` two subreddit front pages (1 URL each) | ok at tier 1 (Listing, 3 server-rendered posts) |
| 4 | `fetch` two URLs in one call | **failed — real bug** (see #1) |
| 5 | `fetch` `/r/X/hot.json` and `/r/X/.json` | `wall.challenge` (exit 3) |
| 6 | `fetch` `/r/X/.rss` | `content.extract` after challenge → browser escalation |
| 7 | `fetch` reddit thread URLs (`/comments/<id>/…`) | **ok — Forum, full comment tree** |
| 8 | `fetch` tier 2 (headless browser) on example.com | **failed — environment** (see limitations) |
| 9 | `fetch` a third-party reddit renderer (redlib, safereddit, r.jina.ai) | blocked / 429 |
| 10 | toolbox survives: 30 runs, 36 pages, panel renders 342/410/44 nodes | ok |

Representative runs (all visible in the studio panel):

- `ds_mw3f2fdv_ztmv3` — r/DeepSeek threads, 2/2 pages, 3 712 + 1 550 chars, kind `Forum`, 35-comment thread reduced to "showing 24 of 35".
- `ds_mw3f4leq_tvm6x` — r/StableDiffusion threads, 2/2 pages, `Forum`, link handles (`LcbuVWBUJ`) intact.
- `ds_mw3ettv9_gtjr3` — old.reddit.com rewritten to www and served by the listing adapter.
- `ds_mw3ewhr1_g5qnf` — `.rss` failure with the full escalation trail (route → reddit-session → http-fetch 403 → adapter fallback → browser-launch).

## Bugs found and fixed

1. **Batch fetch silently returned one empty page.** One URL yields `{content, meta}`; two or more yield `{"results":[…]}`, and the parser mapped envelopes 1:1 (`lib/donsetch.js:726`). Fixed by flattening `envelope.results` before `normalizeFetch`, plus a `meta.url ?? envelope.url` fallback.
2. **The tool returned stats but not the page text.** `donsetch_fetch` answered with char counts only, so the model could not read what it fetched. Added `content` to the output schema and to the rendered text (6 000 chars per page, clipped marker).
3. **No way to drive the escalation tier.** The binary's `--tier auto|1|2` lever was not exposed; failures kept recommending `tier=2` with no way to ask for it. Added the `tier` parameter end to end.

## Environment limitations (not plugin bugs)

- **Browser tier cannot launch here.** `ghost: profile dir: Access is denied. (os error 5)` with the default cache dir; with `DONSETCH_CACHE_DIR` pointed at a writable dir Chromium starts but never prints a devtools ws line (`browser.transport`). Tier 2 is therefore unusable in this sandbox.
- **Reddit walls its machine endpoints.** `*.json` (including `hot.json`) answers `wall.challenge`; `.rss` needs the browser. The HTML listing adapter and the thread JSON (rewritten by `reddit-json`) still work over plain HTTP.
- **`donsetch_search` filters reddit out of result lists.** The CLI happily returns `www.reddit.com/r/...#comments` URLs for a `site:` query, but the same query through the tool/panel came back with 0 results — worth re-checking after an upstream update.
- **Cookie vault is read-only** in this sandbox (`[ghost] cookie vault lock failed: Access is denied` on stderr); searches still work.

## Verdict

Reddit thread extraction is the strongest part of the toolchain: full comment trees, score/author/age metadata, link handles, honest `Forum` content kind. The two failure modes an agent will hit are machine-readable reddit endpoints (wall) and the browser tier (environment), both surfaced with exit codes and escalation trails instead of silent empties.
