// Project detail — one tracked group of creators (/projects/:projectId).
//
// The page answers three questions a campaign manager actually has:
// what did this group produce, who in it is delivering, and who is silent.
// Zero-hit members stay visible on purpose: a tracked creator producing
// nothing is information, not a rendering gap.
//
// Writes (remove member, archive) go through api_projects — server-gated,
// because project membership changes scan cadence, which is spend. The UI
// hides those controls for read-only users rather than teasing a 403.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PageShell, Card, Badge, Button, Avatar, Tabs, CARD_GRID } from '../components/ui'
import { MediaTile } from '../components/MediaTile'
import { DetectionDrawer } from '../components/DetectionDrawer'
import { StackedDayBars, type Series } from '../components/Chart'
import { bucketByDay } from '../lib/buckets'
import { PasteImport } from '../components/PasteImport'
import { StoriesStrip } from '../components/StoriesStrip'
import { fmtNum } from '../lib/format'
import { dedupeByPost, imageUrlFor, parentPostKey, type DetectionRow } from '../lib/types'
import { fetchDetections, fetchProjects, projectsAction, fetchCreatorProfiles, type Project } from '../lib/data'
import {
  fbStepCreators, fbStepStories, fbSubscribeStoriesState, fbFetchStories, fbFetchStoryPosts,
  type CreatorProfile, type StoriesState, type StoryPost,
} from '../lib/firestore'
import { rollupProject, splitCreatorId } from '../lib/projects'
import { useMembership } from '../lib/membershipContext'
import { useStoryPostsPreview, useStoryPreview } from '../lib/devPreview'
import { StoriesView } from './Stories'
import { joinStories, storySource } from '../lib/storyStats'

/** One row of cards at the widest grid step; the rest lives in the feed. */
const SHOWN_POSTS = 10

export default function ProjectPage() {
  const { projectId = '' } = useParams()
  const { canWrite } = useMembership()
  // Shareable tab, same pattern as Home. The Stories tab renders the /stories
  // page's own component scoped to this roster rather than a second copy.
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'stories' ? 'stories' : 'overzicht'
  const [active, setActive] = useState<DetectionRow | null>(null)

  const [project, setProject] = useState<Project | null>(null)
  const [rows, setRows] = useState<DetectionRow[]>([])
  // The undeduped fetch, kept beside the deduped view: the drawer's frame
  // strip needs every sibling document of a post, and feeding it the deduped
  // rows meant the strip could never show more than one frame here while the
  // same drawer on Home showed them all.
  const [rawRows, setRawRows] = useState<DetectionRow[]>([])
  // Stories come from POSTS joined with story DETECTIONS — see lib/storyStats.
  // Null posts = that query is unavailable (index not live yet).
  const [storyPosts, setStoryPosts] = useState<StoryPost[] | null>(null)
  const [storyDetections, setStoryDetections] = useState<DetectionRow[]>([])
  const [profiles, setProfiles] = useState<Record<string, CreatorProfile>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  // THE FETCH LIVES IN THE EFFECT, and callers re-trigger it by bumping
  // `reloadKey`. It used to be a useCallback the effect invoked, which is the
  // shape react-hooks/set-state-in-effect exists to catch: the effect body
  // reached a setState synchronously.
  //
  // The rewrite pays for itself twice. It brings CANCELLATION, which the
  // callback version had none of — open a project, click straight through to
  // another, and the first project's rows still arrived and overwrote the
  // second's, because nothing told the in-flight request it was obsolete. And
  // `loading` is now raised by whoever asks for a reload, from a click or a
  // timer, instead of by the fetch itself.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => { setLoading(true); setError(null); setReloadKey((k) => k + 1) }

  useEffect(() => {
    let cancelled = false
    void (async () => {
    try {
      // Profiles ride along for display names + fresh follower counts —
      // imported roster members have a fullName long before their first hit.
      const [all, profs] = await Promise.all([
        fetchProjects(),
        fetchCreatorProfiles().catch(() => ({} as Record<string, CreatorProfile>)),
      ])
      if (cancelled) return
      setProfiles(profs)
      const p = all.find((x) => x.id === projectId) ?? null
      setProject(p)
      if (p && p.creatorIds.length) {
        // One query per member via the existing creatorHandle index — same
        // pattern as Creator.tsx, bounded by the member cap (25 server-side).
        const batches = await Promise.all(
          p.creatorIds.map((cid) =>
            fetchDetections({ creatorHandle: splitCreatorId(cid).handle, limit: 300 }).catch(() => []),
          ),
        )
        if (cancelled) return
        // Moderator-rejected rows are excluded, matching every other surface.
        const flat = batches.flat().filter((r) => r.is_false_positive !== true)
        setRawRows(flat)
        setRows(dedupeByPost(flat))
        // Stories separately: the per-creator fetch above is detected-only, so
        // it cannot say how many stories were captured — only how many had a
        // can in them. For a paid roster those are different numbers and the
        // second one is the one the client asks about.
        const members = new Set(p.creatorIds.map((cid) => splitCreatorId(cid).handle.toLowerCase()))
        const [sp, sd] = await Promise.all([
          fbFetchStoryPosts(2000).catch(() => null),
          fbFetchStories(2000).catch(() => [] as DetectionRow[]),
        ])
        if (cancelled) return
        setStoryPosts(sp && sp.filter((x) => members.has(x.creatorHandle)))
        // RAW, not deduped — the number of documents per story is how
        // joinStories knows a video verdict rests on thirteen frames
        // (storyStats.ts says exactly this above its signature). Deduping here
        // under-reported framesJudged on every video story; Home and Stories
        // already pass raw.
        setStoryDetections(sd)
      } else {
        setRows([])
        setRawRows([])
        setStoryPosts([])
        setStoryDetections([])
      }
    } catch (e) {
      if (!cancelled) setError((e as Error).message)
    } finally {
      if (!cancelled) setLoading(false)
    }
    })()
    return () => { cancelled = true }
  }, [projectId, reloadKey])

  const rollup = useMemo(
    () => (project ? rollupProject(project, rows) : null),
    [project, rows],
  )

  // Confirmed hits only, newest first — the same bar the feed and creator
  // pages use, so a count here never disagrees with a count there.
  const posts = useMemo(
    () => rows
      .filter((d) => d.detected === true && d.is_false_positive !== true)
      .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? '')),
    [rows],
  )

  // Stories for this roster. A festival campaign is the case stories exist
  // for: the roster posts all weekend and every one of those posts is gone
  // 24 hours later, so this leads the page rather than sitting below the KPIs.
  const [storiesState, setStoriesState] = useState<StoriesState | null>(null)
  const [storiesFetching, setStoriesFetching] = useState(false)
  const [storiesError, setStoriesError] = useState<string | null>(null)
  useEffect(() => fbSubscribeStoriesState(setStoriesState), [])
  const storyPreview = useStoryPostsPreview()
  const storyPreviewDetections = useStoryPreview()
  // Same join as Home and /stories, via storySource — passing [] for the
  // preview's detections threw away every locally produced verdict and made
  // analysed stories read as "nog niet geanalyseerd". That bug was fixed on
  // Home; this was the copy that kept it.
  const storyRows = useMemo(() => {
    const src = storySource(storyPreview, storyPreviewDetections, storyPosts ?? [], storyDetections)
    return joinStories(src.posts, src.detections)
  }, [storyPreview, storyPreviewDetections, storyPosts, storyDetections])
  const fetchStories = useCallback(async () => {
    setStoriesFetching(true)
    setStoriesError(null)
    try {
      await fbStepStories()
      reload()
      // Detections trail the sweep by a fan-out; look again shortly.
      window.setTimeout(reload, 20_000)
    } catch (e) {
      setStoriesError((e as Error).message)
    } finally {
      setStoriesFetching(false)
    }
  }, [])

  const act = async (
    action: 'addCreators' | 'removeCreators' | 'archive' | 'unarchive',
    params: { creatorIds?: string[]; names?: Record<string, string> },
  ) => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const updated = await projectsAction(action, { projectId: project.id, ...params })
      setProject(updated)
      if (action === 'addCreators') {
        // New members need their profiles/rows fetched to render properly.
        setShowImport(false)
        reload()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const scanNow = async () => {
    setBusy(true)
    setScanMsg(null)
    setError(null)
    try {
      // Honest scope: this steps the GLOBAL creator scan — every due tracked
      // creator, not just this project's. That is also why the button lives
      // here and not per-member.
      const out = await fbStepCreators(80, 8) as {
        creators_scanned?: number; posts_added?: number; skipped?: string
      }
      setScanMsg(out.skipped
        ? `Scan overgeslagen (${out.skipped}) — budgetlimiet bereikt voor vandaag.`
        : `Scan klaar: ${out.creators_scanned ?? 0} creators gescand, ${out.posts_added ?? 0} posts opgehaald. Detecties verschijnen binnen enkele minuten in de feed.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <PageShell title="Campagne"><Card className="p-14 text-center text-[13px] text-[var(--color-ink-subtle)]">Laden…</Card></PageShell>
  }
  if (!project) {
    return (
      <PageShell title="Campagne">
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-muted)]">
          Campagne niet gevonden. <Link to="/" className="underline">Terug naar het overzicht</Link>
        </Card>
      </PageShell>
    )
  }

  const trend: Series = { id: 'hits', label: 'Posts', tone: 'accent', data: bucketByDay(rollup?.postedAts ?? [], 60) }
  const r = rollup!
  const scored = r.hits - r.sentiment.unscored
  // Roster order: by display name where known (imports carry fullName), so the
  // list reads like the client's sheet instead of raw handle soup.
  const members = [...r.creators].sort((a, b) =>
    (profiles[a.handle]?.fullName ?? a.handle).localeCompare(profiles[b.handle]?.fullName ?? b.handle, 'nl'),
  )

  return (
    <PageShell
      title={project.name}
      crumbs={[{ label: 'Overzicht', to: '/' }]}
      subtitle={`${project.creatorIds.length} creators gevolgd · scan elke ${project.trackingTier === 'tier_1' ? '6 uur' : '12 uur'}${project.note ? ` · ${project.note}` : ''}${project.archived ? ' · GEARCHIVEERD' : ''}`}
      actions={
        <div className="flex items-center gap-3">
          {canWrite && !project.archived && (
            <Button
              size="sm" variant="secondary" disabled={busy}
              title="Scant álle due creators (niet alleen dit project) en haalt hun recente posts op"
              onClick={() => void scanNow()}
            >
              Scan creators nu
            </Button>
          )}
          {canWrite && !project.archived && (
            <Button
              size="sm" variant="ghost" disabled={busy}
              onClick={() => {
                // Archiving stops the fast cadence for every member not claimed
                // by another project — that is its point. Say so before doing it.
                if (window.confirm('Deze campagne archiveren? De creators vallen terug op de normale scanfrequentie, tenzij een andere campagne ze volgt.')) {
                  void act('archive', {})
                }
              }}
            >
              Archiveren
            </Button>
          )}
          {canWrite && project.archived && (
            // Reviving re-claims the members' fast cadence; the server re-checks
            // the tracking cap and refuses with a clear message when full.
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('unarchive', {})}>
              Terughalen
            </Button>
          )}
        </div>
      }
    >
      {error && <Card className="p-4 mb-4 text-[12px] text-[var(--color-bad)]">{error}</Card>}
      {scanMsg && <Card className="p-4 mb-4 text-[12px] text-[var(--color-ink-muted)]">{scanMsg}</Card>}

      <StoriesStrip
        rows={storyRows}
        state={storiesState}
        onOpen={(r) => r.detection && setActive(r.detection)}
        onFetch={fetchStories}
        fetching={storiesFetching}
        canWrite={canWrite && !project.archived}
        error={storiesError}
        preview={storyPreview != null}
        storiesHref={`/projects/${project.id}?tab=stories`}
      />

      <Tabs
        items={[
          { id: 'overzicht', label: 'Overzicht', count: r.hits || undefined },
          { id: 'stories', label: 'Stories', count: storyRows.length || undefined },
        ]}
        active={tab}
        onChange={(id) => {
          const next = new URLSearchParams(params)
          if (id === 'overzicht') next.delete('tab')
          else next.set('tab', id)
          setParams(next, { replace: true })
        }}
      />

      {tab === 'stories' ? (
        <div className="mt-8">
          <StoriesView projectId={project.id} params={params} setParams={setParams} embedded />
        </div>
      ) : (
      <div className="mt-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Posts gevonden" value={fmtNum(r.hits)} />
        <Kpi label="Creators" value={fmtNum(project.creatorIds.length)} />
        <Kpi
          label="Bereik"
          value={r.reach > 0 ? fmtNum(r.reach) : '—'}
          sub={r.reachKnownFor > 0
            ? `volgers bekend van ${r.reachKnownFor} van ${project.creatorIds.length}`
            : 'nog geen volgersaantallen — draai een profielverversing'}
        />
        <Kpi
          label="Positief"
          value={scored > 0 ? `${Math.round((r.sentiment.positive / scored) * 100)}%` : '—'}
          sub={scored > 0 ? `van ${fmtNum(scored)} beoordeeld` : 'nog niets beoordeeld'}
        />
      </div>

      {/* What they actually posted. The page used to stop at KPIs and a member
          list, so the one thing a campaign manager opens it for — the content —
          was two clicks away on someone else's page. */}
      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between mb-3 gap-3">
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Wat ze plaatsten
          </h3>
          {posts.length > SHOWN_POSTS && (
            <span className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
              nieuwste {SHOWN_POSTS} van {fmtNum(posts.length)}
            </span>
          )}
        </div>
        {posts.length === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-muted)] py-8 text-center">
            Nog geen posts met Stëlz van deze creators. Klik op “Scan creators nu” of wacht op de
            volgende scan.
          </p>
        ) : (
          <div className={CARD_GRID}>
            {posts.slice(0, SHOWN_POSTS).map((d) => (
              <button
                key={d.detection_id}
                onClick={() => setActive(d)}
                className="text-left bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-colors flex flex-col"
              >
                <MediaTile src={imageUrlFor(d)} size="card">
                  <span className="absolute top-2 right-2 text-[10px] uppercase tracking-widest bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
                    {d.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
                  </span>
                  {d.frame_idx != null && (
                    <span className="absolute bottom-2 right-2 text-[10px] bg-[var(--color-ink)]/80 text-white px-2 py-0.5">▶ video</span>
                  )}
                </MediaTile>
                <div className="p-3 flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium truncate">@{d.creator_handle}</span>
                  <span className="text-[var(--color-ink-subtle)] tabular-nums shrink-0">
                    {d.posted_at ? new Date(d.posted_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5">
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">Posts per dag</h3>
          <StackedDayBars series={[trend]} height={180} days={60} />
        </Card>

        <Card className="p-5">
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
            Creators — ook wie nog niets plaatste
          </h3>
          <ul className="divide-y divide-[var(--color-border)]">
            {members.map((c) => {
              const prof = profiles[c.handle]
              const displayName = prof?.fullName ?? null
              const followers = prof?.followerCount ?? c.followers
              return (
              <li key={c.creatorId} className="flex items-center gap-3 py-2.5">
                <Avatar src={prof?.avatarUrl ?? c.avatar} handle={c.handle} className="w-8 h-8 rounded-full text-[12px] shrink-0" />
                <Link to={`/creators/${c.handle}`} className="min-w-0 flex-1 hover:underline">
                  <span className="block text-[13px] font-medium truncate">{displayName ?? `@${c.handle}`}</span>
                  <span className="block text-[11px] text-[var(--color-ink-subtle)]">
                    {displayName ? `@${c.handle} · ` : ''}{c.platform}
                    {followers ? ` · ${followers.toLocaleString()} followers` : ''}
                    {c.lastHitAt ? ` · last hit ${new Date(c.lastHitAt).toLocaleDateString('nl-NL')}` : ''}
                  </span>
                </Link>
                {c.hits === 0 ? (
                  <Badge tone="muted">nog niets</Badge>
                ) : (
                  <Badge tone="accent">{c.hits} {c.hits === 1 ? 'post' : 'posts'}</Badge>
                )}
                {canWrite && !project.archived && (
                  <button
                    disabled={busy}
                    onClick={() => void act('removeCreators', { creatorIds: [c.creatorId] })}
                    title="Verwijder uit campagne — valt terug op de normale scanfrequentie, tenzij elders gevolgd"
                    className="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-bad)] shrink-0 disabled:opacity-40"
                  >
                    ✕
                  </button>
                )}
              </li>
              )
            })}
          </ul>
          {project.creatorIds.length === 0 && (
            <p className="text-[12px] text-[var(--color-ink-muted)] py-6 text-center">
              Nog geen creators. Voeg ze toe via de Creators-tab of het detailpaneel van een post.
            </p>
          )}
        </Card>
      </div>

      {canWrite && !project.archived && (
        <Card className="p-5 mt-6">
          <button
            onClick={() => setShowImport((v) => !v)}
            className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
          >
            Lijst importeren — plak uit een sheet {showImport ? '▴' : '▾'}
          </button>
          {showImport && (
            <div className="mt-4">
              <PasteImport
                busy={busy}
                submitLabel={(n) => `Voeg ${n} creators toe aan ${project.name}`}
                onImport={(ids, names) => void act('addCreators', { creatorIds: ids, names })}
              />
            </div>
          )}
        </Card>
      )}
      </div>
      )}

      <DetectionDrawer
        detection={active}
        similar={active ? posts.filter((d) => d.detection_id !== active.detection_id).slice(0, 8) : []}
        // Every detected frame of the same post — from the RAW rows: `rows` is
        // already deduped to one document per post, which capped this strip at
        // a single frame while Home showed the full set.
        frames={active ? rawRows
          .filter((d) => d.detected === true && parentPostKey(d) === parentPostKey(active))
          .sort((a, b) => (a.frame_idx ?? 0) - (b.frame_idx ?? 0)) : []}
        onClose={() => setActive(null)}
      />
    </PageShell>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)]">{label}</div>
      <div className="text-[22px] font-medium tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-ink-subtle)] mt-0.5">{sub}</div>}
    </Card>
  )
}
