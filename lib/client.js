/**
 * donsetch-studio — browser panel.
 *
 * Renders the run ledger the host half records: for every search, each engine
 * with its latency and hit count; every result with the engines that returned
 * it; for every fetch, what was extracted and how much of it. Values come from
 * `/api/donsetch-studio/state` and are refreshed whenever the host bumps the
 * ledger revision over SSE.
 *
 * Hand-written module (no build step): the shell supplies React.
 */
window.__ModuleLoader__.load({
  id: 'donsetch-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/donsetch-studio'
    const PANEL_ID = 'donsetch-studio'
    const RUN_LIMIT = 80
    const CONTENT_PREVIEW = 1400

    /** Theme tokens with dark fallbacks (no literal colours in the markup). */
    const C = {
      base: 'var(--dsw-alias-bg-base, #14151a)',
      layer1: 'var(--dsw-alias-bg-layer-1, #1a1c22)',
      layer2: 'var(--dsw-alias-bg-layer-2, #21242c)',
      elevated: 'var(--dsw-alias-bg-elevated, #1e2027)',
      overlay: 'var(--dsw-alias-bg-overlay, #24272f)',
      border: 'var(--dsw-alias-border-l2, #2c2f38)',
      borderSoft: 'var(--dsw-alias-border-secondary, #262932)',
      text: 'var(--dsw-alias-label-primary, #e8e9ed)',
      text2: 'var(--dsw-alias-label-secondary, #a9adb9)',
      text3: 'var(--dsw-alias-label-tertiary, #7b8090)',
      accent: 'var(--dsw-alias-brand-primary, #6aa6ff)',
      fill: 'var(--dsw-alias-button-primary-fill, #3b6fd4)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
      ok: 'var(--dsw-alias-state-success-primary, #46c98b)',
      warn: 'var(--dsw-alias-state-warning-primary, #e0a83c)',
      err: 'var(--dsw-alias-state-error-primary, #f2655f)',
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    }

    // ---------------------------------------------------------------- format

    /** 840 → "840 ms"; 8064 → "8.06 s"; 92000 → "1 m 32 s". */
    function fmtMs(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '0 ms'
      if (value < 1000) return `${Math.round(value)} ms`
      if (value < 10_000) return `${(value / 1000).toFixed(2)} s`
      if (value < 60_000) return `${(value / 1000).toFixed(1)} s`
      const minutes = Math.floor(value / 60_000)
      const seconds = Math.round((value % 60_000) / 1000)
      return `${minutes} m ${String(seconds).padStart(2, '0')} s`
    }

    /** 1234 → "1,234". */
    function fmtInt(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0'
      return number.toLocaleString('en-US')
    }

    /** ISO stamp → local clock time. */
    function fmtClock(iso) {
      const date = iso === undefined || iso === null ? null : new Date(iso)
      if (date === null || Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    /** Wall-clock age, coarse. */
    function fmtAge(iso, now) {
      const date = iso === undefined || iso === null ? null : new Date(iso)
      if (date === null || Number.isNaN(date.getTime())) return ''
      const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
      if (seconds < 60) return `${seconds}s ago`
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
      if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
      return date.toLocaleDateString()
    }

    /** What the ledger keeps, in the words the header shows. */
    function fmtStorage(storage) {
      if (storage === null || storage === undefined) return null
      const kept = `keeps the last ${fmtInt(storage.maxRuns)} run${storage.maxRuns === 1 ? '' : 's'}`
      const text = storage.contentCap === 0 ? 'no page text' : `page text up to ${fmtInt(storage.contentCap)} chars`
      return `${kept} · ${text}`
    }

    /** One tone per engine/run status. */
    function toneOf(status) {
      const value = String(status ?? '')
      if (value === 'ok') return 'ok'
      if (value === 'running') return 'accent'
      if (value === 'no-results' || value === 'empty') return 'muted'
      if (value.startsWith('blocked')) return 'warn'
      return 'err'
    }

    /** Tone → colour. */
    function toneColor(tone) {
      if (tone === 'ok') return C.ok
      if (tone === 'warn') return C.warn
      if (tone === 'err') return C.err
      if (tone === 'accent') return C.accent
      return C.text3
    }

    /** Fraction of a whole, safe for 0. */
    function ratio(part, whole) {
      const top = Number(part) || 0
      const bottom = Number(whole) || 0
      if (bottom <= 0) return 0
      return Math.max(0, Math.min(1, top / bottom))
    }

    // ------------------------------------------------------------- elements

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        padding: '16px 20px 18px',
        background: C.base,
        color: C.text,
        fontSize: 13,
        lineHeight: 1.45,
        WebkitFontSmoothing: 'antialiased',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8 },
      title: { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.2 },
      subtitle: { fontSize: 12, color: C.text3 },
      headerMeta: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
      grid: { display: 'grid', gridTemplateColumns: '338px minmax(0, 1fr)', gap: 14, flex: 1, minHeight: 0 },
      left: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
      right: { minWidth: 0, minHeight: 0, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 },
      card: { background: C.layer1, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 12 },
      cardTight: { background: C.layer1, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 },
      sectionTitle: { fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: C.text3, margin: 0 },
      muted: { color: C.text3 },
      second: { color: C.text2 },
      mono: { fontFamily: C.mono, fontSize: 11.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2 },
      link: { color: C.accent, textDecoration: 'none', overflowWrap: 'anywhere' },
      pre: {
        margin: 0,
        fontFamily: C.mono,
        fontSize: 11.5,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: C.base,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: 8,
        padding: 10,
        maxHeight: 300,
        overflow: 'auto',
        color: C.text2,
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: C.base,
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 7,
        padding: '7px 9px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        outline: 'none',
      },
      select: {
        background: C.base,
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 7,
        padding: '6px 7px',
        fontSize: 12,
        fontFamily: 'inherit',
        outline: 'none',
      },
      button: {
        background: C.layer2,
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 7,
        padding: '6px 10px',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        background: C.fill,
        color: '#fff',
        border: `1px solid ${C.fill}`,
        borderRadius: 7,
        padding: '7px 12px',
        fontSize: 12.5,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      disabled: { opacity: 0.45, cursor: 'default' },
      barTrack: { position: 'relative', height: 6, borderRadius: 3, background: C.layer2, overflow: 'hidden', flex: 1, minWidth: 40 },
      barFill: { position: 'absolute', inset: 0, borderRadius: 3 },
    }

    /** Small rounded label. */
    function Chip(props) {
      const tone = props.tone ?? 'muted'
      const color = toneColor(tone)
      return h('span', {
        title: props.title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '1px 7px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 500,
          lineHeight: '16px',
          color,
          background: tone === 'muted' ? C.layer2 : 'transparent',
          border: `1px solid ${tone === 'muted' ? C.borderSoft : color}`,
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    /** Filled dot. */
    function Dot(props) {
      const color = toneColor(props.tone ?? 'muted')
      return h('span', {
        style: { width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0, boxShadow: `0 0 0 2px ${C.layer1}` },
      })
    }

    /** Section wrapper with a small caps heading. */
    function Section(props) {
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: S.spread },
          h('h3', { style: S.sectionTitle }, props.title),
          props.aside === undefined ? null : h('div', { style: S.row }, props.aside)),
        props.children)
    }

    /** One labelled number in a stat strip. */
    function Stat(props) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 56 }, title: props.title },
        h('span', { style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, props.value),
        h('span', { style: { fontSize: 10.5, color: C.text3, letterSpacing: 0.3, textTransform: 'uppercase' } }, props.label))
    }

    // ---------------------------------------------------------------- data

    /** Poll `/state` on mount and refetch on every ledger revision. */
    function useStudio() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${API}/state?limit=${RUN_LIMIT}`, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!body || body.ok !== true) throw new Error((body && body.error) || `state request failed (${response.status})`)
          setState(body.value)
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        let disposed = false
        void refresh()
        let source
        try {
          source = new EventSource(`${API}/events`)
          source.addEventListener('revision', () => { if (!disposed) void refresh() })
        } catch {
          // SSE unavailable: the refresh button and the first paint still work.
        }
        return () => {
          disposed = true
          if (source !== undefined) source.close()
        }
      }, [refresh])

      return { state, error, loading, refresh }
    }

    /** Re-render once a second while something is running (live elapsed). */
    function useTicker(active) {
      const [, setTick] = useState(0)
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [active])
    }

    // ------------------------------------------------------------ composer

    /** Run composer: search or fetch, straight into the ledger. */
    function Composer(props) {
      const [mode, setMode] = useState('search')
      const [text, setText] = useState('')
      const [maxResults, setMaxResults] = useState('8')
      const [intent, setIntent] = useState('auto')
      const [fetchMode, setFetchMode] = useState('read')
      const [maxChars, setMaxChars] = useState('')
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      async function submit() {
        const trimmed = text.trim()
        if (trimmed.length === 0 || busy) return
        setBusy(true)
        setFailure(null)
        try {
          const payload = mode === 'search'
            ? { mode: 'search', query: trimmed, maxResults: Number(maxResults) || 8, intent: intent === 'auto' ? undefined : intent }
            : {
              mode: 'fetch',
              urls: trimmed.split(/\s+/).filter(Boolean),
              fetchMode,
              maxChars: maxChars.trim().length > 0 ? Number(maxChars) : undefined,
            }
          const response = await fetch(`${API}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json()
          if (!body || body.ok !== true) throw new Error((body && body.error) || 'the run was rejected')
        } catch (cause) {
          setFailure(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void submit()
        }
      }

      const segment = (value, label) => h('button', {
        type: 'button',
        onClick: () => setMode(value),
        style: {
          flex: 1,
          background: mode === value ? C.layer2 : 'transparent',
          color: mode === value ? C.text : C.text3,
          border: `1px solid ${mode === value ? C.border : 'transparent'}`,
          borderRadius: 6,
          padding: '4px 0',
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
        },
      }, label)

      return h('div', { style: S.cardTight },
        h('div', { style: { display: 'flex', gap: 4, background: C.base, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: 3 } },
          segment('search', 'Search'),
          segment('fetch', 'Fetch')),
        h('input', {
          value: text,
          onChange: (event) => setText(event.target.value),
          onKeyDown,
          placeholder: mode === 'search' ? 'Query — Enter to search' : 'https://example.com/a https://example.com/b',
          style: S.input,
          spellCheck: false,
          'aria-label': mode === 'search' ? 'Search query' : 'Urls to fetch',
        }),
        mode === 'search'
          ? h('div', { style: { display: 'flex', gap: 6 } },
            h('label', { style: { ...S.row, flex: 1, ...S.muted, fontSize: 11.5 } },
              'results',
              h('input', {
                type: 'number',
                min: 1,
                max: 12,
                value: maxResults,
                onChange: (event) => setMaxResults(event.target.value),
                style: { ...S.select, width: 54 },
                'aria-label': 'Maximum results',
              })),
            h('label', { style: { ...S.row, flex: 1, ...S.muted, fontSize: 11.5 } },
              'intent',
              h('select', {
                value: intent,
                onChange: (event) => setIntent(event.target.value),
                style: S.select,
                'aria-label': 'Query intent',
              },
              ['auto', 'web', 'code', 'paper', 'news', 'entity'].map((value) => h('option', { key: value, value }, value)))))
          : h('div', { style: { display: 'flex', gap: 6 } },
            h('label', { style: { ...S.row, flex: 1, ...S.muted, fontSize: 11.5 } },
              'mode',
              h('select', {
                value: fetchMode,
                onChange: (event) => setFetchMode(event.target.value),
                style: S.select,
                'aria-label': 'Extraction mode',
              }, ['read', 'scan', 'deep'].map((value) => h('option', { key: value, value }, value)))),
            h('label', { style: { ...S.row, flex: 1, ...S.muted, fontSize: 11.5 } },
              'chars',
              h('input', {
                value: maxChars,
                onChange: (event) => setMaxChars(event.target.value.replace(/[^0-9]/g, '')),
                placeholder: 'auto',
                style: { ...S.select, width: 62, textAlign: 'right' },
                'aria-label': 'Character budget',
              }))),
        h('button', {
          type: 'button',
          onClick: () => void submit(),
          disabled: busy || text.trim().length === 0,
          style: { ...S.primary, ...(busy || text.trim().length === 0 ? S.disabled : {}) },
        }, busy ? 'Starting…' : mode === 'search' ? 'Run search' : 'Run fetch'),
        failure === null ? null : h('div', { style: { fontSize: 11.5, color: C.err } }, failure))
    }

    // ------------------------------------------------------------- run list

    /** One ledger row. */
    function RunRow(props) {
      const { run, selected, now, onSelect } = props
      const running = run.status === 'running'
      const elapsed = running ? Date.now() - (run.startedMs ?? Date.now()) : run.durationMs
      const tone = running ? 'accent' : run.status === 'ok' ? 'ok' : 'err'
      const detail = run.kind === 'search'
        ? `${run.results ? run.results.length : 0} result${(run.results ? run.results.length : 0) === 1 ? '' : 's'} · ${run.engines ? run.engines.length : 0} engine${(run.engines ? run.engines.length : 0) === 1 ? '' : 's'}`
        : `${run.pages ? run.pages.length : 0} page${(run.pages ? run.pages.length : 0) === 1 ? '' : 's'} · ${fmtInt(run.contentChars)} chars`

      return h('button', {
        type: 'button',
        onClick: () => onSelect(run.id),
        title: run.label,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          width: '100%',
          textAlign: 'left',
          background: selected ? C.layer2 : 'transparent',
          border: `1px solid ${selected ? C.border : 'transparent'}`,
          borderLeft: `2px solid ${selected ? toneColor(tone) : 'transparent'}`,
          borderRadius: 7,
          padding: '7px 8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: C.text,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' } },
        h(Dot, { tone }),
        h('span', {
          style: {
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12.5,
            fontWeight: selected ? 600 : 500,
          },
        }, run.label || run.id),
        h('span', { style: { fontSize: 11, color: running ? C.accent : C.text2, fontVariantNumeric: 'tabular-nums', flexShrink: 0 } },
          running ? `${fmtMs(elapsed)}…` : fmtMs(elapsed))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text3 } },
        h('span', { style: { textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10 } }, run.kind),
        h('span', { style: { opacity: 0.5 } }, '·'),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail),
        h('span', { style: { marginLeft: 'auto', flexShrink: 0 } }, run.source === 'ui' ? fmtClock(run.startedAt) : `${run.tool || 'agent'} · ${fmtAge(run.startedAt, now)}`)))
    }

    // -------------------------------------------------------------- details

    /** Engine latency chart + pipeline stages. */
    function TimingPanel(props) {
      const { run } = props
      const engines = [...(run.engines ?? [])].sort((a, b) => b.ms - a.ms || a.engine.localeCompare(b.engine))
      const maxMs = Math.max(1, ...engines.map((engine) => engine.ms))
      const slowest = engines.length > 0 ? engines[0] : null
      const sequential = engines.reduce((sum, engine) => sum + engine.ms, 0)
      const stages = run.stages ?? []

      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            h('span', { style: { fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3 } }, fmtMs(run.durationMs)),
            h('span', { style: { fontSize: 11.5, color: C.text3 } }, 'wall clock, process start to exit')),
          h('div', { style: S.row },
            run.internalMs > 0 ? h(Chip, { title: 'duration the binary reports in meta.elapsed_ms' }, `binary ${fmtMs(run.internalMs)}`) : null,
            run.overheadMs > 0 ? h(Chip, { title: 'spawn + stdout transport, outside the binary’s own clock' }, `overhead ${fmtMs(run.overheadMs)}`) : null,
            run.setup !== undefined && run.setup.ms > 0 ? h(Chip, { tone: 'warn', title: 'one-time runtime download and extraction, before the child process started' }, `setup ${fmtMs(run.setup.ms)}`) : null,
            engines.length > 1 ? h(Chip, { title: 'engines run concurrently; this is the sum, not the critical path' }, `serial sum ${fmtMs(sequential)}`) : null)),

        engines.length === 0
          ? h('div', { style: { ...S.muted, fontSize: 12 } }, 'No engine trace in the payload.')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 } },
            engines.map((engine) => {
              const tone = toneOf(engine.status)
              return h('div', { key: engine.engine, style: { display: 'grid', gridTemplateColumns: '92px 116px 1fr 74px', alignItems: 'center', gap: 8 } },
                h('span', { style: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' } }, engine.engine),
                h(Chip, { tone, title: engine.status }, engine.status),
                h('div', { style: S.barTrack },
                  h('div', {
                    style: {
                      ...S.barFill,
                      width: `${Math.max(engine.ms > 0 ? 1.5 : 0, ratio(engine.ms, maxMs) * 100)}%`,
                      background: toneColor(tone),
                      opacity: engine.hits === 0 && tone === 'ok' ? 0.45 : 1,
                    },
                  })),
                h('span', { style: { fontSize: 11, color: C.text2, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
                  `${engine.ms} ms${engine.hits > 0 ? ` · ${engine.hits}h` : ''}`))
            }),
            h('div', { style: { fontSize: 10.5, color: C.text3, marginTop: 2 } },
              slowest === null ? '' : `bar scale: 0 – ${maxMs} ms · h = hits that engine returned · engines run in parallel`)),

        stages.length > 0
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 10.5, color: C.text3, textTransform: 'uppercase', letterSpacing: 0.5 } }, 'after the engines'),
            stages.map((stage) => h(Chip, { key: stage.name, tone: 'muted', title: `meta.stage_ms.${stage.name}` }, `${stage.name} ${stage.ms} ms`)))
          : null)
    }

    /** One search result: what it is, where it came from, who corroborated it. */
    function ResultCard(props) {
      const { result } = props
      return h('div', { style: { border: `1px solid ${C.borderSoft}`, borderRadius: 9, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 5, background: C.layer1 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: { fontSize: 11, color: C.text3, fontVariantNumeric: 'tabular-nums', flexShrink: 0 } }, String(result.rank).padStart(2, '0')),
          h('a', {
            href: result.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            style: { ...S.link, fontSize: 12.8, fontWeight: 600 },
            title: result.url,
          }, result.title || result.url),
          h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: C.text3, flexShrink: 0 } }, result.domain)),
        result.snippet ? h('div', {
          style: {
            fontSize: 12,
            color: C.text2,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          },
        }, result.snippet) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h(Chip, { tone: 'muted', title: 'donsetch ranking score' }, `score ${Number(result.score).toFixed(2)}`),
          result.consensus > 1
            ? h(Chip, { tone: 'ok', title: 'how many engines returned this url' }, `corroborated ×${result.consensus}`)
            : h(Chip, { tone: 'muted', title: 'only one engine returned this url' }, 'single source'),
          ...(result.engines ?? []).map((engine) => h(Chip, { key: engine, tone: 'accent', title: `returned by ${engine}` }, engine))))
    }

    /** Full search trace. */
    function SearchDetail(props) {
      const { run } = props
      const [showPayload, setShowPayload] = useState(false)
      const answered = (run.engines ?? []).filter((engine) => engine.status === 'ok').length
      const blocked = (run.engines ?? []).filter((engine) => String(engine.status).startsWith('blocked')).length
      const corroborated = (run.results ?? []).filter((result) => result.consensus > 1).length

      return h(React.Fragment, null,
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650, lineHeight: 1.3, overflowWrap: 'anywhere' } }, run.label),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                h(Chip, { tone: run.status === 'ok' ? 'ok' : run.status === 'running' ? 'accent' : 'err' }, run.status),
                run.intent ? h(Chip, { tone: 'muted' }, String(run.intent).toLowerCase()) : null,
                run.cached ? h(Chip, { tone: 'warn', title: 'no network call: the binary served a cached result set' }, 'cached') : null,
                run.degraded ? h(Chip, { tone: 'warn' }, `degraded · ${run.returned}/${run.requested}`) : null,
                run.weak ? h(Chip, { tone: 'warn' }, 'weak') : null,
                h(Chip, { tone: 'muted', title: 'who started this run' }, run.source === 'ui' ? 'panel' : (run.tool || 'agent'))),
              h('div', { style: { display: 'flex', gap: 18, marginTop: 10, flexWrap: 'wrap' } },
                h(Stat, { label: 'results', value: String((run.results ?? []).length) }),
                h(Stat, { label: 'engines ok', value: `${answered}/${(run.engines ?? []).length}` }),
                h(Stat, { label: 'corroborated', value: String(corroborated) }),
                h(Stat, { label: 'blocked', value: String(blocked) }),
                h(Stat, { label: 'run time', value: fmtMs(run.durationMs) }))),
          h('div', { style: { textAlign: 'right', flexShrink: 0 } },
            h('div', { style: { fontSize: 11, color: C.text3 } }, fmtClock(run.startedAt)),
            h('div', { style: { fontSize: 10.5, color: C.text3, fontFamily: C.mono } }, run.id)))),

        run.status === 'running' ? h('div', { style: { ...S.card, color: C.accent, fontSize: 12 } }, 'searching — the ledger updates when the process exits') : null,
        run.error ? h('div', { style: { ...S.card, borderColor: C.err, color: C.err, fontSize: 12 } }, run.error) : null,

        h(TimingPanel, { run }),

        h(Section, { title: `Results — ${(run.results ?? []).length}${run.requested ? ` of ${run.requested} requested` : ''}` },
          (run.results ?? []).length === 0
            ? h('div', { style: { ...S.card, ...S.muted, fontSize: 12 } }, run.status === 'running' ? 'Waiting for results.' : 'No result survived filtering.')
            : (run.results ?? []).map((result) => h(ResultCard, { key: `${result.rank}-${result.url}`, result }))),

        (run.notes ?? []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            (run.notes ?? []).map((note, index) => h('div', { key: index, style: { fontSize: 11.5, color: C.text3 } }, `— ${note}`)))
          : null,

        h(Section, {
          title: 'What the search returned',
          aside: h('button', {
            type: 'button',
            onClick: () => setShowPayload((value) => !value),
            style: S.button,
          }, showPayload ? 'Hide markdown' : 'Show markdown'),
        },
        showPayload
          ? h('pre', { style: S.pre }, run.content && run.content.length > 0 ? run.content : '(empty payload)')
          : h('div', { style: { fontSize: 11.5, color: C.text3 } }, `donsetch returned ${fmtInt(run.contentChars)} characters of markdown, delivered to the agent as structured results.`)),

        h(RunFooter, { run }))
    }

    /** One fetched page: what was extracted, and how it got there. */
    function PageCard(props) {
      const { page, index } = props
      const [expanded, setExpanded] = useState(false)
      const content = String(page.content ?? '')
      const visible = expanded ? content : content.slice(0, CONTENT_PREVIEW)
      const tone = page.ok ? 'ok' : 'err'
      return h('div', { style: { border: `1px solid ${page.ok ? C.borderSoft : C.err}`, borderRadius: 9, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7, background: C.layer1 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 11, color: C.text3 } }, String(index + 1).padStart(2, '0')),
          h('a', { href: page.url, target: '_blank', rel: 'noreferrer noopener', style: { ...S.link, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, page.url),
          h('span', { style: { marginLeft: 'auto' } }, h(Chip, { tone, title: page.code || page.readStatus }, page.ok ? 'extracted' : (page.code || page.readStatus || 'failed')))),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          h(Stat, { label: 'chars', value: fmtInt(page.chars) }),
          h(Stat, { label: 'words', value: fmtInt(page.words) }),
          h(Stat, { label: 'complete', value: page.complete ? 'yes' : 'no', title: page.complete ? 'the whole page fit in the char budget' : 'the char budget truncated the page' }),
          page.lang ? h(Stat, { label: 'lang', value: page.lang }) : null,
          page.contentKind ? h(Stat, { label: 'kind', value: page.contentKind }) : null,
          page.status !== undefined ? h(Stat, { label: 'http', value: String(page.status) }) : null),
        (page.escalation ?? []).length > 0
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', fontSize: 11, color: C.text3 } },
            'route:',
            (page.escalation ?? []).map((step, stepIndex) => h(Chip, {
              key: stepIndex,
              tone: 'muted',
              title: `${step.tier} · ${step.outcome} · ${step.ms} ms`,
            }, `${step.action || step.tier}${step.outcome ? ` (${step.outcome})` : ''}`)))
          : null,
        page.fetchError || page.code
          ? h('div', { style: { fontSize: 11.5, color: C.err } }, [page.code, page.errorKind, page.fetchError, page.nextAction].filter(Boolean).join(' · '))
          : null,
        content.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: S.spread },
              h('span', { style: { fontSize: 10.5, color: C.text3, textTransform: 'uppercase', letterSpacing: 0.5 } }, 'extracted markdown'),
              h('div', { style: S.row },
                h('span', { style: { fontSize: 11, color: C.text3 } }, `${fmtInt(visible.length)} of ${fmtInt(content.length)}`),
                content.length > CONTENT_PREVIEW
                  ? h('button', { type: 'button', onClick: () => setExpanded((value) => !value), style: S.button }, expanded ? 'Collapse' : 'Show all')
                  : null)),
            h('pre', { style: { ...S.pre, maxHeight: expanded ? 420 : 190 } }, visible))
          : null)
    }

    /** Full fetch trace. */
    function FetchDetail(props) {
      const { run } = props
      const pages = run.pages ?? []
      const okPages = pages.filter((page) => page.ok)
      const chars = okPages.reduce((sum, page) => sum + (page.chars || 0), 0)
      const words = okPages.reduce((sum, page) => sum + (page.words || 0), 0)

      return h(React.Fragment, null,
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650, overflowWrap: 'anywhere' } }, run.label),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                h(Chip, { tone: run.status === 'ok' ? 'ok' : run.status === 'running' ? 'accent' : 'err' }, run.status),
                run.input && run.input.mode ? h(Chip, { tone: 'muted', title: 'extraction mode' }, run.input.mode) : null,
                run.input && run.input.maxChars ? h(Chip, { tone: 'muted' }, `budget ${fmtInt(run.input.maxChars)} chars`) : null,
                h(Chip, { tone: 'muted' }, run.source === 'ui' ? 'panel' : (run.tool || 'agent'))),
              h('div', { style: { display: 'flex', gap: 18, marginTop: 10, flexWrap: 'wrap' } },
                h(Stat, { label: 'pages ok', value: `${okPages.length}/${pages.length}` }),
                h(Stat, { label: 'chars taken', value: fmtInt(chars) }),
                h(Stat, { label: 'words', value: fmtInt(words) }),
                h(Stat, { label: 'run time', value: fmtMs(run.durationMs) }))),
            h('div', { style: { textAlign: 'right', flexShrink: 0 } },
              h('div', { style: { fontSize: 11, color: C.text3 } }, fmtClock(run.startedAt)),
              h('div', { style: { fontSize: 10.5, color: C.text3, fontFamily: C.mono } }, run.id)))),
        run.status === 'running' ? h('div', { style: { ...S.card, color: C.accent, fontSize: 12 } }, 'fetching — the ledger updates when the process exits') : null,
        run.error ? h('div', { style: { ...S.card, borderColor: C.err, color: C.err, fontSize: 12 } }, run.error) : null,

        h(Section, { title: 'Timing' },
          h('div', { style: S.card },
            h('div', { style: S.spread },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
                h('span', { style: { fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums' } }, fmtMs(run.durationMs)),
                h('span', { style: { fontSize: 11.5, color: C.text3 } }, `${pages.length} url(s) in one process`)),
              h('div', { style: S.row },
                run.overheadMs > 0 ? h(Chip, { tone: 'muted' }, `overhead ${fmtMs(run.overheadMs)}`) : null,
                h(Chip, { tone: 'muted' }, `exit ${run.exitCode === null ? '—' : run.exitCode}`))))),

        h(Section, { title: `Pages — ${pages.length}` },
          pages.length === 0
            ? h('div', { style: { ...S.card, ...S.muted, fontSize: 12 } }, run.status === 'running' ? 'Waiting for the extraction.' : 'No page payload.')
            : pages.map((page, index) => h(PageCard, { key: `${index}-${page.url}`, page, index }))),

        (run.notes ?? []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            (run.notes ?? []).map((note, index) => h('div', { key: index, style: { fontSize: 11.5, color: C.text3 } }, `— ${note}`)))
          : null,

        h(RunFooter, { run }))
    }

    /** Process facts shared by both detail views. */
    function RunFooter(props) {
      const { run } = props
      const [showStderr, setShowStderr] = useState(false)
      const stderr = run.stderr ?? []
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2, paddingBottom: 8 } },
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: C.text3, fontFamily: C.mono } },
          h('span', null, run.id),
          h('span', null, `exit ${run.exitCode === null ? '—' : run.exitCode}`),
          h('span', null, `started ${fmtClock(run.startedAt)}`),
          run.endedAt ? h('span', null, `ended ${fmtClock(run.endedAt)}`) : null,
          run.timedOut ? h('span', { style: { color: C.err } }, 'timed out') : null),
        stderr.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h('button', { type: 'button', onClick: () => setShowStderr((value) => !value), style: { ...S.button, alignSelf: 'flex-start' } },
              showStderr ? 'Hide stderr' : `Show stderr (${stderr.length})`),
            showStderr ? h('pre', { style: { ...S.pre, maxHeight: 180, color: C.text3 } }, stderr.join('\n')) : null)
          : null)
    }

    /** Empty ledger: say what the page is for. */
    function EmptyState(props) {
      return h('div', { style: { ...S.card, display: 'flex', flexDirection: 'column', gap: 10, padding: 18 } },
        h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, 'No donsetch runs yet'),
        h('p', { style: { margin: 0, fontSize: 12.5, color: C.text2 } },
          'Every web search and page fetch this agent makes through donsetch is recorded here: the query, each engine that answered and how long it took, every result with the engines that returned it, and exactly how much of each fetched page was extracted.'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: C.text3 } },
          h('div', null, '— Start a search above, or ask the agent to use donsetch_search.'),
          h('div', null, '— donsetch_fetch records one entry per url with the extraction budget it spent.'),
          h('div', null, '— Runs started by the agent and by this panel land in the same list.')),
        props.error === null ? null : h('div', { style: { fontSize: 12, color: C.err } }, props.error))
    }

    // ----------------------------------------------------------------- panel

    /** Header summary: binary state and lifetime totals. */
    function Header(props) {
      const { state, error, loading, refresh } = props
      const stats = state ? state.stats : null
      const probe = state ? state.probe : null
      const runtime = state ? state.runtime : null
      const setup = state ? state.setup : null
      const storage = state ? state.storage : null
      const [confirming, setConfirming] = useState(false)

      useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])

      async function clearLedger() {
        if (!confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        try {
          await fetch(`${API}/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          await refresh()
        } catch {
          // The next revision event will resync the list.
        }
      }

      const probeTone = probe === null || probe === undefined || !probe.checked ? 'muted' : probe.ok ? 'ok' : 'err'
      const probeLabel = probe === null || probe === undefined || !probe.checked
        ? 'donsetch probe pending'
        : probe.ok ? (probe.version || 'donsetch ready') : 'donsetch unavailable'
      const busy = setup !== null && setup !== undefined && (setup.phase === 'download' || setup.phase === 'extract')
      const runtimeChip = runtime === null || runtime === undefined
        ? null
        : busy
          ? h(Chip, { tone: 'warn', title: setup.asset ?? setup.phase },
            setup.phase === 'download' ? 'downloading runtime…' : 'extracting runtime…')
          : runtime.source === 'download-needed'
            ? h(Chip, { tone: 'warn', title: `downloads once into ${runtime.home}` }, `runtime ${runtime.version} · downloads on first use`)
            : h(Chip, { tone: 'muted', title: runtime.binary ?? runtime.home }, `runtime ${runtime.version ?? ''} · ${runtime.source}`)

      return h('header', { style: S.header },
        h('div', null,
          h('div', { style: S.titleRow },
            h('h1', { style: S.title }, 'donsetch studio'),
            h('span', { style: S.subtitle }, 'keyless web search · per-engine traces')),
          h('div', { style: { ...S.row, marginTop: 3 } },
            h(Chip, { tone: probeTone, title: probe && probe.path ? probe.path : undefined }, probeLabel),
            runtimeChip,
            stats === null ? null : h('span', { style: { fontSize: 11.5, color: C.text3 } },
              `${stats.searches} search${stats.searches === 1 ? '' : 'es'} · ${stats.fetches} fetch${stats.fetches === 1 ? '' : 'es'}${stats.avgSearchMs > 0 ? ` · avg ${fmtMs(stats.avgSearchMs)}` : ''}`),
            storage === null ? null : h('span', {
              style: { fontSize: 11.5, color: C.text3 },
              title: `${state.ledgerPath} · ${fmtInt(storage.bytes)} bytes on disk`,
            }, fmtStorage(storage)))),
        h('div', { style: S.headerMeta },
          error === null ? null : h(Chip, { tone: 'err', title: error }, 'bridge error'),
          loading ? h('span', { style: { fontSize: 11.5, color: C.text3 } }, 'loading…') : null,
          h('button', {
            type: 'button',
            onClick: () => void refresh(),
            style: S.button,
            title: 'Re-read the ledger',
          }, 'Refresh'),
          h('button', {
            type: 'button',
            onClick: () => void clearLedger(),
            style: { ...S.button, color: confirming ? C.err : C.text, borderColor: confirming ? C.err : C.border },
            disabled: stats === null || stats.runs === 0,
            title: 'Delete the recorded history for this profile',
          }, confirming ? 'Confirm clear' : 'Clear')))
    }

    /** The page registered into the `main` slot. */
    function Panel() {
      const { state, error, loading, refresh } = useStudio()
      const [selectedId, setSelectedId] = useState(null)
      const runs = state ? state.runs : []
      const anyRunning = runs.some((run) => run.status === 'running')
      useTicker(anyRunning)

      useEffect(() => {
        if (runs.length === 0) {
          if (selectedId !== null) setSelectedId(null)
          return
        }
        if (selectedId === null || !runs.some((run) => run.id === selectedId)) setSelectedId(runs[0].id)
      }, [runs, selectedId])

      const selected = runs.find((run) => run.id === selectedId) || runs[0] || null
      const now = Date.now()

      let detail
      if (selected === null) detail = h(EmptyState, { error })
      else if (selected.kind === 'search') detail = h(SearchDetail, { key: selected.id, run: selected })
      else detail = h(FetchDetail, { key: selected.id, run: selected })

      return h('div', { style: S.root },
        h(Header, { state, error, loading, refresh }),
        h('div', { style: S.grid },
          h('aside', { style: S.left },
            h(Composer, null),
            h('div', { style: { ...S.spread, padding: '0 2px' } },
              h('span', { style: S.sectionTitle }, `Runs — ${state ? state.total : 0}`),
              h('span', { style: { fontSize: 10.5, color: C.text3 } }, 'newest first')),
            h('div', { style: S.list },
              runs.length === 0
                ? h('div', { style: { fontSize: 12, color: C.text3, padding: '8px 4px' } }, 'Nothing recorded yet.')
                : runs.map((run) => h(RunRow, {
                  key: run.id,
                  run,
                  selected: selected !== null && run.id === selected.id,
                  now,
                  onSelect: setSelectedId,
                })))),
          h('main', { style: S.right }, detail)))
    }

    /** Sidebar icon. */
    function Icon(props) {
      const size = props && props.size ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: 6.6, cy: 6.6, r: 4.1 }),
      h('path', { d: 'M9.7 9.7 L13.6 13.6' }),
      h('path', { d: 'M4.6 8.4 V7', opacity: 0.85 }),
      h('path', { d: 'M6.6 8.4 V5.4', opacity: 0.85 }),
      h('path', { d: 'M8.6 8.4 V6.4', opacity: 0.85 }))
    }

    /** Mount into the shell: central panel + sidebar entry. */
    function apply(ctx) {
      ctx.effect(() => {
        const disposers = [
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)),
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 11,
            label: () => 'donsetch studio',
          }, Icon)),
        ]
        return () => {
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              // Slot teardown is best effort.
            }
          }
        }
      }, 'donsetch-studio: panel')
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
