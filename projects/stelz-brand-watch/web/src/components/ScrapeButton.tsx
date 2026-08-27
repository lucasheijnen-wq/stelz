// The "Opnieuw scrapen" button — dev dashboard only.
//
// Scraping lives on this machine: the harvesters are local Python, the data
// lands in .tmp/, and the event pages read it as fixtures. This button is the
// handle on that pipeline. It POSTs to the dev server's /scrape-run/<event>
// endpoint (vite.config.ts, serve-only plugin), which starts
// tools/stelz_brand_watch/79_verversronde.sh detached, then polls
// /scrape-status/<event> until the round ends. In a production build none of
// this exists: the render site is gated on an inline `import.meta.env.DEV`,
// and the endpoints are serve-only middleware.
//
// THE ROUND NOW ENDS IN PRODUCTION. Step 13 is 78_upload_event.py, which pushes
// the harvest into the same Firestore collections the live pipeline writes, so
// a scrape here changes the online dashboard too. That endpoint is member-gated,
// and this button is what supplies the credentials: the browser is already
// signed in, so its REFRESH token rides along with the start request and the
// upload step exchanges it for a fresh ID token an hour later if it has to.
// Signed out, the round still runs — it just stays on this machine, and the
// caption says so up front rather than after fifty minutes of scraping.
//
// THE ONE RULE, learned from the first user test: a broken round must never
// look like a successful one. The runner script deliberately keeps going after
// a failed step, so "the process exited" proves nothing — this component reads
// `exitOk` and `failedSteps` from the status and only reloads the page over a
// clean round. Anything else stays on screen, in red, with the log to hand.
//
// Costs per round: scraping ≈ $0.45 (stories + roster-IG; TikTok and
// discovery are free). The analysis bill depends on the harvest: near zero on
// a quiet week, a few dollars after a busy festival day. Duration 10 minutes
// to an hour, for the same reason.

import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { fbApp, fbAuth } from '../lib/firebase'

type ScrapeStatus = {
  running: boolean
  stale: boolean
  exitOk: boolean | null
  failedSteps: number
  newItems: number | null
  currentStep: { index: number; total: number; label: string } | null
  lastLine: string | null
  logTail: string[]
  fixtureMtime: number | null
}

const POLL_MS = 5000
/** Carries the yield of a clean round across the reload that shows it. */
const RESULT_KEY = 'stelz-scrape-result'

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('nl-NL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export function ScrapeButton({ eventId }: { eventId: string }) {
  const [status, setStatus] = useState<ScrapeStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The status a round WE watched ended on, when it did not end cleanly. */
  const [failedRun, setFailedRun] = useState<ScrapeStatus | null>(null)
  const [stopped, setStopped] = useState(false)
  /** Null until a round is started here; false = it will not reach production. */
  const [authed, setAuthed] = useState<boolean | null>(null)
  // Poll generation: bumped after a successful start so the effect re-arms.
  const [gen, setGen] = useState(0)
  // Only the tab that pressed the button reloads itself when the round ends —
  // a tab that merely watched someone else's round must not yank the page.
  const startedHere = useRef(false)
  // True while we believe a round is underway; a failed poll re-arms the timer
  // only then, so an idle tab does not poll a broken server forever.
  const activeRef = useRef(false)
  // The yield of the previous round, read back after its reload.
  const [lastResult] = useState<{ newItems: number | null } | null>(() => {
    try {
      const raw = sessionStorage.getItem(RESULT_KEY)
      if (!raw) return null
      sessionStorage.removeItem(RESULT_KEY)
      return JSON.parse(raw) as { newItems: number | null }
    } catch { return null }
  })

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    let timer: number | undefined
    const again = () => { timer = window.setTimeout(() => { void poll() }, POLL_MS) }
    const poll = async () => {
      try {
        const r = await fetch(`/scrape-status/${eventId}`)
        if (cancelled) return
        if (!r.ok) {
          // One bad response must not kill the loop — that bug froze the
          // button on "Scrape loopt…" until a manual refresh.
          if (activeRef.current) again()
          return
        }
        const s = (await r.json()) as ScrapeStatus
        if (cancelled) return
        if (s.running) {
          activeRef.current = true
          setStatus(s)
          again()
          return
        }
        // The round just ended under our eyes.
        if (activeRef.current && startedHere.current) {
          activeRef.current = false
          startedHere.current = false
          if (s.exitOk && s.failedSteps === 0) {
            try {
              sessionStorage.setItem(RESULT_KEY, JSON.stringify({ newItems: s.newItems }))
            } catch { /* opslag vol/uit — de reload toont dan alleen de data */ }
            window.location.reload()
            return
          }
          setFailedRun(s)
        }
        activeRef.current = false
        setStatus(s)
      } catch {
        if (!cancelled && activeRef.current) again()
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
    setFailedRun(null)
    setStopped(false)
    setAuthed(null)
    try {
      // The upload step's credentials. A REFRESH token, because the round can
      // take an hour and an ID token cannot — see scrape-runner.authPath. The
      // apiKey travels with it so the tool has one source for it rather than a
      // second hard-coded copy that can drift from lib/firebase.
      const user = fbAuth.currentUser
      const r = await fetch(`/scrape-run/${eventId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user
          ? { refreshToken: user.refreshToken, apiKey: fbApp.options.apiKey }
          : {}),
      })
      if (r.status === 409) {
        // A round is already underway — watch it instead of sulking about it.
        startedHere.current = true
        activeRef.current = true
        setGen((g) => g + 1)
      } else if (!r.ok) {
        setError(`Starten mislukte (HTTP ${r.status}).`)
      } else {
        const body = (await r.json().catch(() => ({}))) as { authed?: boolean }
        setAuthed(body.authed === true)
        startedHere.current = true
        activeRef.current = true
        setGen((g) => g + 1)
      }
    } catch {
      setError('Dev-server niet bereikbaar.')
    }
    setStarting(false)
  }

  const stop = async () => {
    try {
      await fetch(`/scrape-stop/${eventId}`, { method: 'POST' })
      startedHere.current = false
      activeRef.current = false
      setAuthed(null)
      setStopped(true)
      setGen((g) => g + 1)
    } catch { /* status-poll laat vanzelf zien of het lukte */ }
  }

  const progress = status?.currentStep
  const caption = error
    ? error
    : busy
      ? progress
        ? `Stap ${progress.index}/${progress.total} — ${progress.label}`
          + (status?.newItems != null ? ` · +${status.newItems} nieuw tot nu` : '')
        : 'Scrape loopt — de pagina ververst vanzelf als hij klaar is'
      : stopped
        ? 'Gestopt. Ververs de pagina voor de tussenstand.'
        : failedRun
          ? `Ronde eindigde met ${failedRun.failedSteps > 0
              ? `${failedRun.failedSteps} gefaalde stap${failedRun.failedSteps === 1 ? '' : 'pen'}`
              : 'een fout'}`
          : lastResult
            ? `Ronde klaar${lastResult.newItems != null ? `: +${lastResult.newItems} nieuw` : ''}`
            : status?.stale
              ? `Vorige ronde niet afgemaakt: "${status.lastLine ?? '?'}"`
              : status?.fixtureMtime
                ? `Laatste scrape: ${fmtWhen(status.fixtureMtime)}`
                : 'Nog nooit gescraped op deze computer'

  const warnTone = Boolean(error || failedRun || status?.stale || authed === false)

  return (
    <span className="inline-flex flex-col items-end gap-0.5 max-w-[340px]">
      <span className="inline-flex items-center gap-1.5">
        {busy && (
          <Button size="sm" variant="ghost" onClick={() => { void stop() }}
            title="Breekt de lopende ronde af. Wat al opgehaald is, blijft bewaard.">
            Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => { void start() }}
          title={'Draait de lokale pijplijn: stories, TikTok, Instagram en discovery, '
            + 'daarna de analyse, en uploadt het resultaat naar de online database. '
            + 'Scrapen ≈ $0,45; de analyse kost alleen iets bij nieuwe posts (na een '
            + 'druk festivalweekend een paar dollar). Duurt 10 minuten tot een uur.'
            + (fbAuth.currentUser ? '' : ' Je bent niet ingelogd: deze ronde blijft lokaal.')}
        >
          {starting ? 'Starten…' : status?.running ? 'Scrape loopt…' : 'Opnieuw scrapen'}
        </Button>
      </span>
      <span className={`text-[10px] text-right ${warnTone ? 'text-[var(--color-warn)]' : 'text-[var(--color-ink-subtle)]'}`}>
        {caption}
        {/* Said WHILE it runs, not after. A round is ten minutes to an hour;
            finding out at the end that none of it left this machine is the
            expensive way to learn you were signed out. */}
        {authed === false && busy && (
          <> — niet ingelogd, dus deze ronde blijft lokaal</>
        )}
        {failedRun && (
          <>
            {' — '}
            <a href="" className="underline">ververs voor de tussenstand</a>
          </>
        )}
      </span>
      {failedRun && failedRun.logTail.length > 0 && (
        <details className="text-[10px] text-[var(--color-ink-subtle)] max-w-full">
          <summary className="cursor-pointer">logdetails (.tmp/scrape-{eventId}.log)</summary>
          <pre className="mt-1 p-2 bg-[var(--color-surface-2)] text-left overflow-x-auto leading-relaxed">
            {failedRun.logTail.join('\n')}
          </pre>
        </details>
      )}
    </span>
  )
}
