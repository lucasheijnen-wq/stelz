// One event: what the roster delivered, and what turned up on its own.
//
// This page absorbed /campagne. The campaign tab showed the same three surfaces
// with no period at all, which is how it came to report 50 sightings for a
// festival weekend that had 8, and 100.928.763 TikTok views where 1.167.605
// fell inside the window. Both errors ran the flattering way. An event has a
// period by definition, so every number here is scoped to one before anything
// else happens — see lib/events.matchEvent.
//
// EVERY NUMBER SAYS WHICH SURFACE IT CAME FROM. TikTok publishes play counts,
// Instagram publishes story views to the account holder alone, and an IG photo
// post publishes neither. Those three facts do not add up into a "total reach",
// so this page never adds them. See lib/campaign.ts.
//
// THE GRIDS SHOW ONLY STËLZ. THE TABLE SHOWS EVERYONE. A grid is for looking at
// sightings, and a tile without the can is not one. The creator table is the
// opposite case: a booked creator who posted nothing is the most useful row on
// the page, and she has no tiles at all.

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PageShell, Card } from '../components/ui'
import { StoryDetail } from '../components/StoryDetail'
import { StoriesView } from './Stories'
import { PasteImport } from '../components/PasteImport'
import { Kpi } from '../components/campaign/Kpi'
import { SurfaceCard } from '../components/campaign/SurfaceCard'
import { ContentCard } from '../components/campaign/ContentCard'
import { CreatorTable } from '../components/campaign/CreatorTable'
import { NumbersTab } from '../components/campaign/NumbersTab'
import { AudienceTab } from '../components/campaign/AudienceTab'
import { CampaignHeader } from '../components/campaign/CampaignHeader'
import {
  joinCampaign, campaignRollup, stelzShare,
  SURFACE_LABEL, SURFACES,
  type CampaignRow, type Surface, type CampaignItem,
} from '../lib/campaign'
import { isStelzStory } from '../lib/storyStats'
import { stelzHits, hitTotals, followerIndex, groupHitsByPost } from '../lib/hits'
import { getEvent, type StelzEvent } from '../data/events'
import {
  matchEvent, evidencedHandlesFor, eventWindow, formatWindow, eventStatus, seedTsv,
} from '../lib/events'
import { fbFetchCreatorProfiles, type CreatorProfile } from '../lib/firestore'
import { fetchProjects, projectsAction, type Project } from '../lib/data'
import { useMembership } from '../lib/membershipContext'
import { fmtNum, compactNum } from '../lib/format'
import { useEventAudience, useEventCampaign } from '../lib/eventData'

type Tab = 'roster' | 'discovery' | 'cijfers' | 'publiek' | 'stories' | 'settings'

const TABS: { id: Tab; label: string; sub: string }[] = [
  { id: 'roster', label: 'Roster', sub: 'wat de geboekte creators plaatsten' },
  { id: 'discovery', label: 'Los gevonden', sub: 'iedereen daarbuiten' },
  // The only tab that puts both sources in one view. Everywhere else they are
  // kept apart because paid delivery and organic pickup are worth different
  // things — but "hoe doet Stëlz het op social" is exactly the question that
  // wants them beside each other, so this tab answers it with a Bron column
  // keeping every row attributable.
  { id: 'cijfers', label: 'Cijfers', sub: 'alle treffers met hun cijfers' },
  // Not posts but PEOPLE: who comments, who gets tagged, who was at the
  // festival posting on their own account. Its own tab because the rows are a
  // different kind of thing and carry different denominators.
  { id: 'publiek', label: 'Publiek', sub: 'de mensen eromheen' },
  { id: 'stories', label: 'Stories', sub: 'de 24-uurs laag' },
  { id: 'settings', label: 'Instellingen', sub: 'roster, periode, hashtags' },
]

const STATUS_TONE: Record<string, string> = {
  live: 'bg-[var(--color-good)] text-white',
  aankomend: 'bg-[var(--color-accent)] text-white',
  afgelopen: 'bg-[var(--color-ink)]/60 text-white',
}

export default function EventPage() {
  const { eventId } = useParams<{ eventId: string }>()
  const ev = getEvent(eventId)
  const [params, setParams] = useSearchParams()

  if (!ev) {
    return (
      <PageShell title="Onbekend evenement" crumbs={[{ label: 'Evenementen', to: '/evenementen' }]}>
        <Card className="p-12 text-center text-[13px] text-[var(--color-ink-muted)]">
          Er is geen evenement met id <code>{eventId}</code>.{' '}
          <Link to="/evenementen" className="underline">Terug naar de lijst</Link>.
        </Card>
      </PageShell>
    )
  }
  return <EventBody ev={ev} params={params} setParams={setParams} />
}

function EventBody({ ev, params, setParams }: {
  ev: StelzEvent
  params: URLSearchParams
  setParams: (p: URLSearchParams, o?: { replace?: boolean }) => void
}) {
  const { canWrite } = useMembership()
  const tab = (params.get('tab') as Tab) || 'roster'
  const creator = params.get('c')
  const surface = params.get('s') as Surface | null
  const showAll = params.get('alles') === '1'

  const [profiles, setProfiles] = useState<Record<string, CreatorProfile>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<CampaignRow | null>(null)

  // Preview in dev, the imported Firestore rows in production — one hook,
  // same downstream pipeline either way. See lib/eventData.
  const { items: campaignItems, detections: campaignDetections,
          preview, loading: campaignLoading } = useEventCampaign(ev.id)
  const audience = useEventAudience(ev.id)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [pr, pj] = await Promise.all([
        fbFetchCreatorProfiles().catch(() => ({} as Record<string, CreatorProfile>)),
        fetchProjects().catch(() => [] as Project[]),
      ])
      if (cancelled) return
      setProfiles(pr)
      setProjects(pj)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  const project = projects.find((p) => p.id === ev.projectId) ?? null

  // The roster comes from the event definition, not from the project document.
  // The definition is what the harvesters read, so it is what "booked" means;
  // the project is what is being TRACKED, and the two can differ. Where they
  // do, the header says so instead of quietly picking one.
  const roster = useMemo(
    () => [...new Set(ev.roster.map((m) => m.instagram.toLowerCase()))],
    [ev])

  // All three surfaces, wherever the rows came from (preview fixture or the
  // imported Firestore set) — never a partial live source that would show
  // stories while silently claiming TikTok and feed posts were empty.
  const allRows = useMemo(
    () => joinCampaign(campaignItems ?? ([] as CampaignItem[]), campaignDetections),
    [campaignItems, campaignDetections],
  )

  // ATTRIBUTION, ONCE, BEFORE ANYTHING IS COUNTED. matchEvent decides both
  // whether a row belongs to this event and on which side of the split it
  // falls, so the source label the fixture happened to bake in never overrides
  // the roster and the window.
  //
  // With ACCOUNT EVIDENCE: a festival-goer whose tagged clip proved the
  // weekend gets their untagged in-window clips counted too (foundVia
  // 'profiel'). Both halves — granting evidence and spending it — live in
  // lib/events, so this component only connects them.
  const rows = useMemo(() => {
    const evidenced = evidencedHandlesFor(ev, allRows)
    const out: CampaignRow[] = []
    for (const r of allRows) {
      const m = matchEvent(ev, r, evidenced)
      if (m) out.push({ ...r, source: m.source, foundVia: r.foundVia ?? m.foundVia })
    }
    return out
  }, [allRows, ev])

  const outside = allRows.length - rows.length
  const scopeRows = showAll ? allRows : rows

  // TWO ROLLUPS, on purpose. `rollup` covers the whole event so a tab can show
  // the OTHER tab's count; `scoped` follows the selected tab so the KPIs agree
  // with the tiles underneath them.
  const rollup = useMemo(
    () => campaignRollup(scopeRows, profiles, roster), [scopeRows, profiles, roster])
  const scoped = useMemo(() => {
    if (tab !== 'roster' && tab !== 'discovery') return rollup
    // Roster stays roster-scoped so "who delivered nothing" keeps its meaning.
    // Discovery gets no roster: passing one would invent 28 silent members for
    // a set nobody booked.
    return campaignRollup(scopeRows.filter((r) => r.source === tab), profiles,
                          tab === 'roster' ? roster : [])
  }, [scopeRows, profiles, roster, rollup, tab])

  // The header's six figures, from the same hitTotals the Cijfers tab uses.
  // A header that did its own arithmetic would eventually disagree with the
  // table below it, and it would do so in front of the client.
  const headerTotals = useMemo(
    () => hitTotals(stelzHits(scopeRows), followerIndex(scopeRows)), [scopeRows])

  const shown = useMemo(() => {
    // Stëlz only. A roster item without the can is still counted — it is in
    // `judged` right above the grid — but it is not something to look at, and
    // 1,600 blank tiles is how the handful that matter get buried.
    let out = scopeRows.filter((r) => r.source === tab && isStelzStory(r.verdict))
    if (creator) out = out.filter((r) => r.creatorHandle === creator)
    if (surface) out = out.filter((r) => r.surface === surface)
    // One card per POST, best sighting in front — see lib/hits.groupHitsByPost.
    return groupHitsByPost(out)
  }, [scopeRows, tab, creator, surface])

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const status = eventStatus(ev)
  const win = eventWindow(ev)
  const share = stelzShare(scoped)
  const tracked = project?.creatorIds.length ?? null

  return (
    <PageShell
      title={ev.name}
      subtitle={`${formatWindow(ev)} · ${ev.venue}`}
      crumbs={[{ label: 'Evenementen', to: '/evenementen' }]}
      actions={
        <span className={`text-[10px] uppercase tracking-wider px-2 py-1 ${STATUS_TONE[status]}`}>
          {status}
        </span>
      }
    >
      {preview && (
        <Card className="mb-4 px-4 py-2.5 text-[12px] text-[var(--color-warn)]">
          Preview: echt gescrapte content uit een lokaal bestand, niet uit de database.
          De oordelen komen uit een lokale analyse met hetzelfde model en dezelfde
          referentiefoto's als productie.
        </Card>
      )}

      {/* Booked is not the same as tracked, and the page used to act as if it
          were. When they differ that is a real gap in the scan coverage. */}
      <Card className="mb-4 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
        <strong className="font-medium text-[var(--color-ink)]">
          {ev.roster.length} creators geboekt
          {tracked != null && tracked !== ev.roster.length && `, ${tracked} profielen gevolgd`}
        </strong>
        {tracked != null && tracked !== ev.roster.length
          ? ' — het verschil wordt niet gescand en levert dus nooit iets op, hoe actief die creators ook zijn.'
          : '.'}{' '}
        Periode {win.start} t/m {win.end}: het festival zelf plus de aanloop en het nawerk,
        want de inpakvideo staat er dagen eerder op en de recap een week later.
      </Card>

      {/* THE DENOMINATOR OF THE WHOLE PAGE. Without this line a reader watches
          most of the archive vanish and reads it as a broken scrape. */}
      <Card className="mb-4 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed border-l-2 border-[var(--color-border-strong)]">
        <strong className="font-medium text-[var(--color-ink)]">
          {fmtNum(rows.length)} van {fmtNum(allRows.length)} stuks content vallen binnen{' '}
          {formatWindow(ev)}.
        </strong>{' '}
        {outside > 0 && (
          <>De overige {fmtNum(outside)} zijn ouder of nieuwer — echte posts van dezelfde
          creators, maar geen {ev.name}. De archieven gaan jaren terug; zonder deze grens
          telt een festivalpagina alles mee wat er toevallig in staat.{' '}</>
        )}
        <button
          onClick={() => setParam('alles', showAll ? null : '1')}
          className="underline hover:text-[var(--color-ink)]"
        >
          {showAll ? 'Terug naar alleen de periode' : 'Toon het volledige archief'}
        </button>
        {showAll && (
          <span className="text-[var(--color-warn)]">
            {' '}— je kijkt nu naar alles, ook buiten {ev.name}.
          </span>
        )}
      </Card>

      {/* ABOVE THE TABS, ON PURPOSE. "How is Stëlz doing on social" is not a
          question about the roster tab or the discovery tab — it is what the
          page as a whole answers, and an answer that only appears once you pick
          the right tab is one most readers never reach. */}
      {allRows.length > 0 && <CampaignHeader totals={headerTotals} />}

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => {
          const st = t.id === 'roster' || t.id === 'discovery' ? rollup.bySource[t.id] : null
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setParam('tab', t.id === 'roster' ? null : t.id)}
              className={`text-left px-3.5 py-2 border transition-colors ${
                active
                  ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                  : 'border-[var(--color-border)] hover:border-[var(--color-ink)]'
              }`}
            >
              <span className="block text-[12px]">
                {t.label}
                {st && <span className="tabular-nums"> · {fmtNum(st.withStelz)}× Stëlz</span>}
              </span>
              <span className={`block text-[10px] ${
                active ? 'text-white/70' : 'text-[var(--color-ink-subtle)]'
              }`}>
                {st
                  ? `${fmtNum(st.accounts)} account${st.accounts === 1 ? '' : 's'} · ${t.sub}`
                  : t.sub}
              </span>
            </button>
          )
        })}
      </div>

      {(loading || campaignLoading) && allRows.length === 0 && tab !== 'settings' ? (
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-subtle)]">Laden…</Card>
      ) : tab === 'stories' ? (
        <StoriesView
          projectId={project?.id ?? null}
          params={params}
          setParams={setParams}
          embedded
        />
      ) : tab === 'settings' ? (
        <SettingsTab ev={ev} project={project} canWrite={canWrite} onChanged={() => {
          fetchProjects().then(setProjects).catch(() => {})
        }} />
      ) : allRows.length === 0 ? (
        <EmptyState ev={ev} />
      ) : tab === 'publiek' ? (
        <AudienceTab audience={audience} />
      ) : tab === 'cijfers' ? (
        <NumbersTab
          rows={scopeRows}
          ev={ev}
          roster={roster}
          profiles={profiles}
          creator={creator}
          onPickCreator={(h) => setParam('c', h === creator ? null : h)}
          onOpen={setOpen}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            {tab === 'discovery' ? (
              <Kpi
                label="Accounts"
                value={fmtNum(scoped.bySource.discovery.accounts)}
                sub="buiten de roster, niets afgesproken"
              />
            ) : (
              <Kpi
                label="Creators geleverd"
                value={scoped.rosterSize > 0
                  ? `${fmtNum(scoped.delivered)}/${fmtNum(scoped.rosterSize)}`
                  : fmtNum(scoped.delivered)}
                sub={scoped.rosterSize === 0 ? 'geen roster geïmporteerd'
                  : scoped.silent > 0
                    ? `${scoped.silent} plaatste${scoped.silent === 1 ? '' : 'n'} niets`
                    : 'iedereen plaatste iets'}
              />
            )}
            <Kpi
              label="Geanalyseerd"
              value={`${fmtNum(scoped.judged)}/${fmtNum(scoped.items)}`}
              sub={`${fmtNum(scoped.imagesSeen)} beelden bekeken`}
            />
            <Kpi
              label="Stëlz zichtbaar"
              value={share == null ? '—' : `${Math.round(share)}%`}
              sub={share == null ? 'nog niets beoordeeld'
                : scoped.offContainer > 0
                  ? `${fmtNum(scoped.withStelz)} van ${fmtNum(scoped.judged)} · ${scoped.offContainer}× niet op een blikje`
                  : `${fmtNum(scoped.withStelz)} van ${fmtNum(scoped.judged)}`}
            />
            <Kpi
              label="Posts met Stëlz"
              value={fmtNum(scoped.postsWithStelz)}
              sub={scoped.posts > 0
                ? `van ${fmtNum(scoped.posts)} posts · ${fmtNum(scoped.items)} beelden`
                : 'nog niets geplaatst'}
            />
            <Kpi
              label="TikTok-weergaven"
              value={scoped.tiktokViews > 0 ? compactNum(scoped.tiktokViews) : '—'}
              sub={scoped.bySurface.tiktok.items > 0
                ? `over ${fmtNum(scoped.bySurface.tiktok.items)} video's`
                : 'geen TikToks'}
            />
          </div>

          <Card className={`mb-6 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed border-l-2 ${
            tab === 'discovery' ? 'border-[var(--color-accent)]' : 'border-[var(--color-good)]'
          }`}>
            <strong className="font-medium text-[var(--color-ink)]">
              {tab === 'discovery' ? 'Los gevonden' : 'De roster'}:{' '}
              {fmtNum(scoped.withStelz)} met Stëlz uit {fmtNum(scoped.judged)} bekeken{' '}
              {tab === 'discovery' ? "video's" : 'beelden'}.
            </strong>{' '}
            {tab === 'discovery' ? (
              <>Gevonden via hashtags, van accounts die niet op de roster staan — dit is wat er
              uit zichzelf gebeurde, los van wat betaald is. Hier betekent stilte niets en
              betekent één vondst veel. Alleen de beelden waar Stëlz in staat worden getoond;
              de rest is festivalcontent die een hashtag toevallig opleverde.
              {scoped.bySource.discovery.tiktokViews > 0 && (
                <> Samen {fmtNum(scoped.bySource.discovery.tiktokViews)} weergaven — apart
                gehouden van de {fmtNum(rollup.bySource.roster.tiktokViews)} van de roster,
                omdat betaald bereik en organisch bereik niet hetzelfde getal zijn.</>
              )}</>
            ) : (
              <>De creators die Stëlz voor dit evenement geboekt heeft. Hier is stilte een
              bevinding: wie niets plaatste, heeft niet geleverd — die staat onderaan in de
              tabel, ook zonder beeld. Het raster hierboven toont alleen de treffers.</>
            )}
          </Card>

          {/* WHY THERE IS NO "TOTAAL BEREIK" ANYWHERE ON THIS PAGE. The three
              surfaces publish three different things, and the one number a
              client always asks for would describe none of them. Said here
              rather than left as an absence, because an absence reads like an
              oversight. */}
          <Card className="mb-6 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
            <strong className="font-medium text-[var(--color-ink)]">Over deze cijfers.</strong>{' '}
            De drie oppervlakken publiceren verschillende dingen, dus ze worden hier nooit bij
            elkaar opgeteld. <strong>TikTok</strong> geeft echte weergaven —
            {scoped.tiktokViews > 0 ? ` ${fmtNum(scoped.tiktokViews)} in deze selectie` : ' geen'}.
            <strong> Instagram-stories</strong> geven aan niemand behalve de accounthouder een
            kijkcijfer; poll-stemmen
            {scoped.pollVotes > 0 ? ` (${fmtNum(scoped.pollVotes)})` : ''} zijn de enige harde
            ondergrens — elke stem is iemand die keek én tikte, dus het echte kijkcijfer ligt
            hoger. <strong>Instagram-posts</strong> geven likes
            {scoped.postLikes > 0 ? ` (${fmtNum(scoped.postLikes)})` : ''}, en alleen reels een
            afspeelteller. Eén opgeteld &ldquo;bereik&rdquo; zou geen van deze dingen betekenen.
          </Card>

          {rollup.missedByDeploy > 0 && (
            <Card className="mb-6 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed border-l-2 border-[var(--color-warn)]">
              <strong className="font-medium text-[var(--color-ink)]">
                {rollup.missedByDeploy} van deze {fmtNum(rollup.withStelz)} vondsten vindt de
                live backend op dit moment niet.
              </strong>{' '}
              De gepubliceerde functie verkleint elk beeld naar 512 pixels voordat het model
              kijkt. Videoframes komen binnen op de resolutie van de clip zelf, dus een frame
              van 1080×1920 verliest ruim 90% van zijn pixels en een merknaam van 40 pixels
              breed wordt er 19. Deze pagina is geanalyseerd op de archiefresolutie, wat meer
              vindt en meer kost. Beelden waar dat verschil speelt zijn hieronder gemarkeerd;
              de keuze om die grens te verhogen ligt bij wie de Gemini-rekening betaalt.
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-4">
            {creator && (
              <button
                onClick={() => setParam('c', null)}
                className="text-[12px] px-3 py-1.5 border border-[var(--color-accent)] text-[var(--color-accent)]"
              >@{creator} ✕</button>
            )}
            {surface && (
              <button
                onClick={() => setParam('s', null)}
                className="text-[12px] px-3 py-1.5 border border-[var(--color-accent)] text-[var(--color-accent)]"
              >{SURFACE_LABEL[surface]} ✕</button>
            )}
            <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
              {fmtNum(shown.length)} post{shown.length === 1 ? '' : 's'} met Stëlz getoond
            </span>
          </div>

          {shown.length === 0 ? (
            <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)]">
              {scoped.judged === 0
                ? 'Nog niets beoordeeld in deze selectie.'
                : `Geen Stëlz gevonden in ${fmtNum(scoped.judged)} bekeken beelden.`}
            </Card>
          ) : (
            <div className="flex flex-wrap gap-2 mb-8">
              {shown.slice(0, 240).map(({ row: r, moreSlides }) => (
                <ContentCard
                  key={`${r.surface}_${r.itemId}`}
                  row={r}
                  moreSlides={moreSlides}
                  showTag={tab === 'discovery'}
                  onOpen={() => setOpen(r)}
                />
              ))}
            </div>
          )}
          {shown.length > 240 && (
            <Card className="mb-8 px-4 py-2.5 text-[12px] text-[var(--color-warn)]">
              De eerste 240 van {fmtNum(shown.length)} worden getoond. Filter op creator of
              oppervlak om de rest te zien — niets is weggegooid, alleen niet getekend.
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {SURFACES.map((s) => (
              <SurfaceCard
                key={s}
                surface={s}
                stats={scoped.bySurface[s]}
                active={surface === s}
                onPick={() => setParam('s', surface === s ? null : s)}
              />
            ))}
          </div>

          {tab === 'roster' && (
            <CreatorTable
              rollup={scoped}
              selected={creator}
              onPick={(h) => setParam('c', h === creator ? null : h)}
            />
          )}
        </>
      )}

      <StoryDetail
        row={open ? { ...open, surfaceLabel: SURFACE_LABEL[open.surface] } : null}
        onClose={() => setOpen(null)}
      />
    </PageShell>
  )
}

/** Roster import, the period, the tags, and how to harvest them.
 *
 *  The scraper block is not a convenience. An event lives in two places — a
 *  project document the dashboard reads and a JSON definition the harvesters
 *  read — and nothing keeps them in step. Printing the commands next to the
 *  configuration makes the divergence visible instead of silent: a second event
 *  created here and never harvested would otherwise just look empty. */
function SettingsTab({ ev, project, canWrite, onChanged }: {
  ev: StelzEvent
  project: Project | null
  canWrite: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const win = eventWindow(ev)

  const doImport = async (creatorIds: string[], names: Record<string, string>) => {
    setBusy(true)
    setError(null)
    try {
      let p = project
      if (!p) {
        p = await projectsAction('create', {
          name: ev.name,
          trackingTier: 'tier_2',
          note: `${ev.name} — ${win.start} t/m ${win.end}, ${ev.venue}`,
          startsAt: ev.window.start,
          endsAt: ev.window.end,
          hashtags: ev.hashtags.map((h) => h.tag),
        })
      }
      await projectsAction('addCreators', { projectId: p.id, creatorIds, names })
      onChanged()
    } catch (e) {
      // Server messages (cap, deploy status) explain themselves — verbatim.
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <Card className="p-4 text-[12px] text-[var(--color-bad)]">{error}</Card>}

      <Card className="p-5">
        <h2 className="text-[15px] text-[var(--color-ink)] mb-1">Periode en hashtags</h2>
        <p className="text-[12px] text-[var(--color-ink-subtle)] leading-relaxed max-w-2xl mb-4">
          Deze staan in <code className="text-[11px]">web/src/data/events/{ev.id}.json</code>,
          het bestand dat zowel dit dashboard als de scrapers lezen. Eén bron, twee talen —
          voorheen stond de roster in een TypeScript-string die vier Python-scripts met
          string-chirurgie uitlazen, en de hashtags in een vijfde plek.
        </p>
        <dl className="text-[12px] grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 max-w-2xl">
          <dt className="text-[var(--color-ink-subtle)]">Festival</dt>
          <dd className="tabular-nums">{ev.window.start} t/m {ev.window.end}</dd>
          <dt className="text-[var(--color-ink-subtle)]">Meegeteld</dt>
          <dd className="tabular-nums">
            {win.start} t/m {win.end}
            <span className="text-[var(--color-ink-subtle)]">
              {' '}({ev.window.preDays} dagen aanloop, {ev.window.postDays} dagen nawerk)
            </span>
          </dd>
          <dt className="text-[var(--color-ink-subtle)]">Merktags</dt>
          <dd>{ev.hashtags.filter((h) => h.family === 'brand').map((h) => `#${h.tag}`).join(' ')}</dd>
          <dt className="text-[var(--color-ink-subtle)]">Evenementtags</dt>
          <dd>{ev.hashtags.filter((h) => h.family === 'event').map((h) => `#${h.tag}`).join(' ')}</dd>
        </dl>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-2xl mt-3">
          Merktags worden ongelimiteerd opgehaald, evenementtags begrensd op{' '}
          {ev.discovery.perTag}. Dat is gemeten, niet gegokt: merktags leveren ~56% posts met
          het blikje op, evenementtags vrijwel 0%.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] text-[var(--color-ink)] mb-1">Oogsten</h2>
        <p className="text-[12px] text-[var(--color-ink-subtle)] leading-relaxed max-w-2xl mb-3">
          De scrapers draaien lokaal, want de Cloud Functions staan niet uitgerold. Stories
          verdwijnen na 24 uur en komen nooit terug — die sweep is de enige die haast heeft.
        </p>
        <pre className="text-[11px] bg-[var(--color-surface-2)] p-3 overflow-x-auto leading-relaxed">
{`62_stories_archive.py   --event ${ev.id}
70_tiktok_archive.py    --event ${ev.id} --per-handle 30
71_ig_posts_archive.py  --event ${ev.id} --per-handle 25 --since ${win.start}
73_lowlands_discovery.py --event ${ev.id} --since ${win.start}

74_analyse.py --event ${ev.id} --archive stories   --max-dim 0
74_analyse.py --event ${ev.id} --archive ig-posts  --max-dim 0
74_analyse.py --event ${ev.id} --archive tiktok    --max-dim 0
74_analyse.py --event ${ev.id} --archive discovery --max-dim 0`}
        </pre>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-2xl mt-3">
          <code>--max-dim 0</code> altijd meegeven. De standaard is 512, de resolutie van de
          uitgerolde functie; zonder de vlag daalt het aantal treffers en ziet dat eruit als
          een merk dat minder zichtbaar werd.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] text-[var(--color-ink)] mb-1">Roster</h2>
        {project ? (
          <>
            <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-2xl mb-3">
              {project.creatorIds.length} profielen gevolgd in project{' '}
              <Link to={`/projects/${project.id}`} className="underline">{project.name}</Link>.
              Daar kun je creators toevoegen of verwijderen.
            </p>
            {project.creatorIds.length !== ev.roster.length * 2 && (
              <p className="text-[12px] text-[var(--color-warn)] leading-relaxed max-w-2xl">
                De definitie noemt {ev.roster.length} creators
                ({ev.roster.filter((m) => m.tiktok).length} met TikTok). Wat níet gevolgd
                wordt, wordt ook niet gescand.
              </p>
            )}
          </>
        ) : !canWrite ? (
          <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
            De lijst is nog niet geïmporteerd. Importeren vereist schrijfrechten — vraag een
            teamlid met toegang.
          </p>
        ) : (
          <>
            <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-2xl mb-3">
              {ev.roster.length} creators uit de definitie. Importeren maakt het project
              &ldquo;{ev.name}&rdquo; aan op een 12-uurs scancadans; aanpassen kan nu en ook
              achteraf.
            </p>
            <PasteImport
              initialText={seedTsv(ev)}
              busy={busy}
              submitLabel={(n) => `Importeer ${n} creators als "${ev.name}" (12u)`}
              onImport={doImport}
            />
          </>
        )}
      </Card>
    </div>
  )
}

function EmptyState({ ev }: { ev: StelzEvent }) {
  return (
    <Card className="p-12 text-center">
      <p className="text-[13px] text-[var(--color-ink-muted)] mb-2">Nog geen data voor {ev.name}.</p>
      <p className="text-[12px] text-[var(--color-ink-subtle)] max-w-[520px] mx-auto leading-relaxed">
        Deze pagina toont Instagram-stories, Instagram-posts en TikToks naast elkaar. Zolang de
        scans niet zijn uitgerold, wordt hij gevuld met{' '}
        <code className="text-[11px]">72_campaign_fixture.py --event {ev.id}</code>.
      </p>
      {/* Dev server only — folded out of a production build along with the URL
          it names. Typing a query parameter you have to be told about is not a
          way to find a page; on localhost the empty state IS the signpost. */}
      {import.meta.env.DEV && (
        <p className="mt-4">
          <a
            href={`/evenementen/${ev.id}?preview=campaign`}
            className="text-[12px] underline hover:text-[var(--color-ink)]"
          >
            Lokale preview openen →
          </a>
        </p>
      )}
    </Card>
  )
}

