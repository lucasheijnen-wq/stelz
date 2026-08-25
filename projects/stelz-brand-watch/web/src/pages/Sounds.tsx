// Sounds — leaderboard (/sounds) and per-sound drill-down (/sounds/:soundKey).
//
// Collab scouting: a sound that keeps showing up under brand hits, used by
// several distinct creators, is a scene the brand can join — and the creators
// using it are ranked collab candidates. Everything here is a client-side
// aggregation (lib/sounds.ts) of detections already fetched; zero extra
// Firestore reads beyond the one detection query.
//
// HONESTY RULES, inherited from lib/sounds.ts and stated in the UI:
//   * "trend" = trend within OUR OWN hits, not platform-wide trending;
//   * musicId exists on TikTok only — IG reels group by title|artist;
//   * media links (cover/play) are short-lived CDN URLs and may be dead.

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageShell, Card, Badge, Avatar } from '../components/ui'
import { StackedDayBars, type Series } from '../components/Chart'
import { bucketByDay } from '../lib/buckets'
import { dedupeByPost, type DetectionRow } from '../lib/types'
import { fetchDetections, fetchResonanceForCreator } from '../lib/data'
import { rollupSound, soundHref, tallySounds } from '../lib/sounds'

export default function Sounds() {
  // React Router v7 already decodes path segments before matching, so the
  // param arrives decoded. Decoding it AGAIN crashed on any sound title with a
  // literal '%' ("100% Zomer" -> URIError in the component body) and silently
  // corrupted titles containing decodable sequences. Review-confirmed.
  const { soundKey: rawKey } = useParams()
  const soundKey = rawKey ?? null

  const [rows, setRows] = useState<DetectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDetections({ limit: 5000 })
      // Same base set as the dashboard card: moderator-rejected rows are out.
      // Without this filter the page counted rows the card excludes, while its
      // own subtitle claimed the counts match. Review-confirmed.
      .then((d) => { if (!cancelled) { setRows(dedupeByPost(d).filter((r) => r.is_false_positive !== true)); setLoading(false) } })
      .catch((e) => { if (!cancelled) { setError(e.message ?? String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <PageShell title="Sounds"><Card className="p-14 text-center text-[13px] text-[var(--color-ink-subtle)]">Loading…</Card></PageShell>
  }
  if (error) {
    return <PageShell title="Sounds"><Card className="p-14 text-center text-[13px] text-[var(--color-bad)]">{error}</Card></PageShell>
  }
  return soundKey ? <SoundDetail rows={rows} soundKey={soundKey} /> : <SoundLeaderboard rows={rows} />
}

function SoundLeaderboard({ rows }: { rows: DetectionRow[] }) {
  const sounds = useMemo(() => tallySounds(rows), [rows])
  const withMusic = useMemo(() => rows.filter((r) => r.detected === true && r.music).length, [rows])
  const total = useMemo(() => rows.filter((r) => r.detected === true).length, [rows])

  return (
    <PageShell
      title="Sounds"
      subtitle={`Audio under your hits — ${sounds.length} distinct sounds across ${withMusic} of ${total} posts. Counts match the dashboard card exactly; both read the same aggregation.`}
    >
      {sounds.length === 0 ? (
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-muted)]">
          No music data yet. TikTok posts carry full sound identity; Instagram reels only a title —
          and posts without either are deliberately not counted, rather than pooled into an
          "(untitled)" bucket.
        </Card>
      ) : (
        <Card className="divide-y divide-[var(--color-border)]">
          {sounds.map((s, i) => (
            <Link
              key={s.key}
              to={soundHref(s.key)}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-[var(--color-bg)] transition-colors"
            >
              <span className="w-6 text-[12px] tabular-nums text-[var(--color-ink-subtle)] text-right shrink-0">{i + 1}</span>
              <span className="w-9 h-9 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center text-[14px] shrink-0">♫</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{s.label}</span>
                <span className="block text-[11px] text-[var(--color-ink-subtle)] truncate mt-0.5">
                  {s.artist || '—'}{s.original ? ' · original sound' : ''}
                </span>
              </span>
              <span className="text-[12px] tabular-nums text-[var(--color-ink-muted)] shrink-0">
                {s.creators} {s.creators === 1 ? 'creator' : 'creators'}
              </span>
              <span className="rounded-full border border-[var(--color-ink)] px-2.5 py-0.5 text-[11px] tabular-nums shrink-0">
                ×{s.hits}
              </span>
            </Link>
          ))}
        </Card>
      )}
    </PageShell>
  )
}

function SoundDetail({ rows, soundKey }: { rows: DetectionRow[]; soundKey: string }) {
  const rollup = useMemo(() => rollupSound(rows, soundKey), [rows, soundKey])
  // SRS per creator, for the collab ranking. Optional reads: a creator without
  // a resonance doc is normal, and a failure must not take the page down.
  const [srs, setSrs] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    if (!rollup) return
    let cancelled = false
    Promise.all(
      rollup.creators.slice(0, 8).map((c) =>
        fetchResonanceForCreator(c.handle)
          .then((r) => [c.handle, r?.srs ?? null] as const)
          .catch(() => [c.handle, null] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return
      setSrs(new Map(pairs.filter((p): p is [string, number] => p[1] != null)))
    })
    return () => { cancelled = true }
  }, [rollup])

  if (!rollup) {
    return (
      <PageShell title="Sounds">
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-muted)]">
          No hits carry this sound (any more). It may have been on posts outside the loaded window.
          {' '}<Link to="/sounds" className="underline">Back to all sounds</Link>
        </Card>
      </PageShell>
    )
  }

  const trend: Series = {
    id: 'hits', label: 'Hits', tone: 'accent',
    data: bucketByDay(rollup.postedAts, 60),
  }
  const scored = rollup.hits - rollup.sentiment.unscored

  return (
    <PageShell
      title={rollup.label}
      subtitle={`${rollup.artist || 'Unknown artist'}${rollup.original ? ' · original sound' : ''} · ${rollup.hits} hits · ${rollup.creators.length} creators`}
      actions={<Link to="/sounds" className="text-[12px] underline text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">← All sounds</Link>}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Hits" value={String(rollup.hits)} />
        <Kpi label="Creators" value={String(rollup.creators.length)} />
        <Kpi label="TikTok / Instagram" value={`${rollup.platforms.tiktok} / ${rollup.platforms.instagram}`} />
        <Kpi
          label="Positive share"
          value={scored > 0 ? `${Math.round((rollup.sentiment.positive / scored) * 100)}%` : '—'}
          sub={scored > 0 ? `of ${scored} scored` : 'nothing scored yet'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5">
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
            Hits over time <span className="normal-case tracking-normal">— within your own hits, not platform-wide</span>
          </h3>
          <StackedDayBars series={[trend]} height={180} days={60} />
        </Card>

        <Card className="p-5">
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
            Creators on this sound — collab candidates
          </h3>
          <ul className="divide-y divide-[var(--color-border)]">
            {rollup.creators.slice(0, 8).map((c) => (
              <li key={c.handle}>
                <Link to={`/creators/${c.handle}`} className="flex items-center gap-3 py-2.5 hover:bg-[var(--color-bg)] -mx-2 px-2 transition-colors">
                  <Avatar src={c.avatar} handle={c.handle} className="w-8 h-8 rounded-full text-[12px] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium truncate">@{c.handle}</span>
                    <span className="block text-[11px] text-[var(--color-ink-subtle)]">
                      {c.followers ? `${c.followers.toLocaleString()} followers · ` : ''}
                      {c.hits} {c.hits === 1 ? 'hit' : 'hits'} · ♥ {c.likes.toLocaleString()}
                    </span>
                  </span>
                  {srs.has(c.handle) && <Badge tone="accent">SRS {Math.round(srs.get(c.handle)!)}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
          {(rollup.url || rollup.playUrl) && (
            <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex gap-4 text-[12px]">
              {rollup.url && <a href={rollup.url} target="_blank" rel="noreferrer" className="underline text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">Open on TikTok ↗</a>}
              {rollup.playUrl && <a href={rollup.playUrl} target="_blank" rel="noreferrer" className="underline text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">Preview audio ↗</a>}
            </div>
          )}
        </Card>
      </div>
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
