// Stories — every one we captured, and where Stëlz was actually in frame.
//
// Driven by POSTS, not detections. detect_image writes no detection document
// when the image fetch fails, and story CDN links are short-lived signed URLs,
// so building this from detections would silently drop exactly the stories we
// failed to analyse — from the page that promises to show all of them.
//
// On the numbers: Instagram shows story views to the account owner only, so
// there is no view count to display and none is invented here. The page says
// that in plain Dutch rather than hoping nobody asks, because Stelz reads it.
// See lib/storyStats.ts for the full reasoning.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageShell, Card, Badge } from '../components/ui'
import { MediaTile } from '../components/MediaTile'
import { StackedDayBars, type Series } from '../components/Chart'
import { bucketByDay } from '../lib/buckets'
import {
  fbFetchStoryPosts, fbFetchStories, fbFetchCreatorProfiles,
  type StoryPost, type CreatorProfile,
} from '../lib/firestore'
import { fetchProjects, type Project } from '../lib/data'
import { type DetectionRow } from '../lib/types'
import {
  joinStories, storySource, storyRollup, stelzShare, isStelzStory, storyImage,
  VERDICT_LABEL, type StoryRow, type StoryVerdict,
} from '../lib/storyStats'
import { StoryDetail } from '../components/StoryDetail'
import { storyExpiry, storyChip } from '../lib/stories'
import { fmtNum, compactNum, timeAgo } from '../lib/format'
import { splitCreatorId } from '../lib/projects'
import { useStoryPostsPreview, useStoryPreview } from '../lib/devPreview'

/** Hard ceiling on one fetch. Stated on screen when it binds. */
const FETCH_LIMIT = 2000

type Filter = 'all' | 'stelz' | 'near' | 'none' | 'pending'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Alle stories' },
  { id: 'stelz', label: 'Met Stëlz' },
  { id: 'near', label: 'Mogelijk Stëlz' },
  { id: 'none', label: 'Zonder Stëlz' },
  { id: 'pending', label: 'Nog niet geanalyseerd' },
]

const VERDICT_TONE: Record<StoryVerdict, string> = {
  visible: 'bg-[var(--color-good)] text-white',
  small: 'bg-[var(--color-warn)] text-white',
  // Accent, not warn: a near miss is a question for a human, not a weaker hit.
  near: 'bg-[var(--color-accent)] text-white',
  absent: 'bg-[var(--color-ink)]/70 text-white',
  unanalysed: 'bg-[var(--color-ink-subtle)] text-white',
  rejected: 'bg-[var(--color-bad)] text-white',
}

/**
 * The whole surface, reusable.
 *
 * The campaign page renders this as its Stories tab rather than keeping a
 * second implementation in step with this one. Same components, same
 * aggregation, same wording — a campaign only narrows the set.
 */
export function StoriesView({ projectId, params, setParams, embedded = false }: {
  projectId: string | null
  params: URLSearchParams
  setParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void
  /** Inside a campaign page: no shell, no project picker, no breadcrumbs. */
  embedded?: boolean
}) {
  const filter = (params.get('f') as Filter) || 'all'
  const creator = params.get('c')

  const [posts, setPosts] = useState<StoryPost[]>([])
  const [detections, setDetections] = useState<DetectionRow[]>([])
  const [profiles, setProfiles] = useState<Record<string, CreatorProfile>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<StoryRow | null>(null)

  const preview = useStoryPostsPreview()
  const previewDetections = useStoryPreview()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [p, d, pr, pj] = await Promise.all([
          fbFetchStoryPosts(FETCH_LIMIT),
          fbFetchStories(FETCH_LIMIT).catch(() => [] as DetectionRow[]),
          fbFetchCreatorProfiles().catch(() => ({} as Record<string, CreatorProfile>)),
          fetchProjects().catch(() => [] as Project[]),
        ])
        if (cancelled) return
        setPosts(p)
        // Raw, NOT dedupeByPost: joinStories groups by post itself with the
        // same rule, and the number of documents per story is what says how
        // many frames were examined. Collapsing first reports a thirteen-frame
        // video as one image looked at.
        setDetections(d)
        setProfiles(pr)
        setProjects(pj)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const project = projects.find((x) => x.id === projectId) ?? null
  const roster = useMemo(
    () => (project ? project.creatorIds.map((cid) => splitCreatorId(cid).handle.toLowerCase()) : []),
    [project],
  )

  // storySource, not an inline ternary: passing [] for the preview's detections
  // is what made every locally analysed story render as "nog niet
  // geanalyseerd", and an inline ternary is exactly where that hides.
  const allRows = useMemo(() => {
    const src = storySource(preview, previewDetections, posts, detections)
    return joinStories(src.posts, src.detections)
  }, [preview, previewDetections, posts, detections])

  // Campaign scope first: the rollup below must describe the same set the grid
  // shows, or the KPI row and the tiles disagree on screen.
  const scoped = useMemo(() => {
    if (!project) return allRows
    const members = new Set(roster)
    return allRows.filter((r) => members.has(r.creatorHandle))
  }, [allRows, project, roster])

  const rollup = useMemo(() => storyRollup(scoped, profiles, roster), [scoped, profiles, roster])

  const shown = useMemo(() => {
    let out = scoped
    if (creator) out = out.filter((r) => r.creatorHandle === creator)
    if (filter === 'stelz') out = out.filter((r) => isStelzStory(r.verdict))
    if (filter === 'near') out = out.filter((r) => r.verdict === 'near')
    if (filter === 'none') out = out.filter((r) => r.verdict === 'absent')
    if (filter === 'pending') out = out.filter((r) => r.verdict === 'unanalysed')
    return [...out].sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
  }, [scoped, filter, creator])

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const trend: Series = {
    id: 'stories', label: 'Stories', tone: 'accent',
    data: bucketByDay(rollup.postedAts, 30),
  }
  const share = stelzShare(rollup)
  const videoCount = scoped.filter((r) => r.mediaType === 'video').length

  const body = (
    <>
      {preview && (
        <Card className="mb-6 px-4 py-2.5 text-[12px] text-[var(--color-warn)]">
          Preview: echte gescrapte stories uit een lokaal bestand, niet uit de database.
          {rollup.judged > 0
            ? ` De oordelen komen uit een lokale analyse met hetzelfde model, dezelfde prompt en
               dezelfde referentiefoto's als productie — ${fmtNum(rollup.judged)} van
               ${fmtNum(rollup.stories)} beoordeeld.`
            : ' Nog niet geanalyseerd, dus elk oordeel staat op "nog niet geanalyseerd".'}
        </Card>
      )}
      {error && <Card className="mb-6 p-4 text-[12px] text-[var(--color-bad)]">{error}</Card>}

      {loading ? (
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-subtle)]">Laden…</Card>
      ) : rollup.stories === 0 ? (
        <EmptyState project={project} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            <Kpi
              label="Stories vastgelegd"
              value={fmtNum(rollup.stories)}
              sub={`${rollup.creatorsPosted} creator${rollup.creatorsPosted === 1 ? '' : 's'} plaatste${
                roster.length ? ` van ${roster.length}` : ''
              }`}
            />
            {/* "0% Stëlz" is only worth reading next to proof that something
                looked. Images seen, not stories judged: a video is one story
                and thirteen images, and the story count hides that entirely. */}
            <Kpi
              label="Geanalyseerd"
              value={`${fmtNum(rollup.judged)}/${fmtNum(rollup.stories)}`}
              sub={rollup.imagesSeen > 0
                ? `${fmtNum(rollup.imagesSeen)} beelden bekeken · ${
                    fmtNum(videoCount)} video${videoCount === 1 ? '' : "'s"}`
                : 'nog niets beoordeeld'}
            />
            <Kpi
              label="Stëlz zichtbaar"
              value={share == null ? '—' : `${Math.round(share)}%`}
              sub={share == null
                ? 'nog niets geanalyseerd'
                : `${rollup.withStelz} van ${rollup.judged} beoordeeld`}
            />
            <Kpi
              label="Bereik (volgers)"
              value={rollup.reach > 0 ? compactNum(rollup.reach) : '—'}
              sub={rollup.reachKnownFor > 0
                ? `volgers bekend van ${rollup.reachKnownFor} van ${rollup.creatorsPosted}`
                : 'nog geen volgersaantallen'}
            />
            <Kpi
              label="Poll-stemmen"
              value={rollup.pollVotes > 0 ? compactNum(rollup.pollVotes) : '—'}
              sub={rollup.pollVotes > 0 ? 'mensen die aantoonbaar keken' : 'geen polls in deze stories'}
            />
          </div>

          {/* The client reads this page. The difference between an audience and
              a viewing figure has to be on the screen, not in a code comment. */}
          <Card className="mb-6 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
            <strong className="font-medium text-[var(--color-ink)]">Over deze cijfers.</strong>{' '}
            Instagram toont het aantal story-weergaven uitsluitend aan de accounthouder zelf, dus
            die cijfers zijn hier niet op te halen — voor niemand, met geen enkele tool.
            "Bereik" is de opgetelde volgersbasis van de creators die plaatsten, één keer per
            creator geteld: het publiek dat ze hébben, niet het aantal mensen dat keek.
            {rollup.pollVotes > 0 && (
              <> Poll-stemmen zijn wél exact en publiek: {fmtNum(rollup.pollVotes)} mensen hebben
              gestemd, en elke stem is iemand die de story zag. Dat is een geverifieerde ondergrens.</>
            )}
            {rollup.judged > 0 && (
              <>
                {' '}
                <strong className="font-medium text-[var(--color-ink)]">Over de analyse.</strong>{' '}
                Elke foto is aan het model voorgelegd, en van elke video de cover plus frames uit
                de hele looptijd — samen {fmtNum(rollup.imagesSeen)} beelden. Klik een story aan
                om te zien wat het model in dat beeld beschreef en op hoeveel beelden het oordeel
                rust.
                {rollup.unanalysed > 0 && (
                  <> {fmtNum(rollup.unanalysed)} {rollup.unanalysed === 1 ? 'story is' : 'stories zijn'}{' '}
                  níet beoordeeld; die staan apart onder "nog niet geanalyseerd" en tellen niet
                  mee als "geen Stëlz".</>
                )}
              </>
            )}
          </Card>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setParam('f', f.id === 'all' ? null : f.id)}
                className={`text-[12px] px-3 py-1.5 border transition-colors ${
                  filter === f.id
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                    : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'
                }`}
              >
                {f.label}
                {f.id === 'stelz' && rollup.withStelz > 0 && ` · ${rollup.withStelz}`}
                {f.id === 'near' && rollup.near > 0 && ` · ${rollup.near}`}
                {f.id === 'pending' && rollup.unanalysed > 0 && ` · ${rollup.unanalysed}`}
              </button>
            ))}
            {creator && (
              <button
                onClick={() => setParam('c', null)}
                className="text-[12px] px-3 py-1.5 border border-[var(--color-accent)] text-[var(--color-accent)]"
              >
                @{creator} ✕
              </button>
            )}
            <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
              {fmtNum(shown.length)} van {fmtNum(rollup.stories)}
            </span>
          </div>

          {posts.length >= FETCH_LIMIT && (
            <Card className="mb-4 px-4 py-2.5 text-[12px] text-[var(--color-warn)]">
              De ophaallimiet van {fmtNum(FETCH_LIMIT)} stories is bereikt — oudere stories staan er
              wel, maar zijn hier niet geladen.
            </Card>
          )}

          {shown.length === 0 ? (
            <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)]">
              Geen stories in deze selectie.
            </Card>
          ) : (
            <div className="flex flex-wrap gap-2 mb-8">
              {shown.map((r) => <StoryCard key={r.postId} row={r} onOpen={() => setOpen(r)} />)}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <Card className="p-5 lg:col-span-2">
              <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
                Stories per dag
              </h3>
              <StackedDayBars series={[trend]} height={150} days={30} />
            </Card>
            <Card className="p-5">
              <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
                Wat er in zat
              </h3>
              <dl className="space-y-2 text-[12px]">
                <Row label="Video's" value={`${fmtNum(videoCount)} · ${Math.round(rollup.videoSeconds)}s`} />
                <Row label="@-vermeldingen" value={fmtNum(rollup.mentions)} />
                <Row label="Link-stickers" value={fmtNum(rollup.links)} />
                <Row label="Polls" value={fmtNum(scoped.filter((r) => r.pollCount > 0).length)} />
              </dl>
            </Card>
          </div>

          <CreatorTable rollup={rollup} onPick={(h) => setParam('c', h === creator ? null : h)} />
        </>
      )}
      <StoryDetail row={open} onClose={() => setOpen(null)} />
    </>
  )

  if (embedded) return body
  return (
    <PageShell
      title="Stories"
      subtitle={project ? project.name : 'Alles wat we hebben vastgelegd'}
      crumbs={project
        ? [{ label: 'Overzicht', to: '/' }, { label: project.name, to: `/projects/${project.id}` }]
        : [{ label: 'Overzicht', to: '/' }]}
      actions={projects.length > 0 && (
        <select
          value={projectId ?? ''}
          onChange={(e) => setParam('p', e.target.value || null)}
          className="text-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
        >
          <option value="">Alle creators</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    >
      {body}
    </PageShell>
  )
}

function StoryCard({ row, onOpen }: { row: StoryRow; onOpen: () => void }) {
  const exp = storyExpiry({ content_type: 'story', expires_at: row.expiresAt })
  const body = (
    <>
      <MediaTile src={storyImage(row)} size="story" alt={`Story van @${row.creatorHandle}`}>
        <span className={`absolute top-1 left-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${VERDICT_TONE[row.verdict]}`}>
          {row.verdict === 'visible' ? 'Stëlz'
            : row.verdict === 'small' ? 'Stëlz klein'
            : row.verdict === 'near' ? 'Mogelijk' : VERDICT_LABEL[row.verdict]}
        </span>
        {/* Only when the verdict rests on more than the one image you are
            looking at. For a photo the verdict chip already says it was
            judged; for a video "13" is the difference between a glance at the
            cover and the whole clip, and that is not visible any other way. */}
        {row.framesJudged > 1 && (
          <span className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/70 text-white tabular-nums">
            {row.framesJudged} beelden
          </span>
        )}
        {row.mediaType === 'video' && (
          <span className="absolute bottom-1 right-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/80 text-white">
            ▶ {row.videoDuration ? `${Math.round(row.videoDuration)}s` : 'video'}
          </span>
        )}
      </MediaTile>
      <span className="block px-1.5 pt-1 text-[10px] truncate text-[var(--color-ink)]">
        @{row.creatorHandle}
      </span>
      <span className="block px-1.5 text-[9px] text-[var(--color-ink)] truncate tabular-nums">
        {row.postedAt ? timeAgo(row.postedAt) : 'datum onbekend'}
      </span>
      <span className="block px-1.5 pb-1 text-[9px] text-[var(--color-ink-subtle)] truncate">
        {exp ? storyChip(exp) : '—'}
        {row.pollVotes > 0 && ` · ${compactNum(row.pollVotes)} stemmen`}
        {row.pollVotes === 0 && row.mentions.length > 0 && ` · @${row.mentions[0]}`}
        {row.pollVotes === 0 && row.mentions.length === 0 && row.linkUrls.length > 0 && ' · link'}
      </span>
    </>
  )
  const cls = `shrink-0 w-[112px] block border text-left transition-colors ${
    isStelzStory(row.verdict)
      ? 'border-[var(--color-good)] hover:border-[var(--color-ink)]'
      : row.verdict === 'near'
        ? 'border-[var(--color-accent)] hover:border-[var(--color-ink)]'
        : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
  }`
  // Opens the analysis, not Instagram. The permalink dies with the story — it
  // was the tile's only action, so a day later every tile led nowhere, and the
  // one thing that survives (what the model saw) had no way in at all. The
  // Instagram link is offered inside the panel, labelled as perishable.
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cls}
      title={`@${row.creatorHandle} · ${VERDICT_LABEL[row.verdict]}`}
    >
      {body}
    </button>
  )
}

function CreatorTable({ rollup, onPick }: {
  rollup: ReturnType<typeof storyRollup>
  onPick: (handle: string) => void
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[12px] min-w-[640px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
            <th className="text-left font-normal px-4 py-2.5">Creator</th>
            <th className="text-right font-normal px-3 py-2.5">Stories</th>
            <th className="text-right font-normal px-3 py-2.5">Met Stëlz</th>
            <th className="text-right font-normal px-3 py-2.5">Volgers</th>
            <th className="text-right font-normal px-3 py-2.5">Poll-stemmen</th>
            <th className="text-right font-normal px-3 py-2.5">@-vermeldingen</th>
            <th className="text-right font-normal px-4 py-2.5">Laatste story</th>
          </tr>
        </thead>
        <tbody>
          {rollup.byCreator.map((c) => (
            <tr
              key={c.handle}
              onClick={() => c.stories > 0 && onPick(c.handle)}
              className={`border-b border-[var(--color-border)] last:border-0 ${
                c.stories > 0 ? 'cursor-pointer hover:bg-[var(--color-bg)]' : 'text-[var(--color-ink-subtle)]'
              }`}
            >
              <td className="px-4 py-2.5">
                <Link to={`/creators/${c.handle}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                  @{c.handle}
                </Link>
                {c.fullName && <span className="text-[var(--color-ink-subtle)]"> · {c.fullName}</span>}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{c.stories || '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {c.withStelz > 0
                  ? <Badge tone="good">{c.withStelz}{c.small > 0 ? ` (${c.small} klein)` : ''}</Badge>
                  : '—'}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {c.followers ? compactNum(c.followers) : '—'}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {c.pollVotes > 0 ? compactNum(c.pollVotes) : '—'}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{c.mentions || '—'}</td>
              <td className="px-4 py-2.5 text-right text-[var(--color-ink-subtle)]">
                {c.lastStoryAt ? timeAgo(c.lastStoryAt) : 'niets geplaatst'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function EmptyState({ project }: { project: Project | null }) {
  return (
    <Card className="p-12 text-center">
      <p className="text-[13px] text-[var(--color-ink-muted)] mb-2">
        Nog geen stories vastgelegd{project ? ` voor ${project.name}` : ''}.
      </p>
      <p className="text-[12px] text-[var(--color-ink-subtle)] max-w-[520px] mx-auto leading-relaxed">
        Stories verdwijnen na 24 uur, dus er valt alleen iets vast te leggen zolang ze live staan.
        Zet automatisch ophalen aan onder{' '}
        <Link to="/settings" className="underline hover:text-[var(--color-ink)]">Instellingen</Link>,
        of haal ze handmatig op met de knop bovenaan het overzicht.
      </p>
      {/* Dev server only; folded out of a production build with its URL. A
          router Link, not <a>: a full page load from the embedded event tab
          would re-pay the 25 MB campaign fixtures for one stories preview. */}
      {import.meta.env.DEV && (
        <p className="mt-4">
          <Link to="/stories?preview=stories" className="text-[12px] underline hover:text-[var(--color-ink)]">
            Lokale preview openen →
          </Link>
        </p>
      )}
    </Card>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1.5">{label}</div>
      <div className="stelz-display text-[26px] leading-none text-[var(--color-ink)]">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-ink-subtle)] mt-1.5">{sub}</div>}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="tabular-nums font-medium">{value}</dd>
    </div>
  )
}
