// Stories, at the top, because they are the thing that disappears.
//
// Everything else in this tool can be looked at tomorrow. A story cannot: it is
// gone 24 hours after it was posted, and for a festival roster that is the
// whole window. So stories do not live inside a tab — they sit above the tabs,
// on every view, and they lead with what is still live.
//
// Three states this must tell apart, because an empty strip means something
// different in each and the client is reading over your shoulder:
//   - never fetched          → nothing has ever looked
//   - fetched, nothing live  → normal; most creators have no story right now
//   - fetched, skipped       → budget or roster gate stopped it
// The last-run stamp on the brand doc is what makes that distinguishable; the
// 6-hourly scheduler runs outside any scan session and writes no step state.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from './ui'
import { MediaTile } from './MediaTile'
import { expiryAt, splitByExpiry, storyChip } from '../lib/stories'
import { isStelzStory, storyImage, VERDICT_LABEL, type StoryRow } from '../lib/storyStats'
import { compactNum, timeAgo } from '../lib/format'
import type { StoriesState } from '../lib/firestore'

/** How many fit before the row asks you to scroll. */
const SHOWN = 24

export function StoriesStrip({
  rows,
  state,
  onOpen,
  onFetch,
  fetching = false,
  canWrite = true,
  error = null,
  preview = false,
  storiesHref = '/stories',
}: {
  rows: StoryRow[]
  state: StoriesState | null
  /** Optional: opens the story panel. Every tile opens, analysed or not — for
   *  an unjudged story "nothing looked at this yet" is the thing to show. */
  onOpen?: (row: StoryRow) => void
  onFetch?: () => void
  fetching?: boolean
  /** Read-only viewers see the strip but not the fetch button. */
  canWrite?: boolean
  /** Failure from the last manual fetch, shown where the button was clicked. */
  error?: string | null
  /** Rows came from a local fixture, not Firestore. Must be stated, not implied. */
  preview?: boolean
  /** Where "alle stories" goes. A campaign passes its own scoped link so the
   *  full page opens on the same set the strip was showing.
   *
   *  The default stays '/stories' on purpose even though that route now
   *  redirects: it is the one festival-agnostic name for this surface, and
   *  ABSORBED_ROUTES sends it to the default event's Stories tab. Hard-coding
   *  '/evenementen/lowlands-2026' here would put one festival's name back into
   *  a generic component, which is the thing that route removal just undid. */
  storiesHref?: string
}) {
  const [onlyHits, setOnlyHits] = useState(false)
  const feed = splitByExpiry(rows)
  const hits = feed.all.filter((r) => isStelzStory(r.verdict))
  const judged = feed.all.filter((r) => r.verdict !== 'unanalysed').length
  const shown = (onlyHits ? hits : feed.all).slice(0, SHOWN)

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-[13px] font-medium">Stories</h2>

        <span className="text-[12px] text-[var(--color-ink-muted)] tabular-nums">
          {feed.active.length > 0 && (
            <span className="text-[var(--color-accent)] font-medium">{feed.active.length} live</span>
          )}
          {feed.active.length > 0 && feed.expired.length > 0 && ' · '}
          {feed.expired.length > 0 && `${feed.expired.length} verlopen`}
          {/* "0 × Stëlz" is only meaningful once something looked, so the
              count of judged stories carries it. Saying nothing here made a
              swept-and-analysed roster look identical to an untouched one. */}
          {feed.all.length > 0 && judged > 0 && (
            hits.length > 0
              ? <span className="text-[var(--color-good)]"> · {hits.length}× Stëlz</span>
              : <span> · {judged} beoordeeld, geen Stëlz</span>
          )}
        </span>

        {hits.length > 0 && feed.all.length > hits.length && (
          <button
            onClick={() => setOnlyHits((v) => !v)}
            className={`text-[11px] px-2 py-0.5 border transition-colors ${
              onlyHits
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            Alleen met Stëlz
          </button>
        )}

        <span className="ml-auto flex items-center gap-3 text-[11px] text-[var(--color-ink-subtle)]">
          {!preview && <LastRun state={state} />}
          <Link to={storiesHref} className="hover:text-[var(--color-ink)] hover:underline">
            alle stories →
          </Link>
          {canWrite && onFetch && (
            <button
              onClick={onFetch}
              disabled={fetching}
              className="text-[11px] px-2.5 py-1 border border-[var(--color-border)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50 transition-colors"
            >
              {fetching ? 'Ophalen…' : 'Nu ophalen'}
            </button>
          )}
        </span>
      </div>

      {/* Never let preview data pass for live data. */}
      {preview && (
        <p className="px-4 py-2.5 text-[12px] text-[var(--color-warn)] border-b border-[var(--color-border)]">
          Preview: echte gescrapte stories uit een lokaal bestand, niet uit de database.
          {judged > 0
            ? ` Beoordeeld met hetzelfde model en dezelfde referentiefoto's als productie —
               ${judged} van ${feed.all.length}.`
            : ' Nog niet geanalyseerd, dus nog geen Stëlz-oordeel.'}
        </p>
      )}

      {/* Next to the button that caused it, not in a page-level banner the eye
          has already scrolled past. */}
      {error && (
        <p className="px-4 py-2.5 text-[12px] text-[var(--color-bad)] border-b border-[var(--color-border)]">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyStories state={state} onlyHits={onlyHits && hits.length === 0 && feed.all.length > 0} />
      ) : (
        // Horizontal scroll, not a wrapping grid: the row must not push the
        // rest of the page down as the roster grows, and stories are read in
        // sequence anyway — that is the format's own grammar.
        <div className="flex gap-2 overflow-x-auto px-4 py-3">
          {shown.map((r) => (
            <StoryTile key={r.postId} row={r} onOpen={onOpen ? () => onOpen(r) : undefined} />
          ))}
          {(onlyHits ? hits : feed.all).length > SHOWN && (
            <div className="shrink-0 w-[112px] flex items-center justify-center text-[11px] text-[var(--color-ink-subtle)] border border-dashed border-[var(--color-border)]">
              +{(onlyHits ? hits : feed.all).length - SHOWN}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function StoryTile({ row, onOpen }: { row: StoryRow; onOpen?: () => void }) {
  const e = expiryAt(row.expiresAt)
  const hit = isStelzStory(row.verdict)
  const cls = `shrink-0 w-[112px] text-left border transition-colors ${
    hit
      ? 'border-[var(--color-good)] hover:border-[var(--color-ink)]'
      : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
  } ${e.expired ? 'opacity-70 hover:opacity-100' : ''}`

  const body = (
    <>
      <MediaTile src={storyImage(row)} size="story" alt={`Story van @${row.creatorHandle}`}>
        <span
          className={`absolute top-1 left-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 text-white ${
            e.expired ? 'bg-[var(--color-ink-muted)]' : 'bg-[var(--color-accent)]'
          }`}
        >
          {storyChip(e)}
        </span>
        {hit && (
          <span
            className="absolute top-1 right-1 text-[9px] px-1 py-0.5 bg-[var(--color-good)] text-white"
            title={VERDICT_LABEL[row.verdict]}
          >
            Stëlz
          </span>
        )}
      </MediaTile>
      <span className="block px-1.5 pt-1 text-[10px] truncate text-[var(--color-ink-muted)]">
        @{row.creatorHandle}
      </span>
      {row.pollVotes > 0 && (
        <span className="block px-1.5 pb-1 text-[9px] truncate text-[var(--color-ink-subtle)]">
          {compactNum(row.pollVotes)} stemmen
        </span>
      )}
    </>
  )

  // A story with no detection has nothing for the drawer to show, so it opens
  // on Instagram instead of into an empty panel.
  if (onOpen && row.detection) {
    return <button onClick={onOpen} title={`@${row.creatorHandle}`} className={cls}>{body}</button>
  }
  return row.url
    ? <a href={row.url} target="_blank" rel="noreferrer" title={`@${row.creatorHandle}`} className={cls}>{body}</a>
    : <div className={cls}>{body}</div>
}

function LastRun({ state }: { state: StoriesState | null }) {
  if (!state?.lastRunAt) return <span>nog nooit opgehaald</span>
  const when = timeAgo(state.lastRunAt)
  if (state.lastSkipped) return <span title={state.lastSkipped}>overgeslagen · {when}</span>
  return <span>laatst gekeken · {when}</span>
}

function EmptyStories({ state, onlyHits }: { state: StoriesState | null; onlyHits: boolean }) {
  if (onlyHits) {
    return (
      <p className="px-4 py-6 text-[12px] text-[var(--color-ink-muted)]">
        Geen van de opgehaalde stories bevat een zichtbare Stëlz.
      </p>
    )
  }
  if (!state?.lastRunAt) {
    return (
      <div className="px-4 py-6 text-[12px] text-[var(--color-ink-muted)] space-y-1">
        <p>Nog geen stories opgehaald.</p>
        <p className="text-[var(--color-ink-subtle)]">
          Stories verdwijnen na 24 uur. Zet automatisch ophalen aan onder{' '}
          <Link to="/settings" className="underline hover:text-[var(--color-ink)]">Instellingen</Link>{' '}
          of haal ze nu handmatig op.
        </p>
      </div>
    )
  }
  if (state.lastSkipped) {
    const why = state.lastSkipped.startsWith('budget')
      ? 'het scrapebudget voor deze maand is op'
      : state.lastSkipped === 'no_creators'
        ? 'er staan geen creators op tier 1 of 2'
        : state.lastSkipped
    return (
      <p className="px-4 py-6 text-[12px] text-[var(--color-ink-muted)]">
        Laatste poging overgeslagen: {why}.
      </p>
    )
  }
  // The normal case. Deliberately not styled as a problem: most creators have
  // no live story at any given moment, and a panel that cries wolf four times
  // a day gets ignored on the day it matters.
  return (
    <p className="px-4 py-6 text-[12px] text-[var(--color-ink-muted)]">
      Geen actieve stories op dit moment — {state.lastChecked ?? 0} account
      {state.lastChecked === 1 ? '' : 's'} gecontroleerd. Dat is normaal.
    </p>
  )
}
