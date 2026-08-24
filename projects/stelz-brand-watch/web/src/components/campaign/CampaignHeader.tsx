// The six numbers, above the tabs, on every tab.
//
// WHY IT SITS ABOVE THE TABS. "Hoe doet Stëlz het op social" is not a question
// about the roster tab or the discovery tab; it is the question the page as a
// whole answers, and an answer that only appears once you pick the right tab is
// one most readers never see.
//
// THIS IS THE ONE PLACE THAT ADDS ACROSS PLATFORMS, and the distinction is
// worth being exact about. lib/campaign.ts forbids adding a TikTok play to a
// poll vote, because those are different EVENTS and their sum describes
// neither. A TikTok play and an Instagram reel play are the same event on two
// platforms; so are a digg and a like. Those add. What still never happens is
// one figure combining plays with likes — that would be the "total reach" this
// codebase has already had to unpick once.
//
// EVERY TILE CARRIES ITS COVERAGE, because 844.643 views across 27 of 67
// sightings is a different claim from 844.643 across all 67, and only one of
// them is true. Story sightings contribute to none of these six — Instagram
// publishes a story's numbers to the account holder and to nobody else — so the
// card below names how many of the sightings those are, from the data rather
// than from a figure written into this comment.

import { Card } from '../ui'
import { Kpi } from './Kpi'
import type { HitTotals } from '../../lib/hits'
import { compactNum, fmtNum } from '../../lib/format'

export function CampaignHeader({ totals, storyNote = true }: {
  totals: HitTotals
  /** Whether the "stories publish nothing" line applies to this selection. */
  storyNote?: boolean
}) {
  // POSTS, not sightings. The totals are per post — see hitTotals — so their
  // coverage has to be too, or the tile would divide a per-post figure by a
  // count of slides.
  const cover = (n: number) => `op ${fmtNum(n)} van ${fmtNum(totals.posts)} posts`
  return (
    <div className="mb-4 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Treffers"
          value={fmtNum(totals.hits)}
          sub={`op ${fmtNum(totals.posts)} posts · ${fmtNum(totals.accounts)} accounts`}
        />
        <Kpi
          label="Weergaven"
          value={totals.viewedOn > 0 ? compactNum(totals.views) : '—'}
          sub={totals.viewedOn > 0 ? cover(totals.viewedOn) : 'geen enkel vlak gaf er een'}
        />
        <Kpi
          label="Likes"
          value={totals.likedOn > 0 ? compactNum(totals.likes) : '—'}
          sub={totals.likedOn > 0 ? cover(totals.likedOn) : 'geen enkel vlak gaf er een'}
        />
        <Kpi
          label="Reacties"
          value={totals.commentedOn > 0 ? fmtNum(totals.comments) : '—'}
          sub={totals.commentedOn > 0 ? cover(totals.commentedOn) : 'geen enkel vlak gaf er een'}
        />
        <Kpi
          label="Gedeeld"
          value={totals.sharedOn > 0 ? fmtNum(totals.shares) : '—'}
          sub={totals.sharedOn > 0 ? cover(totals.sharedOn) : 'alleen TikTok publiceert dit'}
        />
        {/* Saves. The strongest intent signal TikTok gives — a like costs
            nothing, a save means "I want this back" — and it sat unused in the
            archive since the first harvest. */}
        <Kpi
          label="Opgeslagen"
          value={totals.savedOn > 0 ? fmtNum(totals.saves) : '—'}
          sub={totals.savedOn > 0 ? cover(totals.savedOn) : 'alleen TikTok publiceert dit'}
        />
      </div>
      <Card className="px-4 py-2.5 text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
        Alles hierboven telt alleen content waar Stëlz daadwerkelijk in beeld was.
        Weergaven en likes zijn over Instagram en TikTok heen opgeteld — het is
        dezelfde gebeurtenis op twee platforms — maar er staat nergens één getal dat
        weergaven en likes samenvoegt, want dat zou niets beschrijven. Elke post telt
        één keer mee: staat het blikje op vijf plaatjes van dezelfde carrousel, dan
        zijn dat vijf treffers en één keer die likes.
        {storyNote && totals.storyHits > 0 && (
          <> De {fmtNum(totals.storyHits)} story-treffers dragen aan geen van deze zes
            iets bij: Instagram geeft story-cijfers alleen aan de accounthouder zelf.</>
        )}
        {totals.engagementRate != null && (
          <> Op TikTok leverden de treffers {fmtNum(totals.tiktokInteractions)} interacties
            op {compactNum(totals.tiktokViews)} weergaven — {totals.engagementRate.toFixed(1)}%.</>
        )}
      </Card>
    </div>
  )
}
