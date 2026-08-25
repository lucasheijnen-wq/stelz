// The "Opnieuw scrapen" button — dev dashboard only.
//
// Scraping lives on this machine: the harvesters are local Python, the data
// lands in .tmp/, and the event pages read it as fixtures. This button is the
// missing handle on that pipeline. It POSTs to the dev server's
// /scrape-run/<event> endpoint (vite.config.ts, serve-only plugin), which
// starts tools/stelz_brand_watch/79_verversronde.sh detached, then polls
// /scrape-status/<event> until the round ends and reloads the page so the
// fresh fixtures show. In a production build none of this exists: the render
// site is gated on an inline `import.meta.env.DEV`, and the endpoints are
// serve-only middleware.
//
// One round ≈ $0.60 Apify (stories + roster-IG; TikTok and discovery are
// free) plus Gemini on genuinely new posts only — dedupe makes repeat scrapes
// incremental. The 409 path exists because two concurrent rounds would bill
// twice and overwrite each other's fixtures.

import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'

type ScrapeStatus = {
  running: boolean
  stale: boolean
  exitOk: boolean | null
  logTail: string[]
  fixtureMtime: number | null
}

const POLL_MS = 5000

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('nl-NL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export function ScrapeButton({ eventId }: { eventId: string }) {
  const [status, setStatus] = useState<ScrapeStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Poll generation: bumped after a successful start so the effect re-arms.
  const [gen, setGen] = useState(0)
  // Only the tab that pressed the button reloads itself when the round ends —
  // a tab that merely watched someone else's round must not yank the page.
  const startedHere = useRef(false)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const r = await fetch(`/scrape-status/${eventId}`)
        if (!r.ok || cancelled) return
        const s = (await r.json()) as ScrapeStatus
        if (cancelled) return
        if (!s.running && startedHere.current) {
          window.location.reload()
          return
        }
        setStatus(s)
        if (s.running) timer = window.setTimeout(() => { void poll() }, POLL_MS)
      } catch {
        // Dev server unreachable — leave the button in its last known state.
      }
    }
    void poll()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [eventId, gen])

  if (!import.meta.env.DEV) return null

  const busy = starting || (status?.running ?? false)

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const r = await fetch(`/scrape-run/${eventId}`, { method: 'POST' })
      if (r.status === 409) {
        setError('Er loopt al een ronde — even wachten.')
      } else if (!r.ok) {
        setError(`Starten mislukte (HTTP ${r.status}).`)
      } else {
        startedHere.current = true
        setGen((g) => g + 1)
      }
    } catch {
      setError('Dev-server niet bereikbaar.')
    }
    setStarting(false)
  }

  const caption = error
    ? error
    : busy
      ? 'Scrape loopt — 10 à 20 min; de pagina ververst vanzelf'
      : status?.stale
        ? `Vorige ronde niet afgemaakt — log: .tmp/scrape-${eventId}.log`
        : status?.fixtureMtime
          ? `Laatste scrape: ${fmtWhen(status.fixtureMtime)}`
          : 'Nog nooit gescraped op deze computer'

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => { void start() }}
        title={'Draait de lokale pijplijn: stories, TikTok, Instagram en discovery, '
          + 'daarna de analyse en de tellers. Circa $0,60 per ronde; alleen nieuwe '
          + 'posts kosten analyse.'}
      >
        {starting ? 'Starten…' : status?.running ? 'Scrape loopt…' : 'Opnieuw scrapen'}
      </Button>
      <span className={`text-[10px] ${error ? 'text-[var(--color-warn)]' : 'text-[var(--color-ink-subtle)]'}`}>
        {caption}
      </span>
    </span>
  )
}
