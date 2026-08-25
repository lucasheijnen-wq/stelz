import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Img } from './ui'
import { PRODUCT_LINE_LABEL } from '../lib/labels'
import { formatFollowers } from '../lib/format'
import { MediaTile } from './MediaTile'
import { imageUrlFor, loadState, toggleShortlist, toggleHidden, type DetectionRow } from '../lib/data'
import { isBrandTag } from '../lib/signal'
import { detectionQuality } from '../lib/quality'
import { AddToProject } from './AddToProject'
import { verifyDetection } from '../lib/verify'
import { useResetOn } from '../lib/useResetOn'

export function DetectionDrawer({
  detection,
  similar,
  frames = [],
  onClose,
}: {
  detection: DetectionRow | null
  similar: DetectionRow[]
  frames?: DetectionRow[]
  onClose: () => void
}) {
  const [shortlist, setShortlist] = useState<string[]>(() => loadState().shortlist)
  const [hidden, setHidden] = useState<string[]>(() => loadState().hidden)
  // Which frame's image is showing in the hero slot.
  const [activeFrame, setActiveFrame] = useState<DetectionRow | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (detection) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detection, onClose])

  // Reset frame selection when a different detection opens. During render, so
  // the new detection never paints with the previous one's frame selected.
  useResetOn(detection?.detection_id, () => setActiveFrame(null))

  if (!detection) return null
  const d = detection
  const hero = activeFrame ?? d
  const quality = detectionQuality(d)
  const verdict = verifyDetection(d)
  const inShortlist = shortlist.includes(d.detection_id)
  const isHidden = hidden.includes(d.creator_handle)

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <aside className="fixed top-0 right-0 h-screen w-full max-w-[640px] bg-[var(--color-surface)] z-50 border-l border-[var(--color-border)] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-5 h-12 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">Detection · {d.detection_id.slice(0, 8)}</div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">✕</button>
        </div>

        <div className="p-5 space-y-6">
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] relative">
            <MediaTile src={imageUrlFor(hero)} size="wide" fit="contain" priority>
              {hero.frame_idx != null && (
                <span className="absolute bottom-2 right-2 text-[10px] bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
                  frame {hero.frame_idx}
                </span>
              )}
            </MediaTile>
          </div>

          {/* All detected frames of this post — click to swap the hero image */}
          {frames.length > 1 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">
                Detected in {frames.length} frames
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {frames.map((f) => (
                  <button
                    key={f.detection_id}
                    onClick={() => setActiveFrame(f)}
                    className={`w-14 h-14 border p-0.5 bg-[var(--color-surface)] transition-colors ${
                      (activeFrame ?? d).detection_id === f.detection_id
                        ? 'border-[var(--color-ink)]'
                        : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
                    }`}
                    title={f.frame_idx != null ? `Frame ${f.frame_idx} · ${((f.confidence ?? 0) * 100).toFixed(0)}%` : undefined}
                  >
                    <Img src={imageUrlFor(f)} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {d.product_line && <Badge>{PRODUCT_LINE_LABEL[d.product_line] ?? d.product_line}</Badge>}
            {d.size_in_frame && <Badge tone="muted">size · {d.size_in_frame}</Badge>}
            {d.is_primary_subject && <Badge tone="muted">primary</Badge>}
            {quality.quality === 'small' ? (
              <Badge tone="warn">small in frame</Badge>
            ) : (
              <Badge tone={quality.quality === 'clear' ? 'good' : 'bad'}>
                {((d.confidence ?? 0) * 100).toFixed(0)}% confidence
              </Badge>
            )}
            {d.creator_tier && <Badge tone={d.creator_tier === 'tier_1' ? 'accent' : 'neutral'}>tier {d.creator_tier}</Badge>}
            <Badge tone="muted">{d.platform}</Badge>
          </div>

          {/* Why the score looks the way it does. Without this, a genuine can
              stored at 0.70 by the size gate reads as "the AI wasn't sure",
              which is the opposite of what happened. See lib/quality.ts. */}
          {quality.quality !== 'clear' && (
            <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed border-l-2 border-[var(--color-warn)] pl-3 py-1">
              {quality.reason}
            </p>
          )}

          {/* What the second look at the stored transcript says. See lib/verify.ts
              — this reads the model's own label read, it does not re-examine the
              image, and the header there is honest about how weak that is. */}
          {(verdict.competitor || verdict.tier === 'wordmark_only') && (
            <p className={`text-[12px] leading-relaxed border-l-2 pl-3 py-1 ${
              verdict.competitor
                ? 'border-[var(--color-bad)] text-[var(--color-ink)]'
                : 'border-[var(--color-warn)] text-[var(--color-ink-muted)]'
            }`}>
              {verdict.reason}
            </p>
          )}

          <div>
            <Link to={`/creators/${d.creator_handle}`} className="text-[16px] font-medium hover:underline">@{d.creator_handle}</Link>
            <div className="text-[12px] text-[var(--color-ink-muted)] mt-0.5 tabular-nums">
              {/* Omitted entirely when unknown. Instagram's hashtag scrape does
                  not return follower counts, so "0 followers" was being shown
                  for most creators — a false statement, not a missing one. */}
              {formatFollowers(d.follower_count) ? `${formatFollowers(d.follower_count)} followers` : ''}
              {formatFollowers(d.follower_count) && d.likes_count ? ' · ' : ''}
              {d.likes_count ? `${d.likes_count.toLocaleString()} likes` : ''}
              {d.posted_at
                ? `${(formatFollowers(d.follower_count) || d.likes_count) ? ' · ' : ''}${new Date(d.posted_at).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })}`
                : ''}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={inShortlist ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setShortlist(toggleShortlist(d.detection_id))}
            >
              {inShortlist ? '✓ Shortlisted' : '+ Shortlist'}
            </Button>
            {/* Replaces the old "Promote to tier 1" button, which had no
                onClick — a visual promise with nothing behind it. Adding to a
                project is what promotion actually is now: the server patches
                the tier and the cadence map does the rest. */}
            <AddToProject creatorId={`${d.platform || 'instagram'}_${d.creator_handle.toLowerCase()}`} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setHidden(toggleHidden(d.creator_handle))}
            >
              {isHidden ? 'Unhide creator' : 'Hide creator'}
            </Button>
            {d.post_url && (
              <a href={d.post_url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost">Open original ↗</Button>
              </a>
            )}
          </div>

          {d.post_caption && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">Caption</div>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{d.post_caption}</p>
            </div>
          )}

          {d.sentiment && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">
                How it's talked about
              </div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] font-medium capitalize">{d.sentiment}</span>
                {d.sentiment_score != null && (
                  <span className="text-[11px] tabular-nums text-[var(--color-ink-subtle)]">
                    {d.sentiment_score > 0 ? '+' : ''}{d.sentiment_score.toFixed(2)}
                  </span>
                )}
              </div>
              {d.sentiment_rationale && (
                <p className="mt-1.5 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
                  {d.sentiment_rationale}
                </p>
              )}
              {/* Says where the judgement came from. Without this the label
                  reads as a verdict on the photo, which it is not — the model
                  never sees the image on this call. */}
              <p className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
                Read from the caption, not the image.
              </p>
            </div>
          )}

          {(d.context || d.surface_type || d.visible_text || d.activity || d.setting || d.people_count != null) && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">What the AI saw</div>
              <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 gap-x-4 text-[13px]">
                {d.visible_text && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Text read</dt>
                    <dd className="font-medium tabular-nums text-[var(--color-ink)]">"{d.visible_text}"</dd>
                  </>
                )}
                {d.surface_type && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Surface</dt>
                    <dd>{d.surface_type.replace(/_/g, ' ')}</dd>
                  </>
                )}
                {d.activity && d.activity !== 'none' && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Activity</dt>
                    <dd>{d.activity}</dd>
                  </>
                )}
                {d.setting && d.setting !== 'unclear' && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Setting</dt>
                    <dd className="capitalize">{d.setting}</dd>
                  </>
                )}
                {d.people_count != null && d.people_count > 0 && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">People</dt>
                    <dd className="tabular-nums">{d.people_count}</dd>
                  </>
                )}
                {d.context && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Notes</dt>
                    <dd className="text-[var(--color-ink-muted)] leading-relaxed">{d.context}</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {d.post_hashtags && d.post_hashtags.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">Hashtags</div>
              <div className="flex flex-wrap gap-1.5">
                {d.post_hashtags.map((h) => (
                  <span
                    key={h}
                    className={`text-[12px] px-2 py-0.5 border ${
                      isBrandTag(h)
                        ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                        : 'border-[var(--color-border-strong)] bg-[var(--color-bg)]'
                    }`}
                  >#{h}</span>
                ))}
              </div>
            </div>
          )}

          {/* The single most important sentence in this drawer: it says why the
              post is worth anything. See lib/signal.ts. */}
          {d.signal?.signal === 'visual_only' && (
            <div className="border-l-2 border-[var(--color-accent)] pl-3 py-1">
              <p className="text-[12px] text-[var(--color-ink)] leading-relaxed">
                No brand hashtag, no @mention.{' '}
                <span className="text-[var(--color-ink-muted)]">
                  This post is invisible to anyone following #stelz — it was found by
                  reading the can in the image.
                  {d.signal.namedInCaption && ' The brand is named in the caption, but Instagram has no caption search.'}
                </span>
              </p>
            </div>
          )}

          {similar.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">
                Other hits from @{d.creator_handle}
              </div>
              <div className="grid grid-cols-4 gap-px bg-[var(--color-border)] border border-[var(--color-border)]">
                {similar.slice(0, 8).map((s) => (
                  <a key={s.detection_id} href={s.post_url ?? '#'} target="_blank" rel="noreferrer" className="bg-[var(--color-surface)] p-1.5 block">
                    <MediaTile src={imageUrlFor(s)} size="thumb" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

