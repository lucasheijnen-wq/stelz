// One story, and the evidence that it was actually looked at.
//
// Why this exists next to DetectionDrawer: that drawer answers "what is this
// hit worth" — shortlist, promote, open the original. This one answers a
// different question, and it is the question a page of "Geen Stëlz" tiles
// raises immediately: DID anything look at these, or is that just the empty
// state wearing a label? So it leads with how the verdict was reached — photo
// or video, on how many images — and prints the model's own description of the
// picture. A sentence about a clothing shop is proof no counter can give.
//
// Dutch throughout, because the client reads this page.

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from './ui'
import { PRODUCT_LINE_LABEL } from '../lib/labels'
import { MediaTile } from './MediaTile'
import { VERDICT_LABEL, type StoryVerdict } from '../lib/storyStats'
import type { DetectionRow } from '../lib/types'
import { storyExpiry, storyChip } from '../lib/stories'
import { fmtNum, compactNum } from '../lib/format'

/**
 * What this panel needs, and nothing more.
 *
 * Structural, so an IG story row and a TikTok row both satisfy it without a
 * conversion step and without a second copy of this component. The optional
 * fields are the ones that genuinely exist on one surface and not another: a
 * TikTok has no 24-hour expiry and no poll, an IG story has no view count.
 * Optional here means "this surface does not have one", never "we lost it".
 */
export type DetailRow = {
  creatorHandle: string
  url: string | null
  coverUrl: string | null
  videoUrl: string | null
  mediaType: 'image' | 'video'
  videoDuration: number | null
  postedAt: string | null
  hashtags: string[]
  mentions: string[]
  isPaidPartnership: boolean
  verdict: StoryVerdict
  detection: DetectionRow | null
  confidence: number | null
  framesJudged: number
  postedAtEstimated?: boolean
  expiresAt?: string | null
  pollVotes?: number | null
  pollQuestions?: string[]
  linkUrls?: string[]
  music?: { title: string | null; artist: string | null } | null
  caption?: string | null
  surfaceLabel?: string
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
}

/** Mirrored copy first: a story's own coverUrl is a signed link that dies
 *  within hours, and the detection carries the copy that outlives it. */
function detailImage(row: DetailRow): string | null {
  return row.detection?.stored_path || row.detection?.image_url || row.coverUrl || null
}

const SETTING_NL: Record<string, string> = {
  indoor: 'binnen',
  outdoor: 'buiten',
  festival: 'festival',
  beach: 'strand',
  bar: 'bar/café',
  home: 'thuis',
  unclear: 'onduidelijk',
}

/** The gate is the reason a real can can end up at 0.70 and out of the feed.
 *  Left as the raw tag when unknown rather than silently dropped — an
 *  unexplained demotion is exactly what this panel exists to expose. */
const GATE_NL: Record<string, string> = {
  capped_small_object: 'klein in beeld — betrouwbaarheid afgetopt op 70%',
  rejected_by_verifier: 'afgekeurd door de tweede controle',
  rejected_wordmark_mismatch: 'afgekeurd: het gelezen merk is niet Stëlz',
  demoted_wordmark_only: 'alleen een merknaam gelezen, geen product gezien',
  rejected_fabricated_fine_print:
    'de kleine lettertjes waren volgens het model niet leesbaar op deze afstand',
  verified_off_container: 'bevestigd door de tweede controle — niet op een blikje',
  verified_upgraded: 'bevestigd door de tweede controle op hogere resolutie',
}

// Where the wordmark sat, when it was not on a can (verifier.PLACEMENTS).
const PLACEMENT_NL: Record<string, string> = {
  signage: 'een bord, banner, parasol of bar',
  merchandise: 'merchandise — denk aan een dienblad, koelbox of opblaasbaar blik',
  clothing: 'kleding van iemand in beeld',
  other: 'iets anders dan een blikje',
}

export function StoryDetail({ row, onClose }: { row: DetailRow | null; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    if (row) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row, onClose])

  if (!row) return null
  const d = row.detection
  const exp = storyExpiry({ content_type: 'story', expires_at: row.expiresAt })
  const isVideo = row.mediaType === 'video'
  const analysed = row.verdict !== 'unanalysed'

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <aside className="fixed top-0 right-0 h-screen w-full max-w-[560px] bg-[var(--color-surface)] z-50 border-l border-[var(--color-border)] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-5 h-12 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            {row.surfaceLabel ?? 'Story'} · @{row.creatorHandle}
          </div>
          <button
            onClick={onClose}
            aria-label="Sluiten"
            className="w-7 h-7 flex items-center justify-center text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >✕</button>
        </div>

        <div className="p-5 space-y-6">
          {/* The video itself, not a still, when we mirrored one: judging a
              video story from its cover is precisely the shortcut this panel
              claims not to have taken. */}
          {row.videoUrl ? (
            <video
              src={row.videoUrl}
              poster={detailImage(row) ?? undefined}
              controls
              playsInline
              // Archive clips average 5 MB with a 144 MB outlier, and the dev
              // middleware serves no-store: only fetch when play is pressed.
              preload="none"
              className="w-full max-h-[420px] bg-[var(--color-bg)] border border-[var(--color-border)] object-contain"
            />
          ) : (
            <div className="bg-[var(--color-bg)] border border-[var(--color-border)]">
              <MediaTile src={detailImage(row)} size="hero" fit="contain" priority
                alt={`Story van @${row.creatorHandle}`} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={row.verdict === 'visible' ? 'good' : row.verdict === 'small' ? 'warn'
              : row.verdict === 'near' ? 'accent'
              : row.verdict === 'rejected' ? 'bad' : 'muted'}>
              {VERDICT_LABEL[row.verdict]}
            </Badge>
            {row.confidence != null && row.verdict !== 'absent' && (
              <Badge tone="muted">{Math.round(row.confidence * 100)}% zeker</Badge>
            )}
            {d?.product_line && <Badge>{PRODUCT_LINE_LABEL[d.product_line] ?? d.product_line}</Badge>}
            <Badge tone="muted">{isVideo ? `video · ${Math.round(row.videoDuration ?? 0)}s` : 'foto'}</Badge>
            {row.isPaidPartnership && <Badge tone="accent">betaalde samenwerking</Badge>}
          </div>

          {/* THE POINT OF THIS PANEL. Not "was Stëlz there" but "did we look",
              stated as a count of images the model received. */}
          <div className={`border-l-2 pl-3 py-1.5 ${
            analysed ? 'border-[var(--color-good)]' : 'border-[var(--color-warn)]'
          }`}>
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
              Analyse
            </div>
            {analysed ? (
              <p className="text-[12px] text-[var(--color-ink)] leading-relaxed">
                Beoordeeld op {fmtNum(row.framesJudged)} beeld{row.framesJudged === 1 ? '' : 'en'}
                {isVideo
                  ? ` — de cover plus ${fmtNum(Math.max(row.framesJudged - 1, 0))} frames uit de video.`
                  : ' — de story zelf.'}
                {' '}Het model kreeg dezelfde referentiefoto's van de blikjes als in productie.
              </p>
            ) : (
              <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
                Nog niet geanalyseerd. Dit is géén "geen Stëlz": er heeft niets naar dit beeld
                gekeken. Story-afbeeldingen staan op links die binnen enkele uren verlopen, dus
                een mislukte download laat een story bewust ongeoordeeld achter.
              </p>
            )}
            {d?.cover_only && (
              <p className="mt-1.5 text-[12px] text-[var(--color-warn)] leading-relaxed">
                Alleen de cover beoordeeld — de video zelf was niet op te halen. Een cover is
                één gekozen beeld, dus "niets gevonden" zegt hier veel minder dan bij een
                clip die helemaal is bekeken.
              </p>
            )}
            {d?.gate && (
              <p className="mt-1.5 text-[12px] text-[var(--color-warn)] leading-relaxed">
                {GATE_NL[d.gate] ?? d.gate}
              </p>
            )}
            {/* Where the wordmark was, when it was not on a can. A branded bar
                front or parasol is a placement the brand paid for, and a report
                that flattens it into "hit" loses the distinction the client
                cares about most. */}
            {d?.verify_placement && (
              <p className="mt-1.5 text-[12px] text-[var(--color-good)] leading-relaxed">
                Stëlz stond hier niet op een blikje maar op {PLACEMENT_NL[d.verify_placement]}.
              </p>
            )}
            {d?.verify_verdict && (
              <p className="mt-1.5 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
                Tweede controle: {d.verify_verdict}
                {d.verify_brand ? ` · gelezen merk "${d.verify_brand}"` : ''}
                {d.verify_reason ? ` — ${d.verify_reason}` : ''}
              </p>
            )}
          </div>

          {/* The disagreement, spelled out. This panel exists because a rejected
              hit used to look exactly like an empty field, and the rejection
              reason — the thing a person needs in order to overrule it — was
              never on screen at all. */}
          {row.verdict === 'near' && (
            <div className="border-l-2 border-[var(--color-accent)] pl-3 py-1.5">
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
                Waarom "mogelijk"
              </div>
              <p className="text-[12px] text-[var(--color-ink)] leading-relaxed">
                Het model las Stëlz in dit beeld{d?.visible_text ? ` ("${d.visible_text}")` : ''}, en
                de tweede controle draaide dat terug. Beide kunnen gelijk hebben — daarom staat het
                hier apart en niet stilzwijgend op "Geen Stëlz".
              </p>
              {(d?.near_miss_reason || d?.verify_reason) && (
                <p className="mt-1.5 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
                  Reden van de afwijzing: {d.near_miss_reason || d.verify_reason}
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
                Kijk zelf naar het beeld hierboven en beslis.
              </p>
            </div>
          )}
          {/* The model's own words. This is the part that cannot be faked by an
              empty state, so it stays even when the answer is "niets". */}
          {d && (d.context || d.visible_text || d.setting || d.activity || d.people_count != null) && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
                Wat het model zag
              </div>
              <dl className="grid grid-cols-[104px_1fr] gap-y-2.5 gap-x-4 text-[13px]">
                {d.context && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Beschrijving</dt>
                    <dd className="text-[var(--color-ink-muted)] leading-relaxed">{d.context}</dd>
                  </>
                )}
                {d.visible_text && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Tekst gelezen</dt>
                    <dd className="font-medium">"{d.visible_text}"</dd>
                  </>
                )}
                {d.setting && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Omgeving</dt>
                    <dd>{SETTING_NL[d.setting] ?? d.setting}</dd>
                  </>
                )}
                {d.activity && d.activity !== 'none' && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Activiteit</dt>
                    <dd>{d.activity}</dd>
                  </>
                )}
                {d.people_count != null && (
                  <>
                    <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Mensen</dt>
                    <dd className="tabular-nums">{fmtNum(d.people_count)}</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
              De post zelf
            </div>
            <dl className="grid grid-cols-[104px_1fr] gap-y-2 gap-x-4 text-[13px]">
              {/* TikTok publishes play counts; Instagram publishes story views
                  to the account holder alone. So this row appears on one
                  surface and is absent on the other, rather than showing a
                  zero that would read as "nobody watched". */}
              {row.views != null && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Weergaven</dt>
                  <dd className="tabular-nums font-medium">{compactNum(row.views)}</dd>
                </>
              )}
              {(row.likes != null || row.comments != null || row.shares != null) && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Reacties</dt>
                  <dd className="tabular-nums">
                    {[row.likes != null ? `${compactNum(row.likes)} likes` : null,
                      row.comments != null ? `${compactNum(row.comments)} reacties` : null,
                      row.shares != null ? `${compactNum(row.shares)} keer gedeeld` : null,
                    ].filter(Boolean).join(' · ')}
                  </dd>
                </>
              )}
              <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Geplaatst</dt>
              <dd>
                {row.postedAt
                  ? new Date(row.postedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })
                  : 'onbekend'}
                {row.postedAtEstimated && (
                  <span className="text-[var(--color-ink-subtle)]"> · geschat</span>
                )}
                {exp && <span className="text-[var(--color-ink-subtle)]"> · {storyChip(exp)}</span>}
              </dd>

              {(row.pollVotes ?? 0) > 0 && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Poll-stemmen</dt>
                  <dd className="tabular-nums">
                    {compactNum(row.pollVotes ?? 0)}
                    <span className="text-[var(--color-ink-subtle)]"> · elke stem is iemand die keek</span>
                  </dd>
                </>
              )}
              {(row.pollQuestions ?? []).length > 0 && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Vraag</dt>
                  <dd className="text-[var(--color-ink-muted)]">{(row.pollQuestions ?? []).join(' · ')}</dd>
                </>
              )}
              {row.mentions.length > 0 && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Getagd</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {row.mentions.map((m) => (
                      <Link key={m} to={`/creators/${m}`} className="hover:underline">@{m}</Link>
                    ))}
                  </dd>
                </>
              )}
              {row.hashtags.length > 0 && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Hashtags</dt>
                  <dd className="text-[var(--color-ink-muted)]">{row.hashtags.map((h) => `#${h}`).join(' ')}</dd>
                </>
              )}
              {row.caption && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Bijschrift</dt>
                  <dd className="text-[var(--color-ink-muted)] leading-relaxed whitespace-pre-wrap">{row.caption}</dd>
                </>
              )}
              {row.music && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Muziek</dt>
                  <dd>{[row.music.title, row.music.artist].filter(Boolean).join(' — ') || 'onbekend'}</dd>
                </>
              )}
              {(row.linkUrls ?? []).length > 0 && (
                <>
                  <dt className="text-[var(--color-ink-subtle)] text-[11px] uppercase tracking-widest pt-0.5">Link-sticker</dt>
                  <dd className="break-all text-[var(--color-ink-muted)]">{(row.linkUrls ?? []).join(' · ')}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="flex flex-wrap gap-3 text-[12px]">
            <Link to={`/creators/${row.creatorHandle}`} className="underline hover:text-[var(--color-ink)]">
              @{row.creatorHandle} bekijken
            </Link>
            {/* The permalink dies with the story, so it is offered as what it
                is rather than as a reliable archive link. */}
            {row.url && (
              <a href={row.url} target="_blank" rel="noreferrer"
                className="underline hover:text-[var(--color-ink)]">
                Op Instagram openen ↗ <span className="text-[var(--color-ink-subtle)]">(alleen zolang live)</span>
              </a>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
