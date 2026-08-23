// The Cijfers tab: the campaign as numbers, for showing to the brand.
//
// The other tabs are for looking at content. This one is for reading figures
// off, which is what a brand does with a campaign once it stops being new —
// and it is the tab that ends up on a screen in a client meeting, so every
// number on it carries its denominator and names the surface it came from.
//
// THE ARITHMETIC IS NOT HERE. Totals come from lib/hits.hitTotals and
// lib/campaign.campaignRollup, the same functions the other tabs use. A tab
// that computed its own sums would eventually disagree with the tiles beside
// it, and the disagreement would surface in front of the client rather than in
// a test.
//
// IT SHOWS BOTH SOURCES AT ONCE, on purpose. Roster and discovery are kept
// apart everywhere else because paid delivery and organic pickup are worth
// different things — but "how is Stëlz doing on social" is precisely the
// question that wants them side by side, so here they sit next to each other
// with a Bron column keeping them distinguishable per row.

import { useMemo } from 'react'
import { Card } from '../ui'
import { StackedDayBars } from '../Chart'
import { Kpi } from './Kpi'
import { HitsTable } from './HitsTable'
import { CreatorTable } from './CreatorTable'
import {
  campaignRollup, SOURCE_LABEL, type CampaignRow, type Source,
} from '../../lib/campaign'
import { bucketByRange, followerIndex, hitTotals, stelzHits } from '../../lib/hits'
import { campaignCsv, downloadCsv, datedFilename } from '../../lib/csv'
import { eventWindow, formatWindow } from '../../lib/events'
import type { StelzEvent } from '../../data/events'
import type { CreatorProfile } from '../../lib/firestore'
import { compactNum, fmtNum } from '../../lib/format'

export function NumbersTab({
  rows, ev, roster, profiles, creator, onPickCreator, onOpen,
}: {
  /** Every row already attributed to this event, both sources. */
  rows: CampaignRow[]
  ev: StelzEvent
  roster: string[]
  profiles: Record<string, CreatorProfile>
  creator: string | null
  onPickCreator: (handle: string) => void
  onOpen: (row: CampaignRow) => void
}) {
  const win = eventWindow(ev)

  const hits = useMemo(() => stelzHits(rows), [rows])
  const shown = useMemo(
    () => (creator ? hits.filter((r) => r.creatorHandle === creator) : hits),
    [hits, creator],
  )
  // Built from EVERY row, not from the sightings. Only 37 of the 108 detections
  // on a sighting carry a follower count, while the same accounts have one
  // somewhere in their other rows — reading it off the hits alone dropped
  // nineteen accounts into "unknown" and understated the audience threefold.
  const followers = useMemo(() => followerIndex(rows), [rows])
  const totals = useMemo(() => hitTotals(shown, followers), [shown, followers])

  const rosterRollup = useMemo(
    () => campaignRollup(rows.filter((r) => r.source === 'roster'), profiles, roster),
    [rows, profiles, roster],
  )
  // No roster passed: handing one to discovery would invent 28 silent members
  // for a set nobody booked.
  const discoveryRollup = useMemo(
    () => campaignRollup(rows.filter((r) => r.source === 'discovery'), profiles, []),
    [rows, profiles],
  )
  // Only the strangers who actually held a can. A booked creator who posted
  // nothing is the most useful row on the page; a stranger who posted nothing
  // is not a row at all — see the note above the second table.
  const discoveryHitters = useMemo(
    () => ({ ...discoveryRollup, creators: discoveryRollup.creators.filter((c) => c.withStelz > 0) }),
    [discoveryRollup],
  )

  const series = useMemo(() => {
    const of = (source: Source) => bucketByRange(
      hits.filter((r) => r.source === source).map((r) => r.postedAt), win.start, win.end,
    )
    return [
      { id: 'roster', label: SOURCE_LABEL.roster, data: of('roster'), tone: 'good' as const },
      { id: 'discovery', label: SOURCE_LABEL.discovery, data: of('discovery'), tone: 'accent' as const },
    ]
  }, [hits, win.start, win.end])

  const days = series[0].data.length

  return (
    <div className="space-y-8">
      {/* ── De kop: vijf getallen, geen zesde die ze optelt ───────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi
          label="Treffers"
          value={fmtNum(totals.hits)}
          sub={`${fmtNum(totals.posts)} posts · ${fmtNum(totals.accounts)} accounts`}
        />
        <Kpi
          label="TikTok-weergaven"
          value={totals.tiktokVideos > 0 ? compactNum(totals.tiktokViews) : '—'}
          sub={totals.tiktokVideos > 0
            ? `over ${fmtNum(totals.tiktokVideos)} video's met Stëlz in beeld`
            : 'geen TikToks in deze selectie'}
        />
        <Kpi
          label="IG-likes"
          value={totals.likedPosts > 0 ? compactNum(totals.postLikes) : '—'}
          sub={totals.likedPosts > 0
            ? `over ${fmtNum(totals.likedPosts)} posts`
            : 'geen posts in deze selectie'}
        />
        {/* Deliberately a dash. The 22 story sightings have no audience figure
            at all, and a 0 here would claim a measurement nobody made. */}
        <Kpi
          label="Story-kijkcijfers"
          value="—"
          sub={totals.storyHits > 0
            ? `${fmtNum(totals.storyHits)} stories · Instagram geeft dit alleen aan de accounthouder`
            : 'geen stories in deze selectie'}
        />
        {/* "TikTok-volgers", niet "volgers". Van de 2.693 detecties dragen er
            1.159 een volgersaantal en die zitten állemaal op een TikTok-rij;
            Instagram geeft er geen enkele. Een tegel met "Volgers" erboven zou
            dus een TikTok-getal zijn met een campagnebreed etiket erop, op een
            campagne die voor tweederde Instagram is. */}
        <Kpi
          label="TikTok-volgers"
          value={totals.tiktokFollowersKnownFor > 0 ? compactNum(totals.tiktokFollowers) : '—'}
          sub={totals.tiktokAccounts > 0
            ? `van ${fmtNum(totals.tiktokFollowersKnownFor)} van ${fmtNum(totals.tiktokAccounts)} TikTok-accounts`
            : 'geen TikToks in deze selectie'}
        />
      </div>

      <Card className="p-4 text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
        <span className="text-[var(--color-ink)]">Er staat nergens een totaal.</span>{' '}
        Een TikTok-afspeling, een Instagram-like en een story-kijker zijn drie
        verschillende gebeurtenissen; ze optellen levert een &ldquo;totaal bereik&rdquo; op
        dat gezaghebbend oogt en niets beschrijft. Volgers zijn de omvang van een publiek
        dat het <em>kon</em> zien, niet een telling van wie het zag — en ze staan er alleen
        voor TikTok, want Instagram geeft bij deze scrape geen enkel volgersaantal terug.
        {totals.tiktokAccountsWithoutFollowers.length > 0 && (
          <> Ook {fmtNum(totals.tiktokAccountsWithoutFollowers.length)}{' '}
            {totals.tiktokAccountsWithoutFollowers.length === 1
              ? 'TikTok-account geeft' : 'TikTok-accounts geven'} er geen
            ({totals.tiktokAccountsWithoutFollowers.slice(0, 4).map((h) => `@${h}`).join(', ')}
            {totals.tiktokAccountsWithoutFollowers.length > 4 && ' …'}), dus die tellen niet mee.
          </>
        )}
      </Card>

      {/* ── De tabel: waar de vraag om ging ──────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
            Alle treffers op een rij
          </h2>
          <span className="text-[11px] text-[var(--color-ink-subtle)]">
            {formatWindow(ev)} · klik een kolomkop om te sorteren
          </span>
          {creator && (
            <button
              onClick={() => onPickCreator(creator)}
              className="text-[11px] px-2 py-1 border border-[var(--color-accent)] text-[var(--color-accent)]"
            >@{creator} ✕</button>
          )}
          <button
            onClick={() => downloadCsv(
              datedFilename(`stelz-${ev.id}-treffers`), campaignCsv(shown))}
            disabled={shown.length === 0}
            className="ml-auto text-[12px] px-3 py-1.5 border border-[var(--color-border)] hover:border-[var(--color-ink)] transition-colors disabled:opacity-40"
          >
            Download CSV ({fmtNum(shown.length)})
          </button>
        </div>
        <HitsTable rows={shown} onOpen={onOpen} />
      </section>

      {/* ── Wanneer ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          Wanneer Stëlz in beeld kwam
        </h2>
        <Card className="p-5">
          <StackedDayBars series={series} days={days} height={140} />
          <div className="flex gap-4 mt-3 text-[11px] text-[var(--color-ink-subtle)]">
            <span><span className="inline-block w-2 h-2 mr-1.5 bg-[var(--color-good)]" />
              {SOURCE_LABEL.roster}</span>
            <span><span className="inline-block w-2 h-2 mr-1.5 bg-[var(--color-accent)]" />
              {SOURCE_LABEL.discovery}</span>
            <span className="ml-auto">
              Alleen treffers, per dag over de hele evenementperiode — niet de laatste 30 dagen,
              zodat deze grafiek ook over een maand nog klopt.
            </span>
          </div>
        </Card>
      </section>

      {/* ── Per creator ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          De geboekte creators
        </h2>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
          Alle {fmtNum(rosterRollup.rosterSize)} van het roster, ook wie niets plaatste.
          {rosterRollup.silent > 0 && (
            <> Op dit moment {rosterRollup.silent === 1 ? 'is dat één iemand' : `zijn dat er ${fmtNum(rosterRollup.silent)}`} —
              bij een betaalde boeking is dat de nuttigste rij op de pagina.</>
          )}
          {' '}Klik een rij om de tabel hierboven op die creator te filteren.
        </p>
        <CreatorTable rollup={rosterRollup} selected={creator} onPick={onPickCreator} />
      </section>

      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          Los gevonden accounts
        </h2>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
          Alleen de {fmtNum(discoveryHitters.creators.length)} accounts waar Stëlz
          daadwerkelijk in beeld was, van {fmtNum(discoveryRollup.creators.length)} die zijn
          doorzocht. Dat is bewust anders dan de tabel hierboven: een vreemde zónder Stëlz is
          geen bevinding, een geboekte creator zónder Stëlz wel.
        </p>
        <CreatorTable rollup={discoveryHitters} selected={creator} onPick={onPickCreator} />
      </section>
    </div>
  )
}
