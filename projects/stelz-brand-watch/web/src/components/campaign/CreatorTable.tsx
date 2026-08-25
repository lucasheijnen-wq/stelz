import { Link } from 'react-router-dom'
import { Card, Badge } from '../ui'
import { SURFACES, type CampaignRollup } from '../../lib/campaign'
import { compactNum, timeAgo } from '../../lib/format'

/** Who on the roster delivered what.
 *
 *  EVERYONE IS IN THIS TABLE, INCLUDING THE SILENT ONES. The grids above show
 *  only content with Stëlz in it, because a stranger's festival video is not a
 *  finding. This table is the opposite case: a booked creator who posted
 *  nothing is the single most useful row on the page, and dropping her because
 *  she has no tiles would turn a contract failure into a blank space. */
export function CreatorTable({ rollup, onPick, selected }: {
  rollup: CampaignRollup
  onPick: (handle: string) => void
  selected?: string | null
}) {
  if (rollup.creators.length === 0) {
    return (
      <Card className="p-8 text-center text-[12px] text-[var(--color-ink-muted)]">
        Nog geen roster voor dit evenement. Importeer de creatorlijst bij Instellingen —
        daarna staat hier ook wie níets plaatste, en dat is meestal de nuttigste rij.
      </Card>
    )
  }
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[12px] min-w-[900px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
            <th className="text-left font-normal px-4 py-2.5">Creator</th>
            <th className="text-right font-normal px-3 py-2.5">IG stories</th>
            <th className="text-right font-normal px-3 py-2.5">IG posts</th>
            <th className="text-right font-normal px-3 py-2.5">TikToks</th>
            <th className="text-right font-normal px-3 py-2.5">Met Stëlz</th>
            <th className="text-right font-normal px-3 py-2.5">Mogelijk</th>
            {/* Three columns, never a fourth that adds them. A TikTok play, an
                Instagram like and a poll vote are three different events; a
                "totaal bereik" spanning them would describe none of them. The
                headers name the surface for that reason. */}
            <th className="text-right font-normal px-3 py-2.5" title="Afspeeltellingen op TikTok">
              TikTok-views
            </th>
            <th className="text-right font-normal px-3 py-2.5" title="Likes op Instagram-posts">
              IG-likes
            </th>
            <th
              className="text-right font-normal px-3 py-2.5"
              title="Poll-stemmen op stories — Instagram geeft kijkcijfers alleen aan de accounthouder, dus dit is de enige harde ondergrens"
            >
              Pollstemmen
            </th>
            <th className="text-right font-normal px-4 py-2.5">Laatste post</th>
          </tr>
        </thead>
        <tbody>
          {rollup.creators.map((c) => {
            const last = SURFACES
              .map((s) => c.bySurface[s].lastPostedAt)
              .filter(Boolean)
              .sort()
              .pop()
            return (
              <tr
                key={c.handle}
                onClick={() => !c.silent && onPick(c.handle)}
                className={`border-b border-[var(--color-border)] last:border-0 ${
                  c.silent ? 'text-[var(--color-ink-subtle)]' : 'cursor-pointer hover:bg-[var(--color-bg)]'
                } ${selected === c.handle ? 'bg-[var(--color-bg)]' : ''}`}
              >
                <td className="px-4 py-2.5">
                  <Link to={`/creators/${c.handle}`} className="hover:underline"
                    onClick={(e) => e.stopPropagation()}>@{c.handle}</Link>
                  {c.fullName && <span className="text-[var(--color-ink-subtle)]"> · {c.fullName}</span>}
                  {c.silent && (
                    <span className="text-[var(--color-warn)]"> · plaatste niets</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.bySurface.story.items || '—'}</td>
                {/* Posts, not slides: a ten-slide carousel is one post. */}
                <td className="px-3 py-2.5 text-right tabular-nums">{c.bySurface.post.posts || '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.bySurface.tiktok.items || '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {c.withStelz > 0 ? <Badge tone="good">{c.withStelz}</Badge> : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {c.near > 0 ? <Badge tone="accent">{c.near}</Badge> : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {c.bySurface.tiktok.metric ? compactNum(c.bySurface.tiktok.metric) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {c.bySurface.post.metric ? compactNum(c.bySurface.post.metric) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {c.bySurface.story.metric ? compactNum(c.bySurface.story.metric) : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-[var(--color-ink-subtle)]">
                  {last ? timeAgo(last) : 'niets geplaatst'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
