import { useMemo, useState } from 'react'
import { Card } from '../ui'
import { MediaTile } from '../MediaTile'
import { SOURCE_LABEL, SURFACE_LABEL, type CampaignRow } from '../../lib/campaign'
import {
  hitText, liveColumns, metricLegend, sortHits,
  type HitColumnKey,
} from '../../lib/hits'
import { fmtNum } from '../../lib/format'

/** Every sighting on one row, sortable by any column.
 *
 *  The grids elsewhere on this page are for looking at content. This is for
 *  reading numbers off — the thing a brand does with a campaign once it stops
 *  being new. Both show exactly the same set of rows, so a figure here can
 *  always be traced back to a tile.
 *
 *  On the empty cells, see lib/hits.ts: a story publishes no view count, and a
 *  blank that says so is worth more than a zero that doesn't. */
export function HitsTable({ rows, onOpen }: {
  rows: CampaignRow[]
  onOpen: (r: CampaignRow) => void
}) {
  const [sort, setSort] = useState<{ key: HitColumnKey; dir: 'asc' | 'desc' }>(
    { key: 'postedAt', dir: 'desc' },
  )
  // Only the columns that hold a real number somewhere in THIS selection. Under
  // a story-only filter, "Delen" would otherwise be a column of 24 dashes,
  // which reads as a score rather than as an absence of measurement.
  const cols = useMemo(() => liveColumns(rows), [rows])
  const sorted = useMemo(() => sortHits(rows, sort.key, sort.dir), [rows, sort])
  const legend = useMemo(() => metricLegend(), [])

  if (rows.length === 0) {
    return (
      <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)]">
        Geen treffers in deze selectie.
      </Card>
    )
  }

  const pick = (key: HitColumnKey) => setSort((s) => (
    s.key === key
      // Numbers open on their highest value, text on its first — both are what
      // you meant by clicking, and neither needs a second click to get there.
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: cols.find((c) => c.key === key)?.numeric ? 'desc' : 'asc' }
  ))

  return (
    <div className="space-y-3">
      <Card className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1000px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
              <th className="w-[44px] px-3 py-2.5" />
              {cols.map((c) => {
                const on = sort.key === c.key
                return (
                  <th
                    key={c.key}
                    title={c.title}
                    onClick={() => pick(c.key)}
                    className={`font-normal px-3 py-2.5 cursor-pointer select-none whitespace-nowrap hover:text-[var(--color-ink)] ${
                      c.numeric ? 'text-right' : 'text-left'
                    } ${on ? 'text-[var(--color-ink)]' : ''}`}
                  >
                    {c.label}
                    <span className="text-[var(--color-ink-subtle)]">
                      {on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ' ·'}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={`${r.surface}_${r.itemId}`}
                onClick={() => onOpen(r)}
                className="border-b border-[var(--color-border)] last:border-0 cursor-pointer hover:bg-[var(--color-bg)]"
              >
                <td className="px-3 py-1.5">
                  <div className="w-[28px]">
                    <MediaTile
                      src={r.detection?.stored_path || r.detection?.image_url || r.coverUrl}
                      size="story"
                      alt={`${SURFACE_LABEL[r.surface]} van @${r.creatorHandle}`}
                    />
                  </div>
                </td>
                {cols.map((c) => {
                  const text = hitText(r, c.key)
                  const blank = text === '—'
                  return (
                    <td
                      key={c.key}
                      className={`px-3 py-1.5 whitespace-nowrap ${
                        c.numeric ? 'text-right tabular-nums' : 'text-left'
                      } ${blank ? 'text-[var(--color-ink-subtle)]' : ''}`}
                      title={blank && c.publishedBy
                        ? `${SURFACE_LABEL[r.surface]} publiceert dit niet`
                        : undefined}
                    >
                      {c.key === 'source'
                        ? <span className={r.source === 'roster'
                            ? 'text-[var(--color-good)]' : 'text-[var(--color-accent)]'}>{text}</span>
                        : text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Not small print. This is the paragraph that stops a reader concluding
          that 22 stories reached nobody, and it belongs next to the blanks it
          explains rather than in a footnote nobody scrolls to. */}
      <Card className="p-4 text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
        <span className="text-[var(--color-ink)]">Waarom staan er streepjes in de tabel?</span>{' '}
        Elk platform publiceert andere cijfers, en een streepje betekent
        &ldquo;dit vertelt het platform ons niet&rdquo; — niet &ldquo;nul&rdquo;.
        <ul className="mt-2 space-y-1">
          {legend.map((l) => (
            <li key={l.surface}>
              <span className="text-[var(--color-ink)]">{SURFACE_LABEL[l.surface]}</span>
              {l.has.length > 0
                ? <> geeft {l.has.join(', ')}</>
                : <> geeft geen enkel publiekscijfer</>}
              {l.missing.length > 0 && <> · geen {l.missing.join(', ')}</>}
              {l.surface === 'story' && (
                <span className="text-[var(--color-ink-subtle)]">
                  {' '}— Instagram toont story-kijkcijfers alleen aan de accounthouder zelf
                </span>
              )}
              {l.surface === 'post' && (
                <span className="text-[var(--color-ink-subtle)]">
                  {' '}— weergaven alleen bij een reel, nooit bij een fotopost
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[var(--color-ink-subtle)]">
          {fmtNum(rows.length)} treffers · gesorteerd op{' '}
          {cols.find((c) => c.key === sort.key)?.label.toLowerCase()}. Lege waarden staan
          altijd onderaan, ook bij oplopend sorteren — anders zouden de onmeetbare
          rijen bovenaan komen alsof ze het slechtst scoorden.
          {' '}Bron: {SOURCE_LABEL.roster} = geboekt, {SOURCE_LABEL.discovery} = kwam er vanzelf.
        </p>
      </Card>
    </div>
  )
}
