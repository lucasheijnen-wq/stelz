import { MediaTile } from '../MediaTile'
import { metricFor, SURFACE_LABEL, type CampaignRow } from '../../lib/campaign'
import { VERDICT_LABEL, isStelzStory, type StoryVerdict } from '../../lib/storyStats'
import { compactNum, timeAgo } from '../../lib/format'

const VERDICT_TONE: Record<StoryVerdict, string> = {
  visible: 'bg-[var(--color-good)] text-white',
  small: 'bg-[var(--color-warn)] text-white',
  near: 'bg-[var(--color-accent)] text-white',
  absent: 'bg-[var(--color-ink)]/70 text-white',
  unanalysed: 'bg-[var(--color-ink-subtle)] text-white',
  rejected: 'bg-[var(--color-bad)] text-white',
}

// Shown instead of the plain "Stëlz" tag when the wordmark was not on a can.
// Short enough for a 112px tile; the drawer spells it out.
const PLACEMENT_TAG: Record<string, string> = {
  signage: 'Stëlz bord',
  merchandise: 'Stëlz merch',
  clothing: 'Stëlz kleding',
  other: 'Stëlz',
}

/** One piece of content as a tile: the image the model actually judged, what it
 *  concluded, and the one metric that surface publishes. */
export function ContentCard({ row, onOpen, showTag, moreSlides }: {
  row: CampaignRow
  onOpen: () => void
  /** The hashtag that surfaced this, for discovery tiles. Without it the
   *  organic section is a list of strangers with no account of how they were
   *  found. */
  showTag?: boolean
  /** Sightings of the same post folded into this card. The grid shows one card
   *  per POST; a carousel with the can on eight slides is one card and this
   *  badge, not eight near-identical tiles. */
  moreSlides?: number
}) {
  const metric = metricFor(row)
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`@${row.creatorHandle} · ${SURFACE_LABEL[row.surface]} · ${VERDICT_LABEL[row.verdict]}${
        row.foundVia ? ` · via #${row.foundVia}` : ''}`}
      className={`shrink-0 w-[112px] block border text-left transition-colors ${
        isStelzStory(row.verdict)
          ? 'border-[var(--color-good)] hover:border-[var(--color-ink)]'
          : row.verdict === 'near'
            ? 'border-[var(--color-accent)] hover:border-[var(--color-ink)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      <MediaTile
        src={row.detection?.stored_path || row.detection?.image_url || row.coverUrl}
        size="story"
        alt={`${SURFACE_LABEL[row.surface]} van @${row.creatorHandle}`}
      >
        <span className={`absolute top-1 left-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${VERDICT_TONE[row.verdict]}`}>
          {/* A logo on a bar front or a cap is a sighting, but not the same
              sighting as a can in someone's hand — the tile says which. */}
          {row.placement ? PLACEMENT_TAG[row.placement]
            : row.verdict === 'visible' ? 'Stëlz'
            : row.verdict === 'small' ? 'Stëlz klein'
            : row.verdict === 'near' ? 'Mogelijk' : VERDICT_LABEL[row.verdict]}
        </span>
        <span className="absolute top-1 right-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/70 text-white">
          {row.surface === 'tiktok' ? 'TT' : row.surface === 'story' ? 'ST' : 'IG'}
        </span>
        {/* One card fronts the whole post: say how many more of its slides
            carry the can, instead of drawing a near-identical tile for each. */}
        {moreSlides != null && moreSlides > 0 ? (
          <span
            title={`Stëlz staat ook op ${moreSlides} andere dia${moreSlides === 1 ? '' : "'s"} van deze post`}
            className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/70 text-white tabular-nums"
          >
            +{moreSlides} dia{moreSlides === 1 ? '' : "'s"}
          </span>
        ) : row.slots != null && row.slots > 1 ? (
          // Which slide of a carousel, when only one of its slides is shown.
          <span className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/70 text-white tabular-nums">
            {(row.slot ?? 0) + 1}/{row.slots}
          </span>
        ) : null}
        {(row.slots == null || row.slots <= 1) && !(moreSlides != null && moreSlides > 0)
          && row.framesJudged > 1 && (
          <span className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 bg-[var(--color-ink)]/70 text-white tabular-nums">
            {row.framesJudged} beelden
          </span>
        )}
        {row.missedByDeploy && (
          <span
            title="De live backend verkleint dit beeld naar 512px en vindt Stëlz dan niet meer"
            className="absolute bottom-1 right-1 text-[9px] px-1 py-0.5 bg-[var(--color-warn)] text-white"
          >
            niet live
          </span>
        )}
      </MediaTile>
      <span className="block px-1.5 pt-1 text-[10px] truncate text-[var(--color-ink)]">
        @{row.platformHandle || row.creatorHandle}
      </span>
      <span className="block px-1.5 text-[9px] text-[var(--color-ink)] truncate tabular-nums">
        {row.postedAt ? timeAgo(row.postedAt) : 'datum onbekend'}
      </span>
      <span className="block px-1.5 pb-1 text-[9px] text-[var(--color-ink-subtle)] truncate">
        {showTag && row.foundVia
          ? `#${row.foundVia}`
          : metric != null
            ? `${compactNum(metric)} ${row.surface === 'tiktok' ? 'views' : row.surface === 'post' ? 'likes' : 'stemmen'}`
            : '—'}
      </span>
    </button>
  )
}
