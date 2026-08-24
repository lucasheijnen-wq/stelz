// Single-page home with 5 tabs. Replaces: Today, Dashboard/Feed, Highlights,
// Outreach (inline action on Creator detail), Reports, Discover, Moderator.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageShell, Card, Badge, Button, Img, Avatar, Input, Tabs, CARD_GRID, HAIRLINE_GRID } from '../components/ui'
import { PRODUCT_LINE_LABEL } from '../lib/labels'
import { formatFollowers } from '../lib/format'
import { MediaTile } from '../components/MediaTile'
import { Sparkline, LineChart, BarChart, Donut, StackedDayBars, type Series } from '../components/Chart'
import { bucketByDay } from '../lib/buckets'
import { DetectionDrawer } from '../components/DetectionDrawer'
import { ScanPanel } from '../components/ScanPanel'
import { scanIsStale } from '../lib/scanProgress'
import { StoriesStrip } from '../components/StoriesStrip'
import {
  fetchDetections, fetchTopResonance, fetchCreatorSubcultures, fetchSubcultures,
  fetchCreatorProfiles, fetchProjects,
  loadState, markSeen, rateDetection,
  type DetectionRow, type ResonanceRow, type Project,
} from '../lib/data'
import { imageUrlFor, parentPostKey, dedupeByPost } from '../lib/types'
import { storyExpiry } from '../lib/stories'
import { withSignal, signalCounts, untaggedShare, isBrandTag } from '../lib/signal'
import { detectionQuality, splitByQuality, isPrimaryAngle } from '../lib/quality'
import { sceneBreakdown, subcultureBreakdown, type CreatorSceneMap } from '../lib/scenes'
import { communityProfiles, oneLineSummary, DAY_NAMES, type CommunityProfile } from '../lib/communities'
import { detectionsCsv, communitiesCsv, downloadCsv, datedFilename } from '../lib/csv'
import { verifyDetection, sortByEvidence } from '../lib/verify'
import { tallySounds, soundHref } from '../lib/sounds'
import { useNow } from '../lib/useNow'
import { useResetOn } from '../lib/useResetOn'
import {
  fbBootstrapBrand, fbStepHashtags, fbStepCreators, fbStepSrs, fbStepSentiment,
  fbStepSubcultures, fbStepProfiles,
  fbFetchPipelineCounts, fbSubscribeScanState, fbStepStories,
  fbSubscribeStoriesState, fbFetchStories, fbFetchStoryPosts,
  fbListUsage, fbGetBrand,
  type ScanState, type ScanStepKey, type StoriesState, type StoryPost, type UsageDay,
} from '../lib/firestore'
import { degradeLevel, DEGRADE_LABEL, fmtUsd, UNIT_META } from '../lib/costs'
import {
  pickWorthALook, biggestFanToday, detectSpike, countNewSince,
} from '../lib/score'
import { ReadOnlyNotice } from '../lib/membership'
import { useMembership } from '../lib/membershipContext'
import { useStoryPostsPreview, useStoryPreview } from '../lib/devPreview'
import { joinStories, storySource, type StoryRow } from '../lib/storyStats'
import { StoryDetail } from '../components/StoryDetail'

type Tab = 'briefing' | 'feed' | 'review' | 'creators'
type PipelineCounts = { creators: number; posts: number; detections: number; detectionsHit: number; discoveryQueue: number }

// Charts + list default window (was user-selectable 7/30/90; simplified).
const DAYS_WINDOW = 30

// How many detection docs one refresh pulls. This is a hard ceiling on what the
// whole page can ever show, and it bites before any filter does: the query is
// ordered postedAt desc, so hitting it silently drops the OLDEST hits. Docs are
// per frame/carousel-slot, not per post, so a video-heavy brand burns through it
// several times faster than the post count suggests. Surfaced in the feed when
// it binds rather than left to look like "that's all there is".
const DETECTION_FETCH_LIMIT = 5000

const CACHE_KEY = 'spotthebrand:dashboard-cache:v2'
type DashboardCache = {
  savedAt: number
  detections: DetectionRow[]
  resonance: ResonanceRow[]
  counts: PipelineCounts | null
}

function loadCache(): DashboardCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DashboardCache
    if (!Array.isArray(parsed.detections)) return null
    return parsed
  } catch { return null }
}

function saveCache(c: DashboardCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch { /* quota — ignore */ }
}

const TABS: Tab[] = ['briefing', 'feed', 'review', 'creators']

export default function Home() {
  // The tab lives in the URL so a tab is linkable — "look at the creators
  // list" used to be unshareable, and breadcrumbs pointing back at a tab had
  // nothing to point at. Falls back to the dashboard on an unknown value.
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'briefing') as Tab
  const setTab = useCallback((t: Tab) => {
    setParams(t === 'briefing' ? {} : { tab: t }, { replace: true })
  }, [setParams])
  const [activeDetection, setActiveDetection] = useState<DetectionRow | null>(null)
  const [openStory, setOpenStory] = useState<StoryRow | null>(null)

  // Boot from cache if we have one — the dashboard is visible instantly,
  // even before the fresh Firestore reads finish. `refreshing` shows a
  // subtle spinner in the header while we're pulling new data on top.
  const [detections, setDetections] = useState<DetectionRow[]>(() => loadCache()?.detections ?? [])
  const [resonance, setResonance] = useState<ResonanceRow[]>(() => loadCache()?.resonance ?? [])
  const [counts, setCounts] = useState<PipelineCounts | null>(() => loadCache()?.counts ?? null)
  // Starts TRUE: the mount effect below begins a fetch straight away, so the
  // first paint should already say a fetch is running. It also used to mean
  // `loading` was false for one frame on a cold start, which rendered the
  // dashboard's empty state — "no hits" — a beat before the data arrived.
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const hasCache = detections.length > 0 || !!counts
  const loading = !hasCache && refreshing

  // Creator → subcultures, plus the scene labels. Loaded separately from the
  // main refresh: both collections are small, and a brand that has never run
  // the seeding step simply gets empty maps and the per-photo fallback.
  const [creatorScenes, setCreatorScenes] = useState<CreatorSceneMap>({})
  const [sceneLabels, setSceneLabels] = useState<Record<string, string>>({})
  // Creator records — the only place Instagram follower counts, bios and
  // avatars live. Detections never gain them retroactively.
  const [creatorProfiles, setCreatorProfiles] = useState<Record<string, { followerCount: number | null; bio: string | null; avatarUrl: string | null }>>({})

  const [lastSeenAt] = useState<string | null>(() => loadState().lastSeenAt)
  useEffect(() => { markSeen() }, [])
  const { canWrite } = useMembership()

  // Stories come from POSTS (the authoritative list — a story we could not
  // analyse has no detection document at all) joined with story DETECTIONS
  // (the Stëlz verdict). Both are separate queries because the main detection
  // fetch is detected-only. Null means the query is unavailable, e.g. the
  // index is not live yet.
  const [storyPosts, setStoryPosts] = useState<StoryPost[] | null>(null)
  const [storyDetections, setStoryDetections] = useState<DetectionRow[]>([])

  // THE FETCH LIVES IN THE EFFECT, and everyone who wants a fresh one bumps
  // `reloadKey`. It used to be a useCallback the mount effect invoked, which is
  // the shape react-hooks/set-state-in-effect exists to catch: the effect body
  // reached a setState synchronously.
  //
  // The rewrite brings CANCELLATION, which the callback version had none of.
  // Five parallel Firestore reads land whenever they land, and nothing told an
  // in-flight batch that a newer one had started — so an unmounted dashboard
  // still called setState, and two overlapping refreshes could resolve out of
  // order and leave the older answer on screen.
  const [reloadKey, setReloadKey] = useState(0)
  const refreshData = () => { setRefreshing(true); setReloadKey((k) => k + 1) }

  useEffect(() => {
    let cancelled = false
    void (async () => {
    try {
      const [d, r, c, s, sp] = await Promise.all([
        fetchDetections({ limit: DETECTION_FETCH_LIMIT }).catch(() => [] as DetectionRow[]),
        fetchTopResonance(100).catch(() => [] as ResonanceRow[]),
        fbFetchPipelineCounts().catch(() => null),
        fbFetchStories(2000).catch(() => [] as DetectionRow[]),
        fbFetchStoryPosts(2000).catch(() => null),
      ])
      if (cancelled) return
      setDetections(d)
      setResonance(r)
      setCounts(c)
      // Raw: joinStories does its own grouping, and one document per examined
      // frame is how it knows a video verdict rests on thirteen images.
      setStoryDetections(s)
      setStoryPosts(sp)
      saveCache({ savedAt: Date.now(), detections: d, resonance: r, counts: c })
    } catch (e) {
      if (!cancelled) setError((e as Error).message)
    } finally {
      if (!cancelled) setRefreshing(false)
    }
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetchCreatorSubcultures().catch(() => ({} as CreatorSceneMap)),
      fetchSubcultures().catch(() => []),
      fetchCreatorProfiles().catch(() => ({})),
    ]).then(([links, defs, profiles]) => {
      if (cancelled) return
      setCreatorScenes(links)
      setSceneLabels(Object.fromEntries(defs.map((d) => [d.slug, d.emoji ? `${d.emoji} ${d.name}` : d.name])))
      setCreatorProfiles(profiles)
    })
    return () => { cancelled = true }
  }, [])

  // Detection workers keep writing after the scrape publisher finishes.
  // Poll refreshData every 25s only when the backend is actively working:
  // scan running OR finished within the last 3 minutes.
  const [scanActive, setScanActive] = useState(false)
  const [scanState, setScanState] = useState<ScanState | null>(null)
  const [stepErrors, setStepErrors] = useState<Partial<Record<ScanStepKey, string>>>({})
  useEffect(() => {
    const unsub = fbSubscribeScanState((s) => {
      setScanState(s)
      const finished = s?.finishedAt ? new Date(s.finishedAt).getTime() : 0
      // Stale-gated: a scan that died weeks ago otherwise reads as "running"
      // here and keeps this page re-fetching Firestore every 25 seconds for
      // as long as it is open.
      const running = !!s?.startedAt && !finished && !scanIsStale(s)
      const recentlyDone = !!finished && (Date.now() - finished) < 3 * 60_000
      setScanActive(running || recentlyDone)
    })
    return () => unsub()
  }, [])
  useEffect(() => {
    if (!scanActive) return
    const id = window.setInterval(refreshData, 25_000)
    return () => window.clearInterval(id)
  }, [scanActive])

  // Stories run on their own 6-hourly schedule, outside any scan session, so
  // their last-run stamp is a separate subscription rather than a scan step.
  const [storiesState, setStoriesState] = useState<StoriesState | null>(null)
  const [storiesFetching, setStoriesFetching] = useState(false)
  const [storiesError, setStoriesError] = useState<string | null>(null)
  useEffect(() => fbSubscribeStoriesState(setStoriesState), [])
  // Dev server only; compiled out of production builds. See lib/devPreview.
  const storyPreview = useStoryPostsPreview()
  const storyPreviewDetections = useStoryPreview()
  // One join, used by the strip here and by the /stories page, so the two can
  // never report different totals for the same set. Preview brings its own
  // detections — passing [] threw away every locally produced verdict and made
  // analysed stories read as "nog niet geanalyseerd".
  const storyRows = useMemo(() => {
    const src = storySource(storyPreview, storyPreviewDetections, storyPosts ?? [], storyDetections)
    return joinStories(src.posts, src.detections)
  }, [storyPreview, storyPreviewDetections, storyPosts, storyDetections])
  const fetchStories = useCallback(async () => {
    setStoriesFetching(true)
    setStoriesError(null)
    try {
      await fbStepStories()
      // The sweep only writes posts; the detections the strip renders arrive
      // via the detect fan-out a beat later, so refresh again after a pause
      // rather than leaving an empty strip behind a finished button.
      refreshData()
      window.setTimeout(refreshData, 20_000)
    } catch (e) {
      setStoriesError((e as Error).message)
    } finally {
      setStoriesFetching(false)
    }
  }, [])

  const days = DAYS_WINDOW
  // Collapse frame-level AND carousel-slot detections into one row per real
  // POST (see lib/types.dedupeByPost — verdicts merge across the group).
  // withSignal annotates each row with whether the brand could have found this
  // post themselves on Instagram. Applied once here, AFTER dedupe (so carousel
  // slides have already had their tags/mentions unioned), and every downstream
  // consumer inherits it. See lib/signal.ts.
  const uniqueDetections = useMemo(() => withSignal(dedupeByPost(detections)), [detections])
  // Rejected content is excluded from Dashboard, Creators, and default views.
  // The Feed keeps access to it via the "Flagged FP" trust filter.
  const activeRows = useMemo(
    () => uniqueDetections.filter((d) => d.is_false_positive !== true),
    [uniqueDetections],
  )

  // Dashboard shows every non-rejected post-hit — age of the underlying
  // post shouldn't hide a real hit, but moderator-rejected content is out.
  const rangeRows = activeRows

  // Tab badge counts — all post-level (deduped), rejected excluded.
  const newSince = useMemo(() => countNewSince(activeRows, lastSeenAt), [activeRows, lastSeenAt])
  const reviewCount = useMemo(
    () => activeRows.filter((d) => d.detected === true && d.verified !== true).length,
    [activeRows],
  )
  const creatorCount = useMemo(
    () => new Set(activeRows.filter((d) => d.detected === true && d.creator_handle).map((d) => d.creator_handle)).size,
    [activeRows],
  )

  const tabItems = useMemo(() => [
    { id: 'briefing', label: 'Dashboard', count: newSince > 0 ? newSince : undefined },
    { id: 'feed', label: 'Feed', count: rangeRows.length },
    { id: 'review', label: 'Review', count: reviewCount > 0 ? reviewCount : undefined },
    { id: 'creators', label: 'Creators', count: creatorCount },
  ], [newSince, rangeRows.length, reviewCount, creatorCount])

  return (
    <PageShell
      title="The Stëlz Community"
      subtitle="Live brand tracker"
      actions={
        <div className="flex items-center gap-3">
          {refreshing && hasCache && <RefreshingTag />}
          {/* Export is a READ. Deliberately available to read-only testers and
              to anyone in a demo — it takes what is already on screen. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={uniqueDetections.length === 0}
            onClick={() => downloadCsv(datedFilename('stelz-hits'), detectionsCsv(uniqueDetections))}
          >
            Export CSV
          </Button>
          <RunScanButton
            onComplete={refreshData}
            liveHits={activeRows.filter((d) => d.detected === true).length}
            onStepErrors={setStepErrors}
          />
        </div>
      }
    >
      <ReadOnlyNotice />

      {loading && <SkeletonHome />}
      {error && <Card className="p-10 text-center text-[13px] text-[var(--color-bad)]">{error}</Card>}

      {!loading && !error && (
        <>
          <ScanPanel scan={scanState} clientErrors={stepErrors} />
          {/* Above the tabs on purpose. Everything else here can be looked at
              tomorrow; a story is gone in 24 hours, so it does not get filed
              behind a tab someone has to remember to open. */}
          <StoriesStrip
            rows={storyRows}
            state={storiesState}
            // The story panel, not the detection drawer: a story tile has to
            // open even when nothing was found in it, and the detection drawer
            // has nothing to show for a story with no hit.
            onOpen={(r) => setOpenStory(r)}
            onFetch={fetchStories}
            fetching={storiesFetching}
            canWrite={canWrite}
            error={storiesError}
            preview={storyPreview != null}
          />
          <Tabs items={tabItems} active={tab} onChange={(id) => setTab(id as Tab)} />

          <div className="mt-8">
            {tab === 'briefing' && (
              <BriefingTab
                detections={uniqueDetections}
                rangeRows={rangeRows}
                resonance={resonance}
                counts={counts}
                lastSeenAt={lastSeenAt}
                days={days}
                creatorScenes={creatorScenes}
                sceneLabels={sceneLabels}
                creatorProfiles={creatorProfiles}
                onOpen={setActiveDetection}
                onGotoTab={setTab}
              />
            )}
            {tab === 'feed' && (
              <FeedTab
                rows={uniqueDetections}
                allDetections={detections}
                truncated={detections.length >= DETECTION_FETCH_LIMIT}
                lastSeenAt={lastSeenAt}
                onOpen={setActiveDetection}
              />
            )}
            {tab === 'review' && (
              <ReviewTab detections={activeRows} allDetections={detections} />
            )}
            {tab === 'creators' && (
              <CreatorsTab detections={activeRows} resonance={resonance} creatorProfiles={creatorProfiles} />
            )}
          </div>
        </>
      )}

      <DetectionDrawer
        detection={activeDetection}
        similar={activeDetection ? uniqueDetections.filter((d) => d.creator_handle === activeDetection.creator_handle && d.detection_id !== activeDetection.detection_id) : []}
        frames={activeDetection ? detections
          .filter((d) => d.detected === true && parentPostKey(d) === parentPostKey(activeDetection))
          .sort((a, b) => (a.frame_idx ?? 0) - (b.frame_idx ?? 0)) : []}
        onClose={() => setActiveDetection(null)}
      />
      <StoryDetail row={openStory} onClose={() => setOpenStory(null)} />
    </PageShell>
  )
}

// ─────────────────────── BRIEFING ───────────────────────

function BriefingTab({
  detections, rangeRows, counts, days, creatorScenes, sceneLabels, creatorProfiles, onOpen, onGotoTab,
}: {
  detections: DetectionRow[]
  rangeRows: DetectionRow[]
  resonance: ResonanceRow[]
  counts: PipelineCounts | null
  lastSeenAt: string | null
  days: number
  creatorScenes: CreatorSceneMap
  sceneLabels: Record<string, string>
  creatorProfiles: Record<string, { followerCount: number | null; bio: string | null; avatarUrl: string | null }>
  onOpen: (d: DetectionRow) => void
  onGotoTab: (t: Tab) => void
}) {
  const worthLook = useMemo(() => pickWorthALook(detections, 6), [detections])
  const biggestFan = useMemo(() => biggestFanToday(detections), [detections])
  const spike = useMemo(() => detectSpike(detections), [detections])

  if (detections.length === 0) {
    return <EmptyBriefing counts={counts} />
  }

  return (
    <div className="space-y-8">
      <SpendCard />

      <DashboardSection
        detections={detections}
        rangeRows={rangeRows}
        days={days}
        creatorScenes={creatorScenes}
        sceneLabels={sceneLabels}
        creatorProfiles={creatorProfiles}
        onGotoTab={onGotoTab}
      />

      <section>
        <header className="flex items-end justify-between mb-4">
          <div>
            <h2 className="text-[18px] font-medium tracking-tight">Worth a look</h2>
            <p className="text-[12px] text-[var(--color-ink-muted)] mt-0.5">
              Untagged first — the can is visible, the brand isn't named. Then reach and visibility.
            </p>
          </div>
          <button onClick={() => onGotoTab('feed')} className="text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">All detections →</button>
        </header>
        {worthLook.length === 0 ? (
          <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)]">No standout detections yet.</Card>
        ) : (
          <div className={HAIRLINE_GRID}>
            {worthLook.map((d) => (
              <PickCard key={d.detection_id} d={d} onOpen={() => onOpen(d)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {biggestFan && (
          <section>
            <header className="mb-4">
              <h2 className="text-[18px] font-medium tracking-tight">Today's biggest fan</h2>
              <p className="text-[12px] text-[var(--color-ink-muted)] mt-0.5">Most hits in the last 24 hours.</p>
            </header>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-[120px_1fr]">
                <div className="border-r border-[var(--color-border)]">
                  <MediaTile src={biggestFan.topDetection ? imageUrlFor(biggestFan.topDetection) : null} size="square" />
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <Link to={`/creators/${biggestFan.handle}`} className="text-[18px] font-medium hover:underline">@{biggestFan.handle}</Link>
                    {biggestFan.tier === 'tier_1' && <Badge tone="accent">tier 1</Badge>}
                  </div>
                  <div className="text-[13px] text-[var(--color-ink-muted)] mb-3 tabular-nums">
                    {biggestFan.hits} hit{biggestFan.hits === 1 ? '' : 's'} in the last 24h
                  </div>
                  <div className="mb-4">
                    <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1.5">14-day trend</div>
                    <Sparkline data={biggestFan.spark} height={28} tone="accent" />
                  </div>
                  <Link to={`/creators/${biggestFan.handle}`}><Button size="sm">View profile →</Button></Link>
                </div>
              </div>
            </Card>
          </section>
        )}

        <section>
          <header className="mb-4">
            <h2 className="text-[18px] font-medium tracking-tight">Spike detection</h2>
            <p className="text-[12px] text-[var(--color-ink-muted)] mt-0.5">Hashtags trending vs prior week.</p>
          </header>
          {spike ? (
            <Card className="p-5 border-l-2 border-l-[var(--color-accent)]">
              <div className="flex items-start gap-3 mb-3">
                <div className="text-[var(--color-accent)] text-[18px] leading-none">⚡</div>
                <div className="flex-1">
                  <div className="text-[15px] font-medium">#{spike.tag}</div>
                  <div className="text-[12px] text-[var(--color-ink-muted)] mt-0.5 tabular-nums">
                    {spike.now} creators this week · {spike.prev} prior week
                  </div>
                </div>
                <Badge tone="accent">+{Math.round(spike.pctDelta)}%</Badge>
              </div>
              <Button size="sm" variant="primary" onClick={() => onGotoTab('feed')}>Explore in feed →</Button>
            </Card>
          ) : (
            <Card className="p-5">
              <div className="text-[13px] text-[var(--color-ink-muted)]">No significant spikes this week.</div>
              <div className="text-[11px] text-[var(--color-ink-subtle)] mt-1">Need ≥80% jump and ≥3 unique creators.</div>
            </Card>
          )}
        </section>
      </div>

    </div>
  )
}

/**
 * Today's spend against the budget, on the dashboard.
 *
 * Renders nothing for read-only viewers: unit prices reveal margin. That is a
 * UI decision, not a security boundary — firestore.rules is where the usage
 * collection is actually closed off.
 *
 * Silent when nothing has been spent today. A prominent "$0.00" on a quiet
 * morning trains the eye to skip the card on the afternoon it matters.
 */
function SpendCard() {
  const { canWrite } = useMembership()
  const [today, setToday] = useState<UsageDay | null>(null)
  const [budget, setBudget] = useState(5)

  useEffect(() => {
    if (!canWrite) return
    let cancelled = false
    void Promise.all([fbListUsage(1), fbGetBrand()]).then(([u, b]) => {
      if (cancelled) return
      setToday(u[0] ?? null)
      if (typeof b?.dailyBudgetUsd === 'number') setBudget(b.dailyBudgetUsd)
    }).catch(() => { /* the dashboard must not break over a cost widget */ })
    return () => { cancelled = true }
  }, [canWrite])

  if (!canWrite || !today || today.estimatedSpendUsd <= 0) return null

  const spend = today.estimatedSpendUsd
  const rung = degradeLevel(spend, budget)
  const pct = Math.min(100, (spend / budget) * 100)
  const top = today.lines[0]

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[13px] font-medium">{fmtUsd(spend)} vandaag</span>
        <span className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
          van ${budget.toFixed(2)} budget
          {top && ` · meeste naar ${UNIT_META[top.key]?.label?.toLowerCase() ?? top.key}`}
        </span>
        <span className={`text-[11px] ${rung === 'normal' ? 'text-[var(--color-ink-subtle)]' : 'text-[var(--color-warn)]'}`}>
          {DEGRADE_LABEL[rung]}
        </span>
        <Link to="/kosten" className="ml-auto text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)] hover:underline">
          kostenoverzicht →
        </Link>
      </div>
      <div className="mt-2 h-1 bg-[var(--color-border)] relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${pct}%`, background: rung === 'normal' ? 'var(--color-ink)' : 'var(--color-warn)' }}
        />
      </div>
    </Card>
  )
}

function EmptyBriefing({ counts }: { counts: PipelineCounts | null }) {
  const hasAny = counts && (counts.creators > 0 || counts.posts > 0 || counts.discoveryQueue > 0)
  if (hasAny) {
    return (
      <Card className="p-10 text-center max-w-xl mx-auto">
        <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">Pipeline warming up</div>
        <h2 className="text-[20px] font-medium tracking-tight mb-3">Analysing what we found.</h2>
        <p className="text-[14px] text-[var(--color-ink-muted)] leading-relaxed mb-2">
          We scraped {counts!.posts} posts from {counts!.creators} creators.
          Detection runs in the background.
        </p>
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          First hits appear here within minutes.
        </p>
      </Card>
    )
  }
  return (
    <Card className="p-10 lg:p-14 text-center max-w-xl mx-auto">
      <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">Welcome</div>
      <h2 className="text-[22px] font-medium tracking-tight mb-3">Let's find your brand in the wild.</h2>
      <p className="text-[14px] text-[var(--color-ink-muted)] leading-relaxed mb-6">
        Run your first scan — we'll crawl Instagram and TikTok for posts featuring your products.
      </p>
      <div className="flex justify-center"><RunScanButton onComplete={() => window.location.reload()} /></div>
    </Card>
  )
}

// ─────────────────────── FEED ───────────────────────

// Which discovery class the feed is showing.
//
// `untagged` is the DEFAULT, and that is the product decision, not a preference:
// anyone can follow #stelz on Instagram for free, so a post carrying the brand
// hashtag is something the brand already had. The posts only this tool can find
// are the ones with the can in frame and no brand tag anywhere. See lib/signal.ts.
type FeedView = 'untagged' | 'tagged' | 'owned' | 'all'

function FeedTab({ rows, allDetections, truncated, lastSeenAt, onOpen }: { rows: DetectionRow[]; allDetections: DetectionRow[]; truncated: boolean; lastSeenAt: string | null; onOpen: (d: DetectionRow) => void }) {
  const [view, setView] = useState<FeedView>('untagged')
  const [search, setSearch] = useState('')
  const [productFilter, setProductFilter] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState<string | null>(null)
  const [trustFilter, setTrustFilter] = useState<'verified' | 'unreviewed' | 'fp' | null>('verified')
  const [platformFilter, setPlatformFilter] = useState<'instagram' | 'tiktok' | null>(null)
  const [typeFilter, setTypeFilter] = useState<'video' | 'image' | null>(null)
  const [angleFilter, setAngleFilter] = useState<'primary' | 'background' | null>(null)
  // Default 0.70, NOT 0.85 — and that is a correctness fix, not a preference.
  //
  // `confidence` is overwritten by the backend's strictness gate: any can that
  // isn't dominant/large in frame is forced to exactly 0.70 regardless of what
  // the model said (three golden-set cans rated 0.95 are stored as 0.70). So
  // >=0.85 was silently a "can fills the frame" filter, and it removed every
  // medium and small can — which is most of the untagged feed, because a post
  // nobody tagged is usually one where the can is incidental. See lib/quality.ts
  // for the measured table.
  //
  // The demoted band is noisier, so it is not merged into the feed silently —
  // it renders under its own heading below. Showing it unlabelled is what makes
  // a wrong can read as "the tool is broken".
  const [minConfidence, setMinConfidence] = useState<number>(0.7)
  // Progressive rendering — everything matching is reachable via "Show more".
  const [visibleCount, setVisibleCount] = useState(60)

  // Base for the view switch counts and the empty state: everything the OTHER
  // filters allow, before the discovery view is applied. Without this the pill
  // counts would change as you switch views, which reads as a bug.
  const beforeView = useMemo(() => {
    return rows.filter((d) => {
      if (productFilter && d.product_line !== productFilter) return false
      if (tierFilter && d.creator_tier !== tierFilter) return false
      if (trustFilter === 'verified' && d.is_false_positive === true) return false
      if (trustFilter === 'unreviewed' && (d.verified === true || d.is_false_positive === true)) return false
      if (trustFilter === 'fp' && d.is_false_positive !== true) return false
      if (platformFilter && d.platform !== platformFilter) return false
      if (typeFilter === 'video' && d.frame_idx == null) return false
      if (typeFilter === 'image' && d.frame_idx != null) return false
      if (angleFilter === 'primary' && !isPrimaryAngle(d)) return false
      if (angleFilter === 'background' && isPrimaryAngle(d)) return false
      if ((d.confidence ?? 0) < minConfidence) return false
      if (search) {
        const q = search.toLowerCase()
        if (!`${d.creator_handle ?? ''} ${d.post_caption ?? ''} ${d.context ?? ''}`.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [rows, search, productFilter, tierFilter, trustFilter, platformFilter, typeFilter, angleFilter, minConfidence])

  const viewCounts = useMemo(() => signalCounts(beforeView), [beforeView])

  const matchesView = (d: DetectionRow, v: FeedView) => {
    const s = d.signal?.signal ?? 'visual_only'
    if (v === 'untagged') return s === 'visual_only'
    if (v === 'tagged') return s === 'hashtag' || s === 'mention'
    if (v === 'owned') return s === 'brand_owned'
    return true
  }

  const filtered = useMemo(() => {
    return rows.filter((d) => {
      if (!matchesView(d, view)) return false
      if (productFilter && d.product_line !== productFilter) return false
      if (tierFilter && d.creator_tier !== tierFilter) return false
      if (trustFilter === 'verified' && d.is_false_positive === true) return false
      if (trustFilter === 'unreviewed' && (d.verified === true || d.is_false_positive === true)) return false
      if (trustFilter === 'fp' && d.is_false_positive !== true) return false
      if (platformFilter && d.platform !== platformFilter) return false
      if (typeFilter === 'video' && d.frame_idx == null) return false
      if (typeFilter === 'image' && d.frame_idx != null) return false
      if (angleFilter === 'primary' && !isPrimaryAngle(d)) return false
      if (angleFilter === 'background' && isPrimaryAngle(d)) return false
      if ((d.confidence ?? 0) < minConfidence) return false
      if (search) {
        const q = search.toLowerCase()
        if (!`${d.creator_handle ?? ''} ${d.post_caption ?? ''} ${d.context ?? ''}`.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [rows, view, search, productFilter, tierFilter, trustFilter, platformFilter, typeFilter, angleFilter, minConfidence])

  // Reset pagination when any filter narrows/changes the result set.
  //
  // During render, not in an effect: as an effect the newly-filtered list first
  // painted at whatever count the previous filter had been scrolled to — so
  // narrowing a filter after "load more" briefly showed a longer list than the
  // filter allows, then snapped back. Folded into one string because useResetOn
  // compares a single value with Object.is, and every part here is a primitive.
  //
  // JSON.stringify rather than join(): `search` is free text, so a separator
  // that can occur inside a value makes different filter sets collide — search
  // "a b" with view "c" would produce the same key as search "a" with view
  // "b c", and the reset would not fire.
  useResetOn(
    JSON.stringify([view, search, productFilter, tierFilter, trustFilter,
                    platformFilter, typeFilter, angleFilter, minConfidence]),
    () => setVisibleCount(60),
  )

  // Rejected in this session. The write goes to Firestore via rateDetection,
  // but the refetch is on a timer, so the card is pulled optimistically and
  // restored if the call fails.
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [rejectError, setRejectError] = useState<string | null>(null)
  // Non-members never get the ✕ at all. The server refuses their write anyway
  // (main.py._require_brand_member); showing a control that always 403s reads
  // as a broken tool rather than as a permission boundary.
  const { canWrite } = useMembership()

  const reject = useCallback(async (d: DetectionRow) => {
    const key = parentPostKey(d)
    setRejected((s) => new Set(s).add(key))
    setRejectError(null)
    // A post can hold many detection docs (video frames, carousel slots).
    // Rate every sibling or the post returns on the next refetch — same
    // reasoning as ReviewTab.rate.
    const ids = allDetections.filter((x) => parentPostKey(x) === key).map((x) => x.detection_id)
    try {
      await Promise.all((ids.length ? ids : [d.detection_id]).map((id) => rateDetection(id, 'rejected')))
    } catch (e) {
      setRejected((s) => { const n = new Set(s); n.delete(key); return n })
      setRejectError((e as Error).message)
    }
  }, [allDetections])

  const visible = useMemo(
    () => filtered.filter((d) => !rejected.has(parentPostKey(d))),
    [filtered, rejected],
  )

  // Two chronological bands rather than one mixed list. The demoted band runs
  // ~1-in-3 wrong on the labelled golden set, and no field in the data
  // separates its good rows from its bad ones (see lib/quality.ts) — so the
  // honest choices are "hide it" or "show it clearly marked". Hiding it is what
  // produced a 49-row feed.
  const page = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount])
  const rawBands = useMemo(() => splitByQuality(page), [page])
  const reviewTotal = useMemo(() => visible.filter((d) => detectionQuality(d).needsLook).length, [visible])

  // Rows whose own label transcript reads as a different brand — the model read
  // "TRULY" or "HEINEKEN" and a Stelz variant in the same string. Measured cost
  // on the golden set: zero true positives affected (lib/verify.ts). Held back
  // rather than deleted, and the count is always shown, because a silent drop
  // is how a recall bug hides.
  const [showRivals, setShowRivals] = useState(false)
  const bands = useMemo(() => {
    const rivals = rawBands.review.filter((d) => verifyDetection(d).competitor)
    const kept = showRivals
      ? sortByEvidence(rawBands.review)
      : sortByEvidence(rawBands.review.filter((d) => !verifyDetection(d).competitor))
    return { clear: rawBands.clear, review: kept, rivals: rivals.length }
  }, [rawBands, showRivals])

  const productLines = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) if (r.product_line) m.set(r.product_line, (m.get(r.product_line) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  // Detections the strict default is hiding. The backend's strictness gate
  // forces confidence to exactly 0.70 whenever the model was confident but the
  // can wasn't dominant/large in frame (detect_image._strictness_gate,
  // "capped_small_object"). The default >=0.85 filter then hides every one of
  // them — which is most genuine cans in party/festival footage. Surface the
  // count so this is visible instead of silent.
  // Scoped to the ACTIVE view — otherwise the banner offers to unhide gated
  // detections that are tagged and wouldn't show up in this view anyway.
  const gatedHidden = useMemo(() => {
    if (minConfidence <= 0.7) return 0
    return rows.filter((r) => {
      if (!matchesView(r, view)) return false
      const c = r.confidence ?? 0
      return c >= 0.7 && c < minConfidence
    }).length
  }, [rows, view, minConfidence])

  const VIEWS: { id: FeedView; label: string; count: number }[] = [
    { id: 'untagged', label: 'Untagged', count: viewCounts.visual_only },
    { id: 'tagged', label: 'Tagged', count: viewCounts.hashtag + viewCounts.mention },
    { id: 'owned', label: 'Brand accounts', count: viewCounts.brand_owned },
    { id: 'all', label: 'All', count: beforeView.length },
  ]

  return (
    <div className="space-y-5">
      {/* The discovery view switch. Deliberately a mode switch, not another
          dropdown in the filter row — it answers a different question ("what is
          this tool FOR?") than "narrow these results". */}
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`px-3.5 py-1.5 text-[12px] font-medium uppercase tracking-wide border transition-colors ${
                view === v.id
                  ? 'bg-[var(--color-ink)] text-white border-[var(--color-ink)]'
                  : 'bg-transparent text-[var(--color-ink-muted)] border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'
              }`}
            >
              {v.label}
              <span className="ml-1.5 tabular-nums opacity-70">{v.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
        {view === 'untagged' && (
          <p className="mt-2 text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-2xl">
            Posts showing Stëlz with no #stelz, no @drinkstelz, and not from a brand account.
            Anyone can follow #stelz for free — <strong className="text-[var(--color-ink)]">these are
            the ones only this tool finds.</strong>
          </p>
        )}
        {view === 'owned' && (
          <p className="mt-2 text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-2xl">
            Stëlz' own accounts and distributors. Kept out of the main feed — this is your
            content, not a discovery.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px] max-w-md">
          <Input placeholder="Search creator, caption, context…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <FilterDropdown label="Platform" value={platformFilter} onChange={(v) => setPlatformFilter(v as 'instagram' | 'tiktok' | null)} options={[
          { id: 'instagram' as const, label: 'Instagram', count: rows.filter((r) => r.platform === 'instagram').length },
          { id: 'tiktok' as const, label: 'TikTok', count: rows.filter((r) => r.platform === 'tiktok').length },
        ]} />
        <FilterDropdown label="Type" value={typeFilter} onChange={(v) => setTypeFilter(v as 'video' | 'image' | null)} options={[
          { id: 'video' as const, label: 'Video', count: rows.filter((r) => r.frame_idx != null).length },
          { id: 'image' as const, label: 'Image', count: rows.filter((r) => r.frame_idx == null).length },
        ]} />
        {/* "Alle hoeken behouden": nothing is ever discarded for being small or
            non-primary — the gate only caps confidence. This facet makes that
            visible instead of leaving it a claim in a document. */}
        <FilterDropdown label="Angle" value={angleFilter} onChange={(v) => setAngleFilter(v as 'primary' | 'background' | null)} options={[
          { id: 'primary' as const, label: 'Can is the subject', count: rows.filter((r) => isPrimaryAngle(r)).length },
          { id: 'background' as const, label: 'Background / incidental', count: rows.filter((r) => !isPrimaryAngle(r)).length },
        ]} />
        <FilterDropdown label="Product" value={productFilter} onChange={(v) => setProductFilter(v as string | null)} options={productLines.map(([k, n]) => ({ id: k, label: PRODUCT_LINE_LABEL[k] ?? k, count: n }))} />
        <FilterDropdown label="Tier" value={tierFilter} onChange={(v) => setTierFilter(v as string | null)} options={['tier_1', 'tier_2', 'tier_3'].map((t, i) => ({ id: t, label: `Tier ${i + 1}`, count: rows.filter((r) => r.creator_tier === t).length }))} />
        {/* "Verified + auto" was a lie: this option only excludes rows a
            moderator REJECTED — it does not require anyone to have confirmed
            them. Reading it as "verified" is exactly how unreviewed hits get
            trusted. Named for what it does. */}
        <FilterDropdown label="Review" value={trustFilter} onChange={(v) => setTrustFilter(v as 'verified' | 'unreviewed' | 'fp' | null)} options={[
          { id: 'verified' as const, label: 'Not rejected', count: rows.filter((r) => r.is_false_positive !== true).length },
          { id: 'unreviewed' as const, label: 'Not yet checked', count: rows.filter((r) => r.verified !== true && r.is_false_positive !== true).length },
          { id: 'fp' as const, label: 'Rejected', count: rows.filter((r) => r.is_false_positive === true).length },
        ]} />
        {/* Labelled by what the number MEANS, not by the number. See the
            comment on minConfidence above: >=0.85 is a can-size filter. */}
        <FilterDropdown label="Can size" value={minConfidence} onChange={(v) => setMinConfidence((v as number | null) ?? 0)} options={[
          { id: 0.85, label: 'Large in frame only', count: rows.filter((r) => (r.confidence ?? 0) >= 0.85).length },
          { id: 0.7, label: 'Include small / background', count: rows.filter((r) => (r.confidence ?? 0) >= 0.7).length },
          { id: 0, label: 'Everything, incl. weak reads', count: rows.length },
        ]} />
        {/* Reset restores the PRODUCT default (untagged), not "show everything". */}
        {(productFilter || tierFilter || search || platformFilter || typeFilter || angleFilter || trustFilter !== 'verified' || minConfidence !== 0.7 || view !== 'untagged') && (
          <button onClick={() => { setProductFilter(null); setTierFilter(null); setSearch(''); setTrustFilter('verified'); setPlatformFilter(null); setTypeFilter(null); setAngleFilter(null); setMinConfidence(0.7); setView('untagged') }} className="text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline">Reset</button>
        )}
        <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
          {visible.length.toLocaleString()} of {rows.length.toLocaleString()}
        </span>
      </div>

      {gatedHidden > 0 && (
        <button
          onClick={() => setMinConfidence(0.7)}
          className="w-full text-left px-4 py-3 border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-bg)] transition-colors"
        >
          <span className="text-[13px] text-[var(--color-ink)]">
            <strong className="tabular-nums">{gatedHidden.toLocaleString()}</strong> more{' '}
            {gatedHidden === 1 ? 'detection is' : 'detections are'} hidden by this filter.
          </span>
          <span className="block text-[12px] text-[var(--color-ink-muted)] mt-0.5 leading-relaxed">
            These were capped at 70% because the can wasn't dominant in frame — not because the
            brand was uncertain. Most genuine cans in party and festival footage land here.{' '}
            <span className="underline text-[var(--color-ink)]">Show them</span>
          </span>
        </button>
      )}

      {truncated && (
        <div className="px-4 py-2.5 border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
          <strong className="text-[var(--color-ink)]">This page is showing the newest {DETECTION_FETCH_LIMIT.toLocaleString()} detections only.</strong>{' '}
          Older hits exist but aren't loaded, so counts here are a floor, not a total.
        </div>
      )}

      {rejectError && (
        <div className="px-4 py-2 border border-[var(--color-bad)] text-[12px] text-[var(--color-bad)]">
          Could not save that rejection: {rejectError}
        </div>
      )}

      {visible.length === 0 ? (
        // The empty state is load-bearing here. The feed now defaults to
        // untagged, so a brand whose hits are all hashtag-sourced would land on
        // a blank screen and conclude the tool is broken. Say what is actually
        // happening and offer the way out.
        view === 'untagged' && beforeView.length > 0 ? (
          <Card className="px-6 py-14 text-center">
            <p className="text-[14px] text-[var(--color-ink)] font-medium">
              No untagged hits match these filters.
            </p>
            <p className="mt-2 text-[13px] text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
              Every hit here carries #stelz, an @mention, or comes from a brand account —
              content Instagram already surfaces for free. That is a discovery problem,
              not a display one.
            </p>
            <button
              onClick={() => setView('all')}
              className="mt-4 rounded-full border border-[var(--color-ink)] px-5 py-2 text-[12px] font-medium uppercase tracking-wide text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white transition-colors"
            >
              Show all {beforeView.length.toLocaleString()}
            </button>
          </Card>
        ) : (
          <Card className="px-6 py-16 text-center text-[13px] text-[var(--color-ink-subtle)]">No detections match.</Card>
        )
      ) : (
        <>
          {bands.clear.length > 0 && (
            <div className={CARD_GRID}>
              {bands.clear.map((d) => (
                <FeedCard
                  key={d.detection_id}
                  d={d}
                  isNew={!!(lastSeenAt && d.posted_at && d.posted_at > lastSeenAt)}
                  onOpen={() => onOpen(d)}
                  onReject={canWrite ? () => void reject(d) : undefined}
                />
              ))}
            </div>
          )}

          {bands.review.length > 0 && (
            <>
              {/* The honesty band. Naming the error rate up front is what turns
                  a wrong can from "this tool is broken" into "that is the one
                  in three I was told to check". */}
              <div className="pt-4 border-t border-[var(--color-border-strong)]">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-ink)]">
                    Worth a check
                  </h3>
                  <span className="text-[11px] tabular-nums text-[var(--color-ink-subtle)]">
                    {bands.review.length.toLocaleString()}
                    {reviewTotal > bands.review.length ? ` of ${reviewTotal.toLocaleString()}` : ''}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-2xl">
                  The can is small, distant, or only partly readable here. These were scored
                  down for <strong className="text-[var(--color-ink)]">size, not doubt</strong> —
                  most genuine cans at parties and festivals land in this band, and so do most
                  of the mistakes. Best-evidenced first: rows tagged{' '}
                  <span className="text-[var(--color-warn)]">name only</span> had nothing but the
                  word STËLZ read off them, no label text.{' '}
                  {canWrite && (
                    <span className="text-[var(--color-ink-subtle)]">Hit ✕ on anything that isn't Stëlz — it won't come back.</span>
                  )}
                </p>
                {bands.rivals > 0 && (
                  <button
                    onClick={() => setShowRivals((v) => !v)}
                    className="mt-2 text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline"
                  >
                    {showRivals ? 'Hide' : 'Show'} {bands.rivals}{' '}
                    {bands.rivals === 1 ? 'hit whose label' : 'hits whose labels'} read as another brand
                  </button>
                )}
              </div>
              <div className={CARD_GRID}>
                {bands.review.map((d) => (
                  <FeedCard
                    key={d.detection_id}
                    d={d}
                    isNew={!!(lastSeenAt && d.posted_at && d.posted_at > lastSeenAt)}
                    onOpen={() => onOpen(d)}
                    onReject={canWrite ? () => void reject(d) : undefined}
                  />
                ))}
              </div>
            </>
          )}

          {visible.length > visibleCount && (
            <div className="flex flex-col items-center gap-2 pt-2">
              <button
                onClick={() => setVisibleCount((c) => c + 60)}
                className="rounded-full border border-[var(--color-ink)] px-6 py-2 text-[12px] font-medium uppercase tracking-wide text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white transition-colors"
              >
                Show more
              </button>
              <span className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
                Showing {Math.min(visibleCount, visible.length)} of {visible.length.toLocaleString()}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Why this hit is in the feed. Shown in EVERY view, including 'untagged' where
// it is technically redundant — a badge that disappears when you switch views
// reads as a glitch, and a consistent one makes the card screenshot-able.
function SignalBadge({ d }: { d: DetectionRow }) {
  const s = d.signal
  if (!s) return null
  if (s.signal === 'visual_only') {
    return (
      <>
        {/* A misspelled brand tag is still a discovery — searching #stelz will
            not surface #steltz — but "no tag" beside a visible #steltz chip
            reads as a broken tool. Naming the misspelling says the same thing
            and survives being looked at. */}
        {s.misspelledTag
          ? <span title={`Tagged #${s.misspelledTag} — a misspelling. Searching the correct spelling would not find this post.`}>
              <Badge tone="warn">typo</Badge>
            </span>
          : <Badge tone="accent">no tag</Badge>}
        {/* The brand IS named in the caption, but Instagram has no caption
            search — so the post stays a genuine discovery. Surfaced so a
            reviewer who reads "STËLZ!" in the text doesn't think we missed it. */}
        {s.namedInCaption && <Badge tone="warn">in text</Badge>}
      </>
    )
  }
  if (s.signal === 'brand_owned') return <Badge>brand acct</Badge>
  return <Badge>tagged</Badge>
}

// A hit that a second, higher-resolution pass independently identified as Stëlz
// rather than a lookalike. Only shown for 'upgraded' — 'confirmed' means the
// verifier agreed but wasn't certain enough to promote, and claiming a
// double-check on that would overstate it. See lib/verifier.py.
function VerifiedBadge({ d }: { d: DetectionRow }) {
  if (d.verify_verdict !== 'upgraded') return null
  return (
    <span title={d.verify_reason ?? 'Re-read at higher resolution and identified as Stëlz.'}>
      <Badge tone="good">double-checked</Badge>
    </span>
  )
}

// How the caption talks about the brand. Rendered only when scored — an
// unscored hit shows nothing rather than defaulting to neutral, because the
// backfill runs in batches and "no badge" must not read as "no opinion".
// Neutral itself stays unbadged too: it is the majority case and a badge on
// every second card would drown the two labels worth noticing.
const SENTIMENT_BADGE: Record<string, { label: string; tone: 'good' | 'bad' | 'muted' }> = {
  positive: { label: 'positive', tone: 'good' },
  negative: { label: 'negative', tone: 'bad' },
  promotional: { label: 'promo', tone: 'muted' },
}

function SentimentBadge({ d }: { d: DetectionRow }) {
  const spec = d.sentiment ? SENTIMENT_BADGE[d.sentiment] : null
  if (!spec) return null
  return (
    <span title={d.sentiment_rationale ?? `Caption reads as ${d.sentiment}.`}>
      <Badge tone={spec.tone}>{spec.label}</Badge>
    </span>
  )
}

function FeedCard({ d, isNew, onOpen, onReject }: { d: DetectionRow; isNew: boolean; onOpen: () => void; onReject?: () => void }) {
  const tags = (d.post_hashtags ?? []).slice(0, 4)
  const extraTags = (d.post_hashtags?.length ?? 0) - tags.length
  const conf = (d.confidence ?? 0) * 100
  const q = detectionQuality(d)
  const v = verifyDetection(d)
  const story = storyExpiry(d)
  return (
    // A div, not a button: the reject control below is itself a button, and
    // nesting buttons is invalid HTML (React will warn, and the inner click
    // target behaves inconsistently across browsers).
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="cursor-pointer text-left bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] focus-visible:border-[var(--color-ink)] focus-visible:outline-none transition-colors flex flex-col group"
    >
      {/* Media */}
      <MediaTile src={imageUrlFor(d)} size="card">
        {isNew && !story && (
          <span className="absolute top-2 left-2 text-[10px] uppercase tracking-widest bg-[var(--color-accent)] text-white px-2 py-0.5">
            Nieuw
          </span>
        )}
        <span className="absolute top-2 right-2 text-[10px] uppercase tracking-widest bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
          {d.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
        </span>
        {/* A story we caught is worth MORE once it has expired: it no longer
            exists anywhere else. Hence the label, not a hidden row. */}
        {story && (
          <span className={`absolute top-2 left-2 text-[10px] uppercase tracking-widest px-2 py-0.5 text-white ${story.expired ? 'bg-[var(--color-ink-muted)]' : 'bg-[var(--color-accent)]'}`}>
            {story.label}
          </span>
        )}
        {d.frame_idx != null && (
          <span className="absolute bottom-2 right-2 text-[10px] bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
            ▶ video{(d.frame_hits ?? 0) > 1 ? ` · ${d.frame_hits} frames` : ''}
          </span>
        )}
        {/* One-click reject. The demoted band is ~1-in-3 wrong and no filter can
            clean it (lib/quality.ts), so the answer to "too many wrong cans" is
            making them one click to kill — not a stricter threshold, which is
            what hid the real ones in the first place. Writes through the same
            callable the Review tab uses, and covers every frame/slot of the post. */}
        {onReject && (
          <button
            type="button"
            title="Not Stëlz — reject this post"
            aria-label="Not Stëlz — reject this post"
            onClick={(e) => { e.stopPropagation(); onReject() }}
            className="absolute bottom-2 left-2 w-7 h-7 flex items-center justify-center bg-[var(--color-ink)]/70 text-white text-[13px] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[var(--color-bad)] transition-opacity"
          >
            ✕
          </button>
        )}
      </MediaTile>

      {/* Body */}
      <div className="p-3.5 flex flex-col gap-2.5 flex-1">
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
          <span className="text-[13px] font-medium truncate max-w-full">@{d.creator_handle}</span>
          <SignalBadge d={d} />
          <VerifiedBadge d={d} />
          <SentimentBadge d={d} />
          {d.creator_tier === 'tier_1' && <Badge tone="accent">T1</Badge>}
          {d.verified === true && <Badge tone="good">✓</Badge>}
          {d.is_false_positive === true && <Badge tone="bad">FP</Badge>}
          {/* Deliberately NOT the raw percentage for demoted rows. A capped hit
              reads "70%" while the model actually said 95% — the number is an
              artefact of the size gate, and showing it trains the eye to
              distrust exactly the rows that are most often genuine. */}
          {v.competitor ? (
            <span className="ml-auto text-[11px] font-medium shrink-0 text-[var(--color-bad)]" title={v.reason}>
              reads "{v.competitor}"
            </span>
          ) : q.quality === 'small' ? (
            <span className="ml-auto text-[11px] font-medium shrink-0 text-[var(--color-warn)]" title={q.reason}>
              {v.tier === 'wordmark_only' ? 'name only' : 'small in frame'}
            </span>
          ) : (
            <span className={`ml-auto text-[12px] tabular-nums font-medium shrink-0 ${q.quality === 'clear' ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}`}>
              {conf.toFixed(0)}%
            </span>
          )}
        </div>

        {d.product_line && (
          <div className="text-[11px] text-[var(--color-ink-muted)]">
            {PRODUCT_LINE_LABEL[d.product_line] ?? d.product_line}
            {d.surface_type ? ` · on ${d.surface_type.replace(/_/g, ' ')}` : ''}
          </div>
        )}

        {(d.post_caption || d.context) && (
          <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed line-clamp-2">
            {d.post_caption ?? d.context}
          </p>
        )}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 border border-[var(--color-border)] text-[var(--color-ink-muted)] bg-[var(--color-bg)]">
                #{t}
              </span>
            ))}
            {extraTags > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 text-[var(--color-ink-subtle)]">+{extraTags}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-[11px] text-[var(--color-ink-subtle)] tabular-nums mt-auto pt-1">
          <span className="flex items-center gap-2.5">
            {(d.likes_count ?? 0) > 0 && <span>♥ {compactNum(d.likes_count!)}</span>}
            {(d.views_count ?? 0) > 0 && <span>▶ {compactNum(d.views_count!)}</span>}
            {d.music?.title && <span className="truncate max-w-[110px]">♫ {d.music.title}</span>}
          </span>
          <span className="shrink-0">{d.posted_at ? timeAgo(d.posted_at) : '—'}</span>
        </div>
      </div>
    </div>
  )
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ─────────────────────── REVIEW (approve / reject queue) ───────────────────────

function ReviewTab({ detections, allDetections }: { detections: DetectionRow[]; allDetections: DetectionRow[] }) {
  // Local queue: unreviewed hits (post-level). `handled` tracks in-session
  // decisions keyed by PARENT POST so the card advances instantly and a
  // decision covers every frame/slot doc of that post.
  const [handled, setHandled] = useState<Record<string, 'confirmed' | 'rejected'>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { canWrite } = useMembership()

  const queue = useMemo(
    () => detections.filter(
      (d) => d.detected === true && d.verified !== true && d.is_false_positive !== true && !handled[parentPostKey(d)],
    ),
    [detections, handled],
  )
  const current = queue[0] ?? null
  const doneCount = Object.keys(handled).length

  const rate = useCallback(async (verdict: 'confirmed' | 'rejected') => {
    // Guards the keyboard path too (← / →), not just the buttons — otherwise a
    // read-only visitor can still fire a write by pressing an arrow key.
    if (!current || busy || !canWrite) return
    setBusy(true); setError(null)
    const key = parentPostKey(current)
    // A post can have many detection docs (video frames, carousel slots).
    // Rate ALL of them — otherwise an unrated sibling resurrects the post
    // in the queue after the next refetch.
    const siblingIds = allDetections
      .filter((d) => parentPostKey(d) === key)
      .map((d) => d.detection_id)
    const ids = siblingIds.length > 0 ? siblingIds : [current.detection_id]
    // Optimistic: advance immediately; revert on failure.
    setHandled((h) => ({ ...h, [key]: verdict }))
    try {
      await Promise.all(ids.map((id) => rateDetection(id, verdict)))
    } catch (e) {
      setHandled((h) => { const c = { ...h }; delete c[key]; return c })
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [current, busy, allDetections, canWrite])

  // Keyboard: ← reject, → approve
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') void rate('confirmed')
      if (e.key === 'ArrowLeft') void rate('rejected')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rate])

  if (!current) {
    return (
      <Card className="p-14 text-center max-w-lg mx-auto">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-subtle)] mb-3">Review queue</div>
        <h2 className="stelz-display text-[24px] mb-2 text-[var(--color-ink)]">All clear</h2>
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          {doneCount > 0 ? `You reviewed ${doneCount} detection${doneCount === 1 ? '' : 's'} this session. ` : ''}
          Nothing waiting for review.
        </p>
      </Card>
    )
  }

  const conf = (current.confidence ?? 0) * 100
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between text-[12px] text-[var(--color-ink-muted)]">
        <span className="tabular-nums">{queue.length} waiting · {doneCount} done this session</span>
        {canWrite && <span className="hidden sm:inline text-[var(--color-ink-subtle)]">← reject · approve →</span>}
      </div>

      {error && (
        <div className="border border-[var(--color-bad)] text-[12px] text-[var(--color-bad)] px-3 py-2">{error}</div>
      )}

      <Card className="overflow-hidden">
        {/* Media */}
        <div className="relative bg-[var(--color-bg)]">
          {/* The judgement surface: contain, not cover — a moderator must see
              the whole frame, not a crop of it. */}
          <MediaTile src={imageUrlFor(current)} size="hero" fit="contain" priority />
          <span className="absolute top-3 right-3 text-[10px] uppercase tracking-widest bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
            {current.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
          </span>
          {current.frame_idx != null && (
            <span className="absolute bottom-3 right-3 text-[10px] bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
              ▶ video frame {current.frame_idx}
            </span>
          )}
        </div>

        {/* Facts */}
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={`/creators/${current.creator_handle}`} className="text-[15px] font-medium hover:underline">
              @{current.creator_handle}
            </Link>
            {current.creator_tier === 'tier_1' && <Badge tone="accent">T1</Badge>}
            {current.product_line && <Badge tone="muted">{PRODUCT_LINE_LABEL[current.product_line] ?? current.product_line}</Badge>}
            <span className={`ml-auto text-[14px] tabular-nums font-medium ${conf >= 85 ? 'text-[var(--color-good)]' : conf >= 75 ? 'text-[var(--color-warn)]' : 'text-[var(--color-bad)]'}`}>
              {conf.toFixed(0)}%
            </span>
          </div>

          {(current.visible_text || current.surface_type || current.context) && (
            <div className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed space-y-1">
              {current.visible_text && <div><span className="text-[var(--color-ink-subtle)]">Text read:</span> "{current.visible_text}"</div>}
              {current.surface_type && <div><span className="text-[var(--color-ink-subtle)]">Surface:</span> {current.surface_type.replace(/_/g, ' ')}</div>}
              {current.context && <div><span className="text-[var(--color-ink-subtle)]">AI notes:</span> {current.context}</div>}
            </div>
          )}

          {current.post_caption && (
            <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed line-clamp-2 border-t border-[var(--color-border)] pt-3">
              "{current.post_caption}"
            </p>
          )}

          {current.post_url && (
            <a href={current.post_url} target="_blank" rel="noreferrer" className="inline-block text-[12px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]">
              Open original post ↗
            </a>
          )}
        </div>

        {/* Verdict buttons — hidden entirely for read-only visitors. The queue
            itself stays browsable: seeing what's pending is a read. */}
        {canWrite ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-border)]">
            <button
              onClick={() => void rate('rejected')}
              disabled={busy}
              className="py-4 text-[13px] font-medium uppercase tracking-wide text-[var(--color-bad)] hover:bg-[var(--color-bad)] hover:text-white transition-colors border-r border-[var(--color-border)] disabled:opacity-50"
            >
              ✗ Not Stëlz
            </button>
            <button
              onClick={() => void rate('confirmed')}
              disabled={busy}
              className="py-4 text-[13px] font-medium uppercase tracking-wide text-[var(--color-good)] hover:bg-[var(--color-good)] hover:text-white transition-colors disabled:opacity-50"
            >
              ✓ Confirm
            </button>
          </div>
        ) : (
          <div className="border-t border-[var(--color-border)] py-4 text-center text-[12px] text-[var(--color-ink-subtle)]">
            Read-only — note what's wrong instead of voting on it.
          </div>
        )}
      </Card>

      {/* Next up preview strip */}
      {queue.length > 1 && (
        <div className="flex gap-1.5">
          {queue.slice(1, 9).map((d) => (
            <div key={d.detection_id} className="w-12 h-12 border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
              <Img src={imageUrlFor(d)} />
            </div>
          ))}
          {queue.length > 9 && (
            <div className="w-12 h-12 border border-[var(--color-border)] flex items-center justify-center text-[10px] text-[var(--color-ink-subtle)] tabular-nums">
              +{queue.length - 9}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────── CREATORS ───────────────────────

function CreatorsTab({ detections, resonance, creatorProfiles }: {
  detections: DetectionRow[]
  resonance: ResonanceRow[]
  creatorProfiles: Record<string, { followerCount: number | null; bio: string | null; avatarUrl: string | null }>
}) {
  // Three possible sources, in order of freshness:
  //   1. the creator record  — updated by the profile refresh, current
  //   2. the resonance doc   — a copy of the creator record as of the last SRS
  //   3. the detection       — a copy as of when the post was analysed
  //
  // Preferring the record is what makes a profile refresh visible immediately.
  // Reading resonance first meant a refresh only showed up after the NEXT SRS
  // run, which looked exactly like the refresh having done nothing.
  const followersByHandle = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of resonance) {
      if (r.follower_count && r.follower_count > 0) m.set(r.creator_handle.toLowerCase(), r.follower_count)
    }
    for (const [handle, p] of Object.entries(creatorProfiles)) {
      if (p.followerCount && p.followerCount > 0) m.set(handle, p.followerCount)
    }
    return m
  }, [resonance, creatorProfiles])
  const avatarByHandle = useMemo(() => {
    const m = new Map<string, string>()
    for (const [handle, p] of Object.entries(creatorProfiles)) {
      if (p.avatarUrl) m.set(handle, p.avatarUrl)
    }
    return m
  }, [creatorProfiles])
  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<'hits' | 'followers' | 'recent'>('hits')

  // Projects: which creators are being tracked, and the strip up top. One
  // fetch per tab mount; the AddToProject menus keep their own state.
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => { fetchProjects().then(setProjects).catch(() => setProjects([])) }, [])
  const projectsByCreator = useMemo(() => {
    const m = new Map<string, Project[]>()
    for (const p of projects) {
      if (p.archived) continue
      for (const cid of p.creatorIds) {
        const arr = m.get(cid)
        if (arr) arr.push(p)
        else m.set(cid, [p])
      }
    }
    return m
  }, [projects])

  // Built purely from actual detections — no separate scoring table.
  const rows = useMemo(() => {
    type Row = {
      handle: string
      platform: string
      hits: number
      followers: number | null
      totalLikes: number
      totalViews: number
      avatar: string | null
      lastSeen: string | null
      topProduct: string | null
      recent: DetectionRow[]
      spark: { d: string; n: number }[]
    }
    const m = new Map<string, Row>()
    for (const d of detections) {
      if (!d.creator_handle || d.detected !== true) continue
      const cur = m.get(d.creator_handle) ?? {
        handle: d.creator_handle,
        platform: d.platform,
        hits: 0,
        followers: d.follower_count,
        totalLikes: 0,
        totalViews: 0,
        avatar: null,
        lastSeen: null,
        topProduct: null,
        recent: [],
        spark: [],
      }
      cur.hits++
      cur.totalLikes += d.likes_count ?? 0
      cur.totalViews += d.views_count ?? 0
      if ((d.follower_count ?? 0) > (cur.followers ?? 0)) cur.followers = d.follower_count
      if (!cur.followers) cur.followers = followersByHandle.get(d.creator_handle.toLowerCase()) ?? null
      if (!cur.avatar && d.extras?.author?.avatar) cur.avatar = d.extras.author.avatar
      if (!cur.lastSeen || (d.posted_at ?? '') > cur.lastSeen) cur.lastSeen = d.posted_at
      if (cur.recent.length < 4) cur.recent.push(d)
      m.set(d.creator_handle, cur)
    }
    for (const row of m.values()) {
      const products = new Map<string, number>()
      for (const d of row.recent) if (d.product_line) products.set(d.product_line, (products.get(d.product_line) ?? 0) + 1)
      row.topProduct = [...products.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      row.spark = bucketByDay(detections.filter((d) => d.creator_handle === row.handle && d.detected).map((d) => d.posted_at), 14)
    }
    let out = [...m.values()]
    if (search) out = out.filter((r) => r.handle.toLowerCase().includes(search.toLowerCase()))
    if (platformFilter) out = out.filter((r) => r.platform === platformFilter)
    out.sort((a, b) => {
      if (sort === 'hits') return b.hits - a.hits
      if (sort === 'followers') return (b.followers ?? 0) - (a.followers ?? 0)
      return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')
    })
    return out
  }, [detections, search, platformFilter, sort, followersByHandle])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px] max-w-md">
          <Input placeholder="Search by handle…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="inline-flex gap-1.5">
          {(['instagram', 'tiktok'] as const).map((p) => (
            <button key={p} onClick={() => setPlatformFilter(platformFilter === p ? null : p)} className={`rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${platformFilter === p ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-ink)] text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white'}`}>
              {p === 'tiktok' ? 'TikTok' : 'Instagram'}
            </button>
          ))}
        </div>
        <div className="inline-flex gap-1.5">
          {(['hits', 'followers', 'recent'] as const).map((s) => (
            <button key={s} onClick={() => setSort(s)} className={`rounded-full border px-3.5 py-1.5 text-[12px] capitalize transition-colors ${sort === s ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-border-strong)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'}`}>
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums">{rows.length} creators</span>
      </div>

      {/* Projects strip — tracked groups. A creator in a project is scanned at
          the project's cadence (6h/12h vs the default 48h), so this is where
          "tracking" lives, not a decorative label. */}
      {projects.filter((p) => !p.archived).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">Projects</span>
          {projects.filter((p) => !p.archived).map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="rounded-full border border-[var(--color-border-strong)] px-3 py-1 text-[12px] text-[var(--color-ink)] hover:border-[var(--color-ink)] transition-colors"
            >
              {p.name} <span className="tabular-nums text-[var(--color-ink-subtle)]">· {p.creatorIds.length}</span>
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <Card className="px-6 py-16 text-center text-[13px] text-[var(--color-ink-subtle)]">No creators with confirmed hits yet.</Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.slice(0, 60).map((r) => (
            <Link
              key={r.handle}
              to={`/creators/${r.handle}`}
              className="bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-colors p-4 flex flex-col gap-3"
            >
              {/* Identity row */}
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
                  <Avatar src={avatarByHandle.get(r.handle.toLowerCase()) ?? r.avatar} handle={r.handle} className="w-full h-full text-[14px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium truncate flex items-center gap-1.5">
                    <span className="truncate">@{r.handle}</span>
                    {/* Chip only — the add/remove control lives in the
                        detection drawer and on the project page, because a
                        button nested in this Link card would be invalid HTML
                        (the FeedCard was rebuilt for the same reason). */}
                    {(projectsByCreator.get(`${r.platform}_${r.handle.toLowerCase()}`) ?? []).length > 0 && (
                      <span title={(projectsByCreator.get(`${r.platform}_${r.handle.toLowerCase()}`) ?? []).map((p) => p.name).join(', ')}>
                        <Badge tone="accent">tracked</Badge>
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-subtle)]">
                    {r.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
                    {r.followers ? ` · ${compactNum(r.followers)} followers` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[18px] font-medium tabular-nums leading-none">{r.hits}</div>
                  <div className="text-[10px] text-[var(--color-ink-subtle)] uppercase tracking-wider mt-0.5">hits</div>
                </div>
              </div>

              {/* Recent content strip */}
              <div className="grid grid-cols-4 gap-1">
                {r.recent.map((d) => (
                  <MediaTile key={d.detection_id} src={imageUrlFor(d)} size="thumb" className="border border-[var(--color-border)]">
                    {d.frame_idx != null && (
                      <span className="absolute bottom-0.5 right-0.5 text-[8px] bg-[var(--color-ink)]/80 text-white px-1">▶</span>
                    )}
                  </MediaTile>
                ))}
                {Array.from({ length: Math.max(0, 4 - r.recent.length) }).map((_, i) => (
                  <div key={`e${i}`} className="w-full pb-[100%] bg-[var(--color-bg)] border border-[var(--color-border)]" />
                ))}
              </div>

              {/* Meta row */}
              <div className="flex items-center justify-between text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
                <span className="flex items-center gap-2.5">
                  {r.totalLikes > 0 && <span>♥ {compactNum(r.totalLikes)}</span>}
                  {r.totalViews > 0 && <span>▶ {compactNum(r.totalViews)}</span>}
                  {r.topProduct && <span className="truncate max-w-[120px]">{PRODUCT_LINE_LABEL[r.topProduct] ?? r.topProduct}</span>}
                </span>
                <span>{r.lastSeen ? timeAgo(r.lastSeen) : ''}</span>
              </div>

              <div className="h-6"><Sparkline data={r.spark} height={22} tone="accent" /></div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}


// ─────────────────────── DEBUG ───────────────────────



// ─────────────────────── Dashboard ───────────────────────

function DashboardSection({ detections, rangeRows, days, creatorScenes, sceneLabels, creatorProfiles, onGotoTab }: {
  detections: DetectionRow[]
  rangeRows: DetectionRow[]
  days: number
  creatorScenes: CreatorSceneMap
  sceneLabels: Record<string, string>
  creatorProfiles: Record<string, { followerCount: number | null; bio: string | null; avatarUrl: string | null }>
  onGotoTab?: (t: Tab) => void
}) {
  // One clock for the whole section, so the "last 7 days" cutoff and the
  // half-window split below cannot land on different moments within one render.
  // Five minutes: every value here is day- or half-window-granular, and each
  // tick re-runs the filters over every row.
  const now = useNow(5 * 60_000)

  // ── Top-row KPIs ────────────────────────────────────────────────
  const totalHits = rangeRows.filter((d) => d.detected === true).length
  const week = new Date(now); week.setDate(week.getDate() - 7)
  const weekIso = week.toISOString()
  const thisWeekHits = rangeRows.filter((d) => d.detected && (d.posted_at ?? '') >= weekIso).length
  const activeCreators = new Set(rangeRows.filter((d) => d.detected).map((d) => d.creator_handle)).size
  const igHits = rangeRows.filter((d) => d.detected && d.platform === 'instagram').length
  const ttHits = rangeRows.filter((d) => d.detected && d.platform === 'tiktok').length
  const topPlatform = igHits >= ttHits ? 'Instagram' : 'TikTok'
  const videoHits = rangeRows.filter((d) => d.detected && d.frame_idx != null).length

  // The headline number. Brand-owned posts are excluded from the denominator —
  // the brand's own content is not a discovery either way and would dilute it.
  //
  // Wording matters and must stay honest: scanning is hashtag-SEEDED, so this
  // share is structurally suppressed by how discovery currently works. "X% of
  // all Stelz content on Instagram is untagged" would be false. The defensible
  // claim, and the one used in the copy below, is "X% of the hits in YOUR
  // dashboard carry no #stelz and no @stelz".
  const unfindable = untaggedShare(rangeRows.filter((d) => d.detected === true))

  const signalMix = signalCounts(rangeRows.filter((d) => d.detected === true))

  // ── 1. Detections per day, split by platform ────────────────────
  const igSeries: Series = {
    id: 'ig', label: 'Instagram', tone: 'ink',
    data: bucketByDay(rangeRows.filter((d) => d.detected && d.platform === 'instagram').map((d) => d.posted_at), days),
  }
  const ttSeries: Series = {
    id: 'tt', label: 'TikTok', tone: 'accent',
    data: bucketByDay(rangeRows.filter((d) => d.detected && d.platform === 'tiktok').map((d) => d.posted_at), days),
  }

  // ── 2. New creators per day (first-seen) ────────────────────────
  const firstSeen = new Map<string, string>()
  for (const d of detections) {
    if (!d.detected || !d.posted_at) continue
    const cur = firstSeen.get(d.creator_handle)
    if (!cur || d.posted_at < cur) firstSeen.set(d.creator_handle, d.posted_at)
  }
  const newCreatorsSeries: Series = {
    id: 'newc', label: 'New creators', tone: 'good',
    data: bucketByDay([...firstSeen.values()], days),
  }

  // ── 3. Creator leaderboard (hits + growth + identity in one) ─────
  const halfMs = (days * 24 * 60 * 60 * 1000) / 2
  const cutoff = now - halfMs
  const perCreator = new Map<string, {
    recent: number; prior: number; total: number
    avatar: string | null; platform: string; firstImage: string | null
  }>()
  for (const d of rangeRows) {
    if (!d.detected) continue
    const ts = d.posted_at ? new Date(d.posted_at).getTime() : 0
    const e = perCreator.get(d.creator_handle) ?? {
      recent: 0, prior: 0, total: 0,
      avatar: null, platform: d.platform, firstImage: null,
    }
    if (ts >= cutoff) e.recent += 1; else e.prior += 1
    e.total += 1
    if (!e.avatar && d.extras?.author?.avatar) e.avatar = d.extras.author.avatar
    if (!e.firstImage) e.firstImage = imageUrlFor(d) || null
    perCreator.set(d.creator_handle, e)
  }

  // ── 4. Context tags — the tags these posts actually live under ──
  //
  // Brand tags are deliberately EXCLUDED. Titled "Top hashtags" and including
  // #stelz, this chart read as "our best hashtags" and was the single most
  // likely reason the dashboard felt like a hashtag tool. Without them it shows
  // the real thing: this content lives under #vrijmibo, #huisfeest,
  // #festivalseizoen — contexts you could not have searched for.
  const tagYield = new Map<string, number>()
  for (const d of rangeRows) {
    if (!d.detected) continue
    for (const t of (d.post_hashtags ?? [])) {
      const k = t.toLowerCase().replace(/^#/, '')
      if (!k || isBrandTag(k)) continue
      tagYield.set(k, (tagYield.get(k) ?? 0) + 1)
    }
  }
  const topTags = [...tagYield.entries()]
    .map(([label, value]) => ({ label: `#${label}`, value, tone: 'accent' as const }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)

  // ── 5. Product line breakdown — Stelz flavor colours ─────────────
  // Matches the can designs on drinkstelz.com: lemonade orange, seltzer red,
  // iced tea green, classics gold, 0.0 light blue, logo-only navy.
  const PRODUCT_COLOR: Record<string, string> = {
    hard_lemonade: '#f59023',
    hard_seltzer: '#e8402f',
    hard_iced_tea: '#6f9f3c',
    mixed_classics: '#e0a92c',
    zero_zero: '#6b8fd6',
    logo_only: '#222c51',
  }
  const productMix = new Map<string, number>()
  for (const d of rangeRows.filter((x) => x.detected)) {
    const p = d.product_line || 'unspecified'
    productMix.set(p, (productMix.get(p) ?? 0) + 1)
  }
  // Primary vs background mix — see the "Camera angle" card for why.
  const angleMix = (() => {
    let primary = 0, background = 0
    for (const d of rangeRows) {
      if (d.detected !== true) continue
      if (isPrimaryAngle(d)) primary += 1
      else background += 1
    }
    return { primary, background }
  })()

  const productSlices = [...productMix.entries()].map(([label, value], i) => ({
    label: PRODUCT_LINE_LABEL[label] ?? label,
    value,
    color: PRODUCT_COLOR[label] ?? ['#222c51', '#e8402f', '#f59023', '#6f9f3c'][i % 4],
  }))

  // ── 6. Platform comparison ──────────────────────────────────────
  const platformSlices = [
    { label: 'Instagram', value: igHits, color: '#222c51' },
    { label: 'TikTok', value: ttHits, color: '#e8402f' },
  ]

  // ── 8. Top creators leaderboard (most hits + growth) ────────────
  const leaderboard = [...perCreator.entries()]
    .map(([handle, e]) => ({
      handle,
      hits: e.total,
      recent: e.recent,
      avatar: e.avatar,
      firstImage: e.firstImage,
      platform: e.platform,
      // Growth compares the two halves of the window, and is only meaningful
      // when BOTH halves have something in them.
      //
      // The old formula returned -100% whenever a creator had no hits in the
      // recent half — which, with scans running on demand rather than daily, is
      // almost everyone almost always. A leaderboard where every row is a red
      // -100% describes our scan schedule, not the creators, and reads as a
      // brand in freefall. `null` means "no comparison to draw" and renders as
      // nothing at all.
      growth: e.recent === 0
        ? null                                   // quiet in the recent half — say nothing
        : e.prior === 0
          ? 'new' as const                       // first hits ever: a change, not a percentage
          : ((e.recent - e.prior) / e.prior) * 100,
    }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8)
  const maxLeaderHits = leaderboard[0]?.hits ?? 1

  // ── 9. Posting day-of-week heatmap (when do hits happen) ────────
  const dayOfWeek = [0, 0, 0, 0, 0, 0, 0]
  for (const d of rangeRows.filter((x) => x.detected && x.posted_at)) {
    const dow = new Date(d.posted_at!).getDay()
    dayOfWeek[(dow + 6) % 7] += 1  // Mon-first
  }
  const dowRows = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'].map((l, i) => ({
    label: l, value: dayOfWeek[i],
    tone: (i >= 5 ? 'accent' : 'ink') as Series['tone'],
  }))

  // ── Top sounds ───────────────────────────────────────────────────
  // One shared aggregator (lib/sounds.ts) for this card, the community
  // profiles and the /sounds pages — three sites used to disagree on the key
  // (title vs musicId), so their counts could never match. The "(untitled)"
  // guard history lives in soundKey()'s docstring now.
  const topSounds = tallySounds(rangeRows).slice(0, 8)

  // ── Top effects (TikTok stickers/effects) ────────────────────────
  const effectCounts = new Map<string, number>()
  for (const d of rangeRows.filter((x) => x.detected)) {
    for (const e of (d.extras?.effects ?? [])) {
      if (!e) continue
      effectCounts.set(e, (effectCounts.get(e) ?? 0) + 1)
    }
  }
  const topEffects = [...effectCounts.entries()]
    .map(([label, value]) => ({ label, value, tone: 'good' as const }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)

  // ── Top mentions (who's tagging the brand) ───────────────────────
  const mentionCounts = new Map<string, number>()
  for (const d of rangeRows.filter((x) => x.detected)) {
    for (const m of (d.post_mentions ?? [])) {
      if (!m) continue
      mentionCounts.set(m, (mentionCounts.get(m) ?? 0) + 1)
    }
  }
  const topMentions = [...mentionCounts.entries()]
    .map(([label, value]) => ({ label: label.startsWith('@') ? label : `@${label}`, value, tone: 'ink' as const }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)

  // ── Scenes — where the brand lives, and where it lives untagged ──
  //
  // Prefer the real subcultures (creators filed into named scenes by
  // handlers/seed_subcultures.py). Fall back to grouping each PHOTO by what the
  // detector saw in it when that data hasn't been seeded — see lib/scenes.ts.
  // The two are counted differently, so the copy below has to switch with them.
  const hitRows = rangeRows.filter((d) => d.detected === true)
  const bySubculture = Object.values(creatorScenes).some((v) => v.length > 0)
  const scenes = bySubculture
    ? subcultureBreakdown(hitRows, creatorScenes, sceneLabels)
    : sceneBreakdown(hitRows)
  const scenesPlaced = scenes.filter((s) => s.key !== 'other')
  const scenesUntaggedTotal = scenes.reduce((n, s) => n + s.untagged, 0)
  const unplacedScene = scenes.find((s) => s.key === 'other') ?? null

  // Full portraits per scene — see lib/communities.ts. Same grouping as the
  // block above, but carrying everything we can honestly say about the people
  // in it rather than just a count.
  const communities = communityProfiles(hitRows, creatorScenes, sceneLabels, { creators: creatorProfiles })

  // ── Sentiment — how the captions talk about the brand ───────────
  // Only over SCORED rows. Unscored hits are excluded from the denominator
  // rather than counted as neutral: on rollout most of the back catalogue is
  // unscored, and folding it into neutral would report a flat, false calm.
  const sentimentRows = rangeRows.filter((d) => d.detected === true && d.sentiment)
  const sentimentMix = new Map<string, number>()
  for (const d of sentimentRows) sentimentMix.set(d.sentiment!, (sentimentMix.get(d.sentiment!) ?? 0) + 1)
  const SENTIMENT_COLOR: Record<string, string> = {
    positive: '#6f9f3c',
    neutral: 'var(--color-border-strong)',
    negative: '#e8402f',
    promotional: '#e0a92c',
  }
  const sentimentSlices = ['positive', 'neutral', 'promotional', 'negative']
    .map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: sentimentMix.get(k) ?? 0, color: SENTIMENT_COLOR[k] }))
    .filter((s) => s.value > 0)
  const sentimentScored = sentimentRows.length
  const sentimentUnscored = rangeRows.filter((d) => d.detected === true && !d.sentiment).length
  const positivePct = sentimentScored
    ? Math.round(((sentimentMix.get('positive') ?? 0) / sentimentScored) * 100)
    : 0

  return (
    <section className="space-y-14">
      {/* ─── The headline: what only this tool found ─────────────────── */}
      {unfindable.total > 0 && (
        <div className="border border-[var(--color-ink)] bg-[var(--color-surface)] px-6 py-7 sm:px-8">
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="text-[56px] sm:text-[64px] leading-none font-semibold tabular-nums text-[var(--color-accent)]">
              {unfindable.pct}%
            </div>
            <div className="flex-1">
              <p className="text-[15px] text-[var(--color-ink)] leading-snug font-medium">
                of your hits carry no #stelz, no @drinkstelz and no brand account.
              </p>
              <p className="mt-1.5 text-[13px] text-[var(--color-ink-muted)] leading-relaxed">
                <strong className="tabular-nums text-[var(--color-ink)]">
                  {unfindable.untagged.toLocaleString()}
                </strong>{' '}
                of {unfindable.total.toLocaleString()} posts that Instagram could never have
                shown you. Anyone can follow a hashtag for free — this is the part that needs
                a tool.
              </p>
            </div>
            {onGotoTab && (
              <Button size="sm" variant="primary" onClick={() => onGotoTab('feed')}>
                See them →
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ─── Overview ────────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Overview"
        title="Every detection so far"
        hint="Every confirmed hit we've written, regardless of when the post was originally published."
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border border-[var(--color-border)] bg-[var(--color-border)] gap-px">
          <KpiTile label="Total hits" value={totalHits.toLocaleString()} sub="all time" />
          {/* Replaced "Avg confidence": an internal pipeline metric that means
              nothing to a brand manager and invites "why only 87%?". */}
          <KpiTile label="Only found here" value={unfindable.untagged.toLocaleString()} sub={`${unfindable.pct}% of hits`} />
          <KpiTile label="This week" value={thisWeekHits.toLocaleString()} sub="last 7 days" />
          <KpiTile label="Active creators" value={activeCreators.toString()} sub="with ≥1 hit" />
          <KpiTile label="Video hits" value={videoHits.toLocaleString()} sub="frame analysis" />
          <KpiTile label="Top platform" value={topPlatform} sub={`${Math.max(igHits, ttHits)} hits`} />
        </div>
      </DashSection>

      {/* ─── Activity ────────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Activity"
        title="Momentum over time"
        hint={`Detection volume and new creator discovery bucketed daily for the last ${days} days.`}
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <DashCard title="Detections" sub="Daily hits · Instagram vs TikTok" span={2}>
            <LineChart series={[igSeries, ttSeries]} height={220} />
          </DashCard>
          <DashCard title="New creators" sub="First-time detection per handle">
            <StackedDayBars series={[newCreatorsSeries]} height={220} days={days} />
          </DashCard>
        </div>
      </DashSection>

      {/* ─── Who ─────────────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Creators"
        title="Who's driving the mentions"
        hint="Top fans ranked by confirmed hits, plus the hashtags delivering them."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <DashCard title="Top fans" sub="Ranked by confirmed hits · growth vs prior period" span={2}>
            {leaderboard.length === 0 ? (
              <EmptyBlock label="Waiting for the first hit." />
            ) : (
              <ol className="divide-y divide-[var(--color-border)]">
                {leaderboard.map((g, i) => (
                  <li key={g.handle}>
                    <Link
                      to={`/creators/${g.handle}`}
                      className="flex items-center gap-4 py-3 group"
                    >
                      <span className="stelz-display text-[20px] w-8 text-right text-[var(--color-ink-subtle)] tabular-nums shrink-0">
                        {i + 1}
                      </span>
                      <span className="w-10 h-10 rounded-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
                        <Avatar
                          src={creatorProfiles[g.handle.toLowerCase()]?.avatarUrl ?? g.avatar}
                          handle={g.handle}
                          className="w-full h-full text-[13px]"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium truncate group-hover:underline">@{g.handle}</span>
                        <span className="block text-[11px] text-[var(--color-ink-subtle)]">
                          {g.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
                          {creatorProfiles[g.handle.toLowerCase()]?.followerCount
                            ? ` · ${compactNum(creatorProfiles[g.handle.toLowerCase()]!.followerCount!)} followers`
                            : ''}
                        </span>
                      </span>
                      {g.growth === 'new' ? (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white shrink-0 bg-[var(--color-accent)]">
                          new
                        </span>
                      ) : typeof g.growth === 'number' && g.growth !== 0 ? (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white shrink-0"
                          style={{ background: g.growth > 0 ? '#6f9f3c' : '#e8402f' }}
                        >
                          {g.growth > 0 ? '+' : ''}{g.growth.toFixed(0)}%
                        </span>
                      ) : null}
                      <span className="w-28 shrink-0 hidden sm:block">
                        <span className="block h-1.5 bg-[var(--color-border)] relative overflow-hidden">
                          <span
                            className="absolute inset-y-0 left-0 bg-[var(--color-ink)]"
                            style={{ width: `${Math.round((g.hits / maxLeaderHits) * 100)}%` }}
                          />
                        </span>
                      </span>
                      <span className="text-right shrink-0 w-12">
                        <span className="block text-[16px] font-medium tabular-nums leading-none">{g.hits}</span>
                        <span className="block text-[9px] uppercase tracking-wider text-[var(--color-ink-subtle)] mt-0.5">hits</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </DashCard>

          <DashCard title="Context tags" sub="Tags on the posts we found — brand tags excluded">
            {topTags.length === 0 ? <EmptyBlock label="No context tags yet." /> : <BarChart rows={topTags} />}
          </DashCard>
        </div>
      </DashSection>

      {/* ─── Scenes ──────────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Audience"
        title="Which scenes the brand lives in"
        hint={bySubculture
          ? 'Creators are filed into scenes by their own hashtag history, then their hits are counted here. Somebody can belong to more than one scene, so these rows add up to more than the total number of hits — each row answers "how much of our content comes out of this scene", not "how do the hits split".'
          : 'Grouped from what the detector saw in each photo — the activity and the setting, not the hashtags. The number that counts is how many of each scene carry no brand tag at all.'}
      >
        {scenesPlaced.length === 0 ? (
          <EmptyBlock label="No scenes to group yet." />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <DashCard
              title="Untagged hits per scene"
              sub={`${scenesUntaggedTotal.toLocaleString()} posts with no #stelz and no @drinkstelz`}
              span={2}
            >
              <ul className="divide-y divide-[var(--color-border)]">
                {scenesPlaced.map((s) => (
                  <li key={s.key} className="flex items-center gap-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{s.label}</span>
                      <span className="block text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
                        {s.untaggedPct}% of {s.total.toLocaleString()} hits here are untagged
                        {s.outdoorPct != null ? ` · ${s.outdoorPct}% outdoors` : ''}
                        {'creators' in s && (s as { creators: number }).creators > 0
                          ? ` · ${(s as { creators: number }).creators} creator${(s as { creators: number }).creators === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </span>
                    <span className="w-28 shrink-0 hidden sm:block">
                      <span className="block h-1.5 bg-[var(--color-border)] relative overflow-hidden">
                        <span
                          className="absolute inset-y-0 left-0 bg-[var(--color-accent)]"
                          style={{
                            width: `${Math.round((s.untagged / Math.max(1, scenesPlaced[0].untagged)) * 100)}%`,
                          }}
                        />
                      </span>
                    </span>
                    <span className="text-right shrink-0 w-14">
                      <span className="block text-[16px] font-medium tabular-nums leading-none">
                        {s.untagged.toLocaleString()}
                      </span>
                      <span className="block text-[9px] uppercase tracking-wider text-[var(--color-ink-subtle)] mt-0.5">
                        untagged
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {unplacedScene && unplacedScene.total > 0 && (
                /* Stated, not hidden. A big Unplaced share means the scene
                   grouping is thin, and the reader should know that before
                   reading anything into the bars above. */
                <p className="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
                  {unplacedScene.total.toLocaleString()} further hits couldn't be placed in a
                  scene — {bySubculture
                    ? 'their creator matched none of the scene definitions, usually because we have too few of their posts to judge.'
                    : 'the detector returned no activity or setting for them.'}
                </p>
              )}
            </DashCard>

            <DashCard title="Scene mix" sub={bySubculture ? 'Hits per scene — creators can appear in several' : 'Share of all hits by scene'}>
              <Donut
                slices={scenesPlaced.slice(0, 6).map((s, i) => ({
                  label: s.label,
                  value: s.total,
                  color: ['#e8402f', '#f59023', '#6f9f3c', '#222c51', '#e0a92c', '#6b8fd6'][i % 6],
                }))}
                centreLabel={scenesPlaced.length.toString()}
                centreSub="scenes"
              />
            </DashCard>
          </div>
        )}
      </DashSection>

      {/* ─── Communities ─────────────────────────────────────────────── */}
      {communities.length > 0 && (
        <DashSection
          eyebrow="Audience"
          title="Who these people are"
          hint="A portrait of each scene, built only from what the posts themselves carry. Where a signal is missing — and Instagram gives us far less of it than TikTok — the line is left out rather than filled in."
        >
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadCsv(datedFilename('stelz-communities'), communitiesCsv(communities))}
            >
              Export communities CSV
            </Button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {communities.map((c) => <CommunityCard key={c.key} p={c} />)}
          </div>
          <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
            Age and gender are deliberately absent: nothing in the pipeline collects either,
            and inferring them from photos or handles would put invented attributes on real
            people. Where someone states their age in their own bio it is shown as
            self-reported, with the sample size next to it.
          </p>
        </DashSection>
      )}

      {/* ─── Sentiment ───────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Audience"
        title="How people talk about it"
        hint="Read from each post's caption after detection — never from the photo. Posts the sentiment pass hasn't reached yet are left out of these numbers rather than counted as neutral."
      >
        {sentimentScored === 0 ? (
          <EmptyBlock
            label={
              sentimentUnscored > 0
                ? `No captions scored yet — ${sentimentUnscored.toLocaleString()} hits are queued for the next pass.`
                : 'No captions scored yet.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <DashCard title="Sentiment mix" sub={`Across ${sentimentScored.toLocaleString()} scored posts`}>
              <Donut slices={sentimentSlices} centreLabel={`${positivePct}%`} centreSub="positive" />
            </DashCard>

            <DashCard title="What the labels mean" sub="Four buckets, one per post" span={2}>
              <dl className="grid grid-cols-[110px_1fr] gap-y-3 gap-x-4 text-[12px] leading-relaxed">
                <dt className="font-medium">Positive</dt>
                <dd className="text-[var(--color-ink-muted)]">The caption is warm about the drink itself — not just about the night out.</dd>
                <dt className="font-medium">Neutral</dt>
                <dd className="text-[var(--color-ink-muted)]">The can is simply there. Most organic posts land here, and that is not a bad sign.</dd>
                <dt className="font-medium">Promotional</dt>
                <dd className="text-[var(--color-ink-muted)]">A bar, retailer or paid partnership. Commercial reach, not word of mouth.</dd>
                <dt className="font-medium">Negative</dt>
                <dd className="text-[var(--color-ink-muted)]">A complaint or criticism. Worth reading individually — the count is usually small enough to.</dd>
              </dl>
              {sentimentUnscored > 0 && (
                <p className="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
                  {sentimentUnscored.toLocaleString()} further hits are not scored yet. Scoring runs
                  in batches after each scan, so this number falls over successive runs.
                </p>
              )}
            </DashCard>
          </div>
        )}
      </DashSection>

      {/* ─── What ────────────────────────────────────────────────────── */}
      <DashSection
        eyebrow="Content"
        title="What's being shown"
        hint="Where the brand appears — product mix, platform split, and the audio and effects driving each post."
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <DashCard title="How we found it" sub="Tagged content Instagram shows you for free, vs the rest">
            {unfindable.total === 0 ? (
              <EmptyBlock label="No hits to classify yet." />
            ) : (
              <Donut
                slices={[
                  { label: 'No tag — only found here', value: signalMix.visual_only, tone: 'accent' as const },
                  { label: 'Brand hashtag', value: signalMix.hashtag, color: 'var(--color-ink)' },
                  { label: '@mention', value: signalMix.mention, color: 'var(--color-ink-muted)' },
                  { label: 'Brand account', value: signalMix.brand_owned, color: 'var(--color-border-strong)' },
                ].filter((s) => s.value > 0)}
                centreLabel={`${unfindable.pct}%`}
                centreSub="only found here"
              />
            )}
          </DashCard>

          <DashCard title="Product line" sub="Which variant gets detected">
            {productSlices.length === 0 ? (
              <EmptyBlock label="No product breakdown yet." />
            ) : (
              <Donut slices={productSlices} centreLabel={totalHits.toLocaleString()} centreSub="hits" />
            )}
          </DashCard>

          <DashCard title="Platform" sub="Instagram vs TikTok share">
            {(igHits + ttHits) === 0 ? (
              <EmptyBlock label="No platform data yet." />
            ) : (
              <Donut slices={platformSlices} centreLabel={`${totalHits}`} centreSub="hits" />
            )}
          </DashCard>

          {/* "Alle hoeken behouden" made measurable: a background find is a can
              nobody staged — often the strongest evidence in the set. Nothing
              is dropped for being small/non-primary anywhere in the pipeline;
              the gate only caps confidence (lib/quality.ts isPrimaryAngle). */}
          <DashCard title="Camera angle" sub="Can as the subject vs incidental in the background — both are kept, always">
            {totalHits === 0 ? (
              <EmptyBlock label="No hits yet." />
            ) : (
              <Donut
                slices={[
                  { label: 'Can is the subject', value: angleMix.primary, color: 'var(--color-ink)' },
                  { label: 'Background find', value: angleMix.background, color: 'var(--color-accent)' },
                ]}
                centreLabel={`${Math.round((angleMix.background / Math.max(1, angleMix.primary + angleMix.background)) * 100)}%`}
                centreSub="background"
              />
            )}
          </DashCard>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <DashCard title="Top sounds" sub="Most-used audio on hit videos — trend within your own hits, not platform-wide">
            {topSounds.length === 0 ? (
              <EmptyBlock label="No music data yet." />
            ) : (
              <>
                <ul className="divide-y divide-[var(--color-border)]">
                  {topSounds.map((s) => (
                    <li key={s.key} className="flex items-center gap-3 py-2.5">
                      <span className="w-8 h-8 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center text-[13px] text-[var(--color-ink)] shrink-0">
                        ♫
                      </span>
                      <div className="min-w-0 flex-1">
                        {/* Into our own drill-down, not off to TikTok — the
                            external link lives on the drill-down page. */}
                        <Link to={soundHref(s.key)} className="hover:underline truncate block text-[13px] font-medium">{s.label}</Link>
                        <div className="text-[11px] text-[var(--color-ink-subtle)] truncate mt-0.5">
                          {s.artist || '—'}{s.original ? ' · original sound' : ''}
                          {s.creators > 1 ? ` · ${s.creators} creators` : ''}
                        </div>
                      </div>
                      <span className="rounded-full border border-[var(--color-ink)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--color-ink)] shrink-0">
                        ×{s.hits}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link to="/sounds" className="block mt-3 text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline">
                  All sounds →
                </Link>
              </>
            )}
          </DashCard>

          <DashCard title="Top effects" sub="TikTok stickers and filters">
            {topEffects.length === 0 ? <EmptyBlock label="No effect data yet." /> : <BarChart rows={topEffects} />}
          </DashCard>

          <DashCard title="Top mentions" sub="@handles tagged in captions">
            {topMentions.length === 0 ? <EmptyBlock label="No mentions yet." /> : <BarChart rows={topMentions} />}
          </DashCard>
        </div>

        <DashCard title="Day-of-week activity" sub="When creators publish detected content">
          <BarChart rows={dowRows} valueFmt={(n) => `${n}`} />
        </DashCard>
      </DashSection>
    </section>
  )
}

/**
 * One scene, as a portrait rather than a bar.
 *
 * Every block below is conditional. A community where we know nothing but the
 * hit count renders as a hit count — which is honest, and visibly thinner than
 * one where we know the music, the cities and the days. That contrast is
 * useful information in itself: it shows where the data is thin.
 */
function CommunityCard({ p }: { p: CommunityProfile }) {
  const summary = oneLineSummary(p)
  const ages = p.selfReportedAges
  const ageRange = ages.length >= 3
    ? { lo: Math.min(...ages), hi: Math.max(...ages), n: ages.length }
    : null
  const sentimentTotal = p.sentiment.scored

  return (
    <Card className="p-6 flex flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-medium">{p.label}</h3>
          <span className="text-[11px] tabular-nums text-[var(--color-ink-subtle)] shrink-0">
            {p.creators} {p.creators === 1 ? 'creator' : 'creators'}
          </span>
        </div>
        {summary && (
          <p className="mt-1 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">{summary}</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-px bg-[var(--color-border)] border border-[var(--color-border)]">
        <MiniStat label="Posts" value={p.hits.toLocaleString()} />
        <MiniStat label="Untagged" value={`${p.untaggedPct}%`} sub={`${p.untagged.toLocaleString()} posts`} />
        <MiniStat
          label="Median followers"
          value={p.medianFollowers ? compactNum(p.medianFollowers) : '—'}
          sub={p.medianFollowers ? `known for ${p.followersKnownFor} of ${p.creators}` : 'not reported'}
        />
      </div>

      {p.topHashtags.length > 0 && (
        <Facet title="What else they post about">
          <div className="flex flex-wrap gap-1">
            {p.topHashtags.map((h) => (
              <span key={h.label} className="text-[10px] px-1.5 py-0.5 border border-[var(--color-border)] text-[var(--color-ink-muted)] bg-[var(--color-bg)]">
                #{h.label}
              </span>
            ))}
          </div>
        </Facet>
      )}

      {p.topActivities.length > 0 && (
        <Facet title="What they're doing">
          <span className="text-[12px] text-[var(--color-ink-muted)]">
            {p.topActivities.map((a) => a.label).join(' · ')}
          </span>
        </Facet>
      )}

      {p.topSounds.length > 0 && (
        <Facet title="Sounds they use">
          <span className="text-[12px] text-[var(--color-ink-muted)]">
            {p.topSounds.map((sd) => `${sd.label} (${sd.count})`).join(' · ')}
          </span>
        </Facet>
      )}

      {p.topCities.length > 0 && (
        <Facet title="Where">
          <span className="text-[12px] text-[var(--color-ink-muted)]">
            {p.topCities.map((c) => c.label).join(' · ')}
          </span>
        </Facet>
      )}

      {(p.peakDay || p.medianLikes) && (
        <Facet title="Rhythm">
          <span className="text-[12px] text-[var(--color-ink-muted)]">
            {p.peakDay ? `Busiest on ${DAY_NAMES[p.peakDay.day]}s (${p.peakDay.pct}%)` : ''}
            {p.peakDay && p.medianLikes ? ' · ' : ''}
            {p.medianLikes ? `${compactNum(p.medianLikes)} likes on a typical post` : ''}
          </span>
        </Facet>
      )}

      {sentimentTotal > 0 && (
        <Facet title={`How they talk about it (${sentimentTotal} scored)`}>
          <div className="flex h-1.5 overflow-hidden">
            {([
              ['positive', '#6f9f3c'],
              ['neutral', 'var(--color-border-strong)'],
              ['promotional', '#e0a92c'],
              ['negative', '#e8402f'],
            ] as const).map(([k, color]) => {
              const v = p.sentiment[k]
              if (!v) return null
              return <span key={k} style={{ width: `${(v / sentimentTotal) * 100}%`, background: color }} />
            })}
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)]">
            {p.sentiment.positive} positive · {p.sentiment.neutral} neutral
            {p.sentiment.promotional ? ` · ${p.sentiment.promotional} promo` : ''}
            {p.sentiment.negative ? ` · ${p.sentiment.negative} negative` : ''}
          </div>
        </Facet>
      )}

      {ageRange && (
        <Facet title="Age">
          <span className="text-[12px] text-[var(--color-ink-muted)]">
            {ageRange.lo}–{ageRange.hi}
            <span className="text-[var(--color-ink-subtle)]">
              {' '}· self-reported in {ageRange.n} {ageRange.n === 1 ? 'bio' : 'bios'}
            </span>
          </span>
        </Facet>
      )}

      {p.sampleCreators.length > 0 && (
        <Facet title="Faces">
          <div className="flex items-center gap-2 flex-wrap">
            {p.sampleCreators.map((c) => (
              <Link
                key={c.handle}
                to={`/creators/${c.handle}`}
                className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                <span className="w-6 h-6 rounded-full overflow-hidden border border-[var(--color-border)] shrink-0">
                  <Avatar src={c.avatar} handle={c.handle} className="w-full h-full text-[9px]" />
                </span>
                <span className="hover:underline">@{c.handle}</span>
              </Link>
            ))}
          </div>
        </Facet>
      )}
    </Card>
  )
}

function Facet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)] mb-1.5">{title}</div>
      {children}
    </div>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--color-surface)] px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-ink-subtle)]">{label}</div>
      <div className="text-[16px] font-medium tabular-nums leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-ink-subtle)] mt-0.5">{sub}</div>}
    </div>
  )
}

function DashSection({
  eyebrow, title, hint, children,
}: { eyebrow: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-6">
      <header className="flex items-end justify-between gap-6 border-b-2 border-[var(--color-ink)] pb-4">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)] font-medium mb-2">
            {eyebrow}
          </div>
          <h2 className="stelz-display text-[22px] lg:text-[26px] leading-none text-[var(--color-ink)]">{title}</h2>
        </div>
        {hint && (
          <p className="hidden md:block text-[12px] text-[var(--color-ink-muted)] leading-relaxed max-w-[360px] text-right">
            {hint}
          </p>
        )}
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  )
}

function DashCard({
  title, sub, span, children,
}: { title: string; sub?: string; span?: 2 | 3; children: React.ReactNode }) {
  const spanCls = span === 2 ? 'lg:col-span-2' : span === 3 ? 'lg:col-span-3' : ''
  return (
    <Card className={`p-5 lg:p-6 ${spanCls}`}>
      <header className="mb-5">
        <h3 className="text-[14px] font-medium tracking-tight text-[var(--color-ink)]">{title}</h3>
        {sub && <p className="text-[11px] text-[var(--color-ink-muted)] mt-1">{sub}</p>}
      </header>
      {children}
    </Card>
  )
}

function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="py-10 text-center text-[12px] text-[var(--color-ink-subtle)]">{label}</div>
  )
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-5 lg:p-6 flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">{label}</div>
      <div className="stelz-display text-[30px] tabular-nums leading-none text-[var(--color-ink)]">{value}</div>
      <div className="text-[11px] text-[var(--color-ink-muted)] mt-auto">{sub}</div>
    </div>
  )
}

function PickCard({ d, onOpen }: { d: DetectionRow; onOpen: () => void }) {
  return (
    <div className="bg-[var(--color-surface)] flex flex-col">
      {/* Same tile size as the feed: one detection used to render 4:3 here and
          4:5 there, so the identical post looked cropped differently depending
          on which surface you found it on. */}
      <button onClick={onOpen} className="block text-left w-full">
        <MediaTile src={imageUrlFor(d)} size="card" />
      </button>
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/creators/${d.creator_handle}`} className="text-[13px] font-medium hover:underline truncate min-w-0">@{d.creator_handle}</Link>
          <SignalBadge d={d} />
          <VerifiedBadge d={d} />
          <SentimentBadge d={d} />
          {d.creator_tier === 'tier_1' && <Badge tone="accent">T1</Badge>}
          {d.product_line && <Badge tone="muted">{PRODUCT_LINE_LABEL[d.product_line] ?? d.product_line}</Badge>}
        </div>
        {d.post_caption && <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed line-clamp-2">"{d.post_caption}"</p>}
        <div className="flex items-center justify-between text-[11px] text-[var(--color-ink-subtle)] tabular-nums mt-auto">
          <span>
            {((d.confidence ?? 0) * 100).toFixed(0)}%
            {formatFollowers(d.follower_count) ? ` · ${formatFollowers(d.follower_count)} followers` : ''}
          </span>
          <span>{d.posted_at ? timeAgo(d.posted_at) : '—'}</span>
        </div>
      </div>
    </div>
  )
}

function RunScanButton({ onComplete, liveHits, onStepErrors }: {
  onComplete: () => void
  liveHits?: number
  onStepErrors?: (e: Partial<Record<ScanStepKey, string>>) => void
}) {
  const [state, setState] = useState<ScanState | null>(null)
  const [clicking, setClicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Client-side step failures. The chain used to .catch(() => {}) every link,
  // so a failed enrichment step left no trace anywhere — not in the UI, not on
  // brand.scan, nowhere.
  // Accumulated in a ref, not state: this component does not render them —
  // the panel does, one level up.
  const stepErrorsRef = useRef<Partial<Record<ScanStepKey, string>>>({})
  const onStepError = useCallback((step: ScanStepKey, e: unknown) => {
    stepErrorsRef.current = { ...stepErrorsRef.current, [step]: (e as Error)?.message ?? String(e) }
    onStepErrors?.(stepErrorsRef.current)
  }, [onStepErrors])
  const prevRunning = useRef(false)
  // An unclaimed brand shows the button to anyone: pressing it calls bootstrap,
  // which makes the caller its owner. That is the only route into membership
  // for a brand nobody owns yet, and it runs through this button.
  const { canWrite, brandUnclaimed } = useMembership()

  // Subscribe once to brand.scan — persists across refresh, updates live.
  useEffect(() => {
    const unsub = fbSubscribeScanState((s) => setState(s))
    return () => unsub()
  }, [])

  // Derived: are we currently scanning?
  // If no worker has written for 5 minutes, treat the session as dead —
  // a Pub/Sub worker crashed hard (OOM/SIGKILL) before its `finally` ran.
  // The pill flips to "stalled" so the user isn't stuck watching "18/19"
  // forever.
  const queued = state?.hashtagQueued ?? 0
  const done = state?.hashtagDone ?? 0
  // TICKING, not read once. The stale test asks whether five minutes have
  // passed with no write — a condition that becomes true precisely while
  // nothing on the page is changing. Read during render it only fired if the
  // user happened to click something, so the panel could sit on "18/19"
  // indefinitely, which is the exact failure this check exists to catch.
  //
  // The judgement itself lives in lib/scanProgress.scanIsStale, shared with
  // the panel. This button used to roll its own with `lastActivityAt ?? 0`,
  // which called a scan stalled in the second between startedAt landing and
  // the first heartbeat — a freshly clicked scan flashed "Stalled at 0/0".
  const now = useNow(15_000)
  const isStale = scanIsStale(state, now)
  const running = !!state?.startedAt && !state.finishedAt && !isStale
  const progressPct = queued > 0 ? Math.round((done / queued) * 100) : 0

  // On transition running → done/stale, trigger parent refresh (once).
  useEffect(() => {
    if (prevRunning.current && !running && (state?.finishedAt || isStale)) {
      onComplete()
    }
    prevRunning.current = running
  }, [running, state?.finishedAt, isStale, onComplete])

  async function go() {
    setClicking(true); setError(null)
    try {
      await fbBootstrapBrand()
      await fbStepHashtags(500, 50)
      // creators + SRS still run in the background — fire-and-forget without
      // blocking the pill. Failures surface as `error` on brand.scan later.
      // Subcultures must land before SRS — the subculture layer reads the
      // creator classification this writes. Chained rather than fired in
      // parallel for that reason; both are free, local compute.
      // Order is load-bearing: profiles must land before SRS (it reads the
      // creator record's follower count) and subcultures before SRS too (it
      // reads the scene links). Chained, not parallel, for that reason.
      // Stories run in parallel: nothing downstream reads them, and they are
      // the one surface that expires, so they must not queue behind SRS.
      void fbStepStories().catch((e) => onStepError('stories', e))
      void fbStepCreators(80, 8)
        .catch((e) => onStepError('creators', e))
        .then(() => fbStepProfiles().catch((e) => onStepError('profiles', e)))
        .then(() => fbStepSubcultures().catch((e) => onStepError('subcultures', e)))
        .then(() => fbStepSrs().catch((e) => onStepError('srs', e)))
      // Sentiment scores whatever is unscored, this scan's hits included on the
      // next run. Batched and capped, so a large backlog drains over several
      // scans rather than in one long call — and a failure here must never
      // surface as a failed scan, since the detections themselves are fine.
      void fbStepSentiment().catch((e) => onStepError('sentiment', e))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setClicking(false)
    }
  }

  const startedAgo = state?.startedAt ? timeAgo(state.startedAt) : null
  const finishedAgo = state?.finishedAt ? timeAgo(state.finishedAt) : null
  // Old scan info shouldn't linger forever — hide the pill 6h after finish.
  // Same ticking clock as the stale test above, so the two cannot disagree
  // about what time it is within one render.
  const finishedRecently = !!state?.finishedAt &&
    (now - new Date(state.finishedAt).getTime()) < 6 * 3600_000
  // Display hits = the same deduped post-level count the dashboard shows.
  // scan.detectionsHit counts every frame doc and reads inflated.
  const displayHits = liveHits ?? state?.detectionsHit ?? 0

  const busy = clicking || running
  // A scan spends real money at Apify (lib/usage.py puts a default run in the
  // tens of dollars). The server refuses non-members; the button goes with it,
  // so nobody triggers spend by exploring — except on a brand nobody owns,
  // where this button is the claim mechanism.
  if (!canWrite && !brandUnclaimed) return null
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={go}
      >
        <span className="inline-flex items-center gap-2">
          {busy && <Spinner size={10} />}
          <span>{clicking ? 'Starting…' : running ? 'Scanning' : 'Run scan'}</span>
        </span>
      </Button>

      {(running || isStale || finishedRecently || error) && (
        <div className="hidden sm:flex items-center gap-2.5 h-8 px-3 border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px]">
          {error ? (
            <>
              <StatusDot tone="bad" />
              <span className="text-[var(--color-bad)] truncate max-w-[240px]">{error}</span>
            </>
          ) : isStale ? (
            <>
              <StatusDot tone="bad" />
              <span className="tabular-nums text-[var(--color-ink)]">
                Stalled at <span className="font-medium">{done}/{queued}</span>
              </span>
              <span className="tabular-nums text-[var(--color-ink-muted)]">
                · {(state?.postsWritten ?? 0).toLocaleString()} posts
              </span>
              {/* A scan can stall before its first heartbeat ever lands; then
                  there is no lastActivityAt to date the silence with. */}
              <span className="text-[var(--color-ink-subtle)]">
                · no activity {state?.lastActivityAt ? timeAgo(state.lastActivityAt) : 'since start'}
              </span>
            </>
          ) : running ? (
            <>
              <StatusDot tone="accent" pulse />
              <span className="tabular-nums">
                <span className="text-[var(--color-ink)] font-medium">{done}/{queued}</span>
                <span className="text-[var(--color-ink-subtle)]"> tags</span>
              </span>
              {(state?.postsWritten ?? 0) > 0 && (
                <span className="tabular-nums text-[var(--color-ink-muted)]">
                  · {state!.postsWritten.toLocaleString()} posts
                </span>
              )}
              {(state?.detectTasksEnqueued ?? 0) > 0 && (
                <span className="tabular-nums text-[var(--color-ink-muted)]">
                  · {state!.detectTasksEnqueued.toLocaleString()} queued
                </span>
              )}
              {startedAgo && <span className="text-[var(--color-ink-subtle)]">· {startedAgo}</span>}
              <div className="w-16 h-0.5 bg-[var(--color-border)] relative ml-1 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--color-ink)] transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </>
          ) : state?.finishedAt ? (
            (() => {
              const analyzed = state.detectionsCompleted ?? 0
              const toAnalyze = state.detectTasksEnqueued ?? 0
              const analyzing = toAnalyze > 0 && analyzed < toAnalyze
              return analyzing ? (
                <>
                  <StatusDot tone="accent" pulse />
                  <span className="tabular-nums">
                    <span className="text-[var(--color-ink)] font-medium">Analyzing</span>
                    <span className="text-[var(--color-ink-muted)]"> · {analyzed.toLocaleString()}/{toAnalyze.toLocaleString()}</span>
                  </span>
                  {displayHits > 0 && (
                    <span className="tabular-nums text-[var(--color-ink-muted)]">· {displayHits} hits</span>
                  )}
                  <div className="w-16 h-0.5 bg-[var(--color-border)] relative ml-1 overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-[var(--color-ink)] transition-all duration-500"
                      style={{ width: `${toAnalyze > 0 ? Math.round((analyzed / toAnalyze) * 100) : 0}%` }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <StatusDot tone={state.endReason === 'watchdog_stale' ? 'muted' : 'good'} />
                  <span className="tabular-nums text-[var(--color-ink)]">
                    {done} tags · {(state.postsWritten ?? 0).toLocaleString()} posts
                  </span>
                  {displayHits > 0 && (
                    <span className="tabular-nums text-[var(--color-ink-muted)]">· {displayHits} hits</span>
                  )}
                  {(state.skippedCount ?? 0) > 0 && (
                    <span className="tabular-nums text-[var(--color-ink-muted)]">· {state.skippedCount} skipped</span>
                  )}
                  {finishedAgo && <span className="text-[var(--color-ink-subtle)]">· {finishedAgo} ago</span>}
                </>
              )
            })()
          ) : null}
        </div>
      )}
    </div>
  )
}

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      className="inline-block rounded-full border-2 border-white/25 border-t-white animate-spin align-[-1px]"
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  )
}

function RefreshingTag() {
  return (
    <div className="hidden sm:inline-flex items-center gap-2 h-8 px-3 border border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] text-[var(--color-ink-muted)]">
      <DarkSpinner size={10} />
      <span>refreshing</span>
    </div>
  )
}

function DarkSpinner({ size = 12 }: { size?: number }) {
  return (
    <span
      className="inline-block rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-ink)] animate-spin align-[-1px]"
      style={{ width: size, height: size }}
    />
  )
}

function StatusDot({ tone, pulse }: { tone: 'accent' | 'good' | 'bad' | 'muted'; pulse?: boolean }) {
  const bg =
    tone === 'accent' ? 'bg-[var(--color-accent)]' :
    tone === 'good' ? 'bg-[var(--color-good)]' :
    tone === 'bad' ? 'bg-[var(--color-bad)]' :
    'bg-[var(--color-ink-subtle)]'
  return (
    <span className="relative inline-flex w-2 h-2">
      {pulse && <span className={`absolute inset-0 rounded-full ${bg} opacity-40 animate-ping`} />}
      <span className={`relative inline-block w-2 h-2 rounded-full ${bg}`} />
    </span>
  )
}

function FilterDropdown<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T | null; options: { id: T; label: string; count: number }[]; onChange: (v: T | null) => void
}) {
  const [open, setOpen] = useState(false)
  const active = options.find((o) => o.id === value)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className={`rounded-full px-3.5 py-1.5 text-[12px] border transition-colors ${active ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-ink)] text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white'}`}>
        {label}{active ? ` · ${active.label}` : ''} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 min-w-[180px] bg-[var(--color-surface)] border border-[var(--color-border-strong)]">
            <button onClick={() => { onChange(null); setOpen(false) }} className="w-full px-3 py-2 text-left text-[12px] border-b border-[var(--color-border)] hover:bg-[var(--color-bg)]">All</button>
            {options.map((o) => (
              <button key={String(o.id)} onClick={() => { onChange(o.id); setOpen(false) }} className="w-full px-3 py-2 text-left text-[12px] hover:bg-[var(--color-bg)] flex items-center justify-between">
                <span>{o.label}</span>
                <span className="text-[var(--color-ink-subtle)] tabular-nums">{o.count}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SkeletonHome() {
  return (
    <div className="space-y-4">
      <div className="h-10 bg-[var(--color-surface)] border border-[var(--color-border)] animate-pulse" />
      <div className="h-[260px] bg-[var(--color-surface)] border border-[var(--color-border)] animate-pulse" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="h-[180px] bg-[var(--color-surface)] border border-[var(--color-border)] animate-pulse" />
        <div className="h-[180px] bg-[var(--color-surface)] border border-[var(--color-border)] animate-pulse" />
        <div className="h-[180px] bg-[var(--color-surface)] border border-[var(--color-border)] animate-pulse" />
      </div>
    </div>
  )
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
