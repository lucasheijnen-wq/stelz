// Publiek: wie er rond deze campagne staat.
//
// THE QUESTION THIS TAB EXISTS FOR. A roster of 28 with 2,8M followers between
// them is a number that cannot tell you whether it reached 2,8M people or the
// same 80.000 people 28 times. Followers cannot answer it; comments can, and
// they arrive free with a post scrape. 2.040 people commented, 154 of them on
// more than one booked creator. That ratio is the finding.
//
// WHAT IS NOT HERE, AND WHY. No age, no gender, no city. Of 1.089 bios with
// text, exactly ONE states an age under the rule this codebase already has
// (communities.selfReportedAge). A demographic split built on anything looser
// is inferred from a number that happened to be in a bio, and it is exactly the
// kind of figure that gets repeated in a client meeting and then retracted.
//
// EVERY SECTION SAYS WHERE ITS NUMBERS CAME FROM. Comments are Instagram only —
// TikTok's payload carries a comments dataset URL that is null on every row we
// hold. Follower counts are TikTok only — Instagram returns none. Mixing the
// two under one heading would produce a figure describing neither platform.

import { Card } from '../ui'
import { Kpi } from './Kpi'
import {
  overlap, reachBands, leadShare, stelzShareOf,
  type Audience, type AccountStats,
} from '../../lib/audience'
import { compactNum, fmtDate, fmtNum } from '../../lib/format'

export function AudienceTab({ audience, eventId }: {
  audience: Audience | null; eventId?: string
}) {
  if (!audience) {
    return (
      <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)] leading-relaxed">
        Nog geen publiekslaag voor dit evenement.<br />
        <code className="text-[11px] bg-[var(--color-surface-2)] px-1.5 py-0.5 mt-2 inline-block">
          tools/stelz_brand_watch/76_audience.py --event {eventId ?? 'lowlands-2026'}
        </code>
        <p className="text-[11px] text-[var(--color-ink-subtle)] mt-3 max-w-lg mx-auto">
          Dat script doet geen enkele API-call: het leest de ruwe payloads die de
          harvesters al bewaarden en stelt er een andere vraag aan. Kosten: niets.
        </p>
      </Card>
    )
  }

  const ov = overlap(audience)
  // Not memoised: this sorts eight rows, and a useMemo below the early return
  // above would change the hook count the moment the fixture lands — which is
  // a crash, not a slow render.
  const bands = reachBands(audience)
  const { roster, discovery } = audience.accounts
  // Both groups, because the closing card speaks about every account on this tab.
  const bios = roster.withBio + discovery.withBio
  const ages = roster.withAge + discovery.withAge
  const nl = audience.context.languages.find((l) => l.label === 'nl')
  const nlShare = nl && audience.context.languagesKnownFor > 0
    ? (nl.count / audience.context.languagesKnownFor) * 100 : null

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label="Mensen die reageerden"
          value={fmtNum(ov.people)}
          sub={`${fmtNum(audience.commenters.comments)} reacties op ${fmtNum(audience.commenters.postsWithComments)} posts`}
        />
        <Kpi
          label="Gedeeld publiek"
          value={fmtNum(ov.shared)}
          sub={`${ov.pct.toFixed(1)}% reageerde op 2+ geboekte creators`}
        />
        <Kpi
          label="Festivalgangers"
          value={fmtNum(discovery.accounts)}
          sub={discovery.medianFollowers != null
            ? `mediaan ${compactNum(discovery.medianFollowers)} volgers op TikTok`
            : 'geen volgersaantallen'}
        />
        <Kpi
          label="Nederlandstalig"
          value={nlShare != null ? `${nlShare.toFixed(0)}%` : '—'}
          sub={`van ${fmtNum(audience.context.languagesKnownFor)} posts met een herkende taal`}
        />
      </div>

      {/* ── 1. Het gedeelde publiek ──────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          Kocht Stëlz 28 publieken, of één publiek 28 keer?
        </h2>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
          Volgersaantallen kunnen die vraag niet beantwoorden — opgeteld tellen ze
          dezelfde persoon net zo vaak mee als hij accounts volgt. Reacties wel: dit
          zijn {fmtNum(ov.people)} mensen die met naam en toenaam onder een post stonden.
          Het antwoord is <strong className="text-[var(--color-ink)]">overwegend
          verschillende publieken</strong>, met een kern van {fmtNum(ov.shared)} die
          meerdere creators volgt. Alleen Instagram: TikTok geeft zijn reacties niet mee
          bij de scrape die we doen.
        </p>

        <Card className="p-5">
          <div className="space-y-1.5">
            {bands.map((b) => {
              const pct = ov.people > 0 ? (b.people / ov.people) * 100 : 0
              return (
                <div key={b.reached} className="flex items-center gap-3 text-[12px]">
                  <span className="w-[130px] shrink-0 text-[var(--color-ink-muted)]">
                    {b.reached === 1 ? '1 creator' : `${b.reached} creators`}
                  </span>
                  <span className="flex-1 h-3 bg-[var(--color-border)] relative overflow-hidden">
                    <span
                      className={`absolute inset-y-0 left-0 ${
                        b.reached === 1 ? 'bg-[var(--color-ink-subtle)]' : 'bg-[var(--color-good)]'
                      }`}
                      style={{ width: `${Math.max(pct, 0.4)}%` }}
                    />
                  </span>
                  <span className="w-[110px] shrink-0 text-right tabular-nums text-[var(--color-ink-subtle)]">
                    {fmtNum(b.people)} · {pct.toFixed(1)}%
                  </span>
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-[var(--color-ink-subtle)] mt-4 leading-relaxed">
            De bovenste balk is de grijze meerderheid: mensen die op precies één creator
            reageerden. Die staat er expres bij — zonder die rij lijken de{' '}
            {fmtNum(ov.shared)} het hele verhaal, en ze zijn {ov.pct.toFixed(1)}% ervan.
          </p>
        </Card>

        <Card className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[640px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
                <th className="text-left font-normal px-4 py-2.5">Account</th>
                <th className="text-right font-normal px-3 py-2.5">Creators</th>
                <th className="text-right font-normal px-3 py-2.5" title="Hoeveel daarvan Stëlz betaalt">
                  Geboekt
                </th>
                <th className="text-right font-normal px-3 py-2.5">Reacties</th>
                <th className="text-left font-normal px-3 py-2.5">Op wie</th>
                <th className="text-right font-normal px-4 py-2.5">Laatst</th>
              </tr>
            </thead>
            <tbody>
              {audience.commenters.top.map((c) => (
                <tr key={c.handle} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap">@{c.handle}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.creators.length}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-good)]">
                    {c.rosterReached || '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.comments}</td>
                  <td className="px-3 py-2 text-[var(--color-ink-subtle)] max-w-[320px] truncate">
                    {c.creators.map((x) => `@${x}`).join(', ')}
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--color-ink-subtle)] whitespace-nowrap">
                    {fmtDate(c.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Listed listed={audience.commenters.listed} total={ov.people} noun="reageerders" />
      </section>

      {/* ── 2. Gekocht naast organisch ───────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          De geboekte creators naast de festivalgangers
        </h2>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
          Beide kolommen zijn TikTok, want dat is het enige platform hier dat een
          volgersaantal publiceert — Instagram geeft er geen enkele. Medianen, geen
          gemiddelden: één account van een miljoen tussen {fmtNum(discovery.accounts)}{' '}
          festivalgangers trekt een gemiddelde naar een getal dat niemand in die groep
          beschrijft.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AccountsCard title="Geboekt" tone="good" s={roster} />
          <AccountsCard title="Los gevonden" tone="accent" s={discovery} />
        </div>
      </section>

      {/* ── 3. Wie er getagd wordt ───────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          Wie er getagd wordt
        </h2>
        <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed max-w-3xl">
          {fmtNum(audience.tagged.accounts)} accounts werden in de posts van de roster
          getagd, samen {fmtNum(audience.tagged.tags)} keer. Daarvan staan er{' '}
          <strong className="text-[var(--color-ink)]">{fmtNum(audience.tagged.onRoster)}
          {' '}zelf op het roster</strong> — de creators taggen elkaar, en dat deel van
          het bereik gaat dus naar iemand die Stëlz al betaalt. De rest zijn de mensen die
          er fysiek bij waren.
        </p>
        <Card className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[560px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
                <th className="text-left font-normal px-4 py-2.5">Account</th>
                <th className="text-left font-normal px-3 py-2.5">Naam</th>
                <th className="text-right font-normal px-3 py-2.5">Getagd</th>
                <th className="text-left font-normal px-4 py-2.5">Door</th>
              </tr>
            </thead>
            <tbody>
              {audience.tagged.top.map((t) => (
                <tr key={t.handle} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap">
                    @{t.handle}
                    {t.onRoster && (
                      <span className="text-[10px] text-[var(--color-good)] ml-1.5">geboekt</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--color-ink-subtle)] truncate max-w-[180px]">
                    {t.fullName ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.times}</td>
                  <td className="px-4 py-2 text-[var(--color-ink-subtle)] truncate max-w-[280px]">
                    {t.taggedBy.map((x) => `@${x}`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Listed listed={audience.tagged.listed} total={audience.tagged.accounts} noun="getagde accounts" />
      </section>

      {/* ── 4. Waar dit publiek zit ──────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="stelz-display text-[18px] leading-none text-[var(--color-ink)]">
          Waar dit publiek zit
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <RankCard
            title="Taal"
            rows={audience.context.languages}
            knownFor={audience.context.languagesKnownFor}
            total={audience.context.languagePosts}
            note="Door TikTok zelf herkend aan het bijschrift. Instagram geeft geen taal mee."
          />
          <RankCard
            title="Sounds"
            rows={audience.context.sounds}
            knownFor={audience.context.soundsKnownFor}
            total={audience.context.languagePosts}
            note={`${fmtNum(audience.context.soundsDistinct)} verschillende sounds over deze posts. "Eigen geluid" is geen nummer maar de afwezigheid ervan — TikTok schrijft dat in de taal van de kijker, dus het stond hier zeven keer onder een andere naam.`}
          />
          <RankCard
            title="Locaties"
            rows={audience.context.places}
            knownFor={audience.context.placesKnownFor}
            total={audience.context.placePosts}
            note="Alleen waar iemand zelf een locatie aan de post hing — de meeste doen dat niet, dus dit is geen kaart van waar het publiek woont."
          />
        </div>
      </section>

      <Card className="p-4 text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
        <span className="text-[var(--color-ink)]">Geen leeftijd, geen geslacht, geen woonplaats.</span>{' '}
        Die staan niet in de data. Van de {fmtNum(bios)} accounts hierboven met tekst in
        hun bio {ages === 0 ? 'noemt er geen enkele een leeftijd'
          : ages === 1 ? 'noemt er precies één een leeftijd'
          : `noemen er ${fmtNum(ages)} een leeftijd`}{' '}
        volgens de regel die deze tool daarvoor al heeft — een leeftijd die iemand zélf
        opschreef. Alles daarbuiten zou geraden zijn uit een getal dat toevallig in een bio
        stond, en zo'n cijfer haalt wél een presentatie maar geen tweede blik.
        {' '}Deze hele laag kostte niets: de scrape bewaarde deze gegevens al.
      </Card>
    </div>
  )
}

function AccountsCard({ title, tone, s }: {
  title: string; tone: 'good' | 'accent'; s: AccountStats
}) {
  const share = stelzShareOf(s)
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between mb-4">
        <span className={`text-[11px] uppercase tracking-[0.14em] text-[var(--color-${tone})]`}>
          {title}
        </span>
        <span className="text-[12px] tabular-nums text-[var(--color-ink-subtle)]">
          {fmtNum(s.accounts)} accounts
        </span>
      </div>
      <dl className="space-y-2.5 text-[12px]">
        <Row label="Mediaan volgers" value={s.medianFollowers != null ? fmtNum(s.medianFollowers) : '—'} />
        <Row
          label="Samen"
          value={s.totalFollowers > 0 ? compactNum(s.totalFollowers) : '—'}
          sub={`over ${fmtNum(s.followersKnownFor)} van ${fmtNum(s.accounts)}`}
        />
        <Row label="Geverifieerd" value={s.verified > 0 ? fmtNum(s.verified) : '—'} />
        <Row
          label="Met Stëlz in beeld"
          value={s.withStelz > 0 ? fmtNum(s.withStelz) : '—'}
          sub={share != null ? `${share.toFixed(1)}% van deze groep` : undefined}
        />
      </dl>
    </Card>
  )
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="tabular-nums font-medium text-right">
        {value}
        {sub && <span className="block text-[10px] font-normal text-[var(--color-ink-subtle)]">{sub}</span>}
      </dd>
    </div>
  )
}

function RankCard({ title, rows, knownFor, total, note }: {
  title: string; rows: { label: string; count: number }[]
  /** Posts that carried this field at all — what the percentages divide by. */
  knownFor: number
  /** Posts that could have carried it. `knownFor` of `total` is the coverage. */
  total: number
  note: string
}) {
  const lead = leadShare(rows, knownFor)
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">
          {title}
        </span>
        {/* The denominator, always. A top-5 with no total behind it invites the
            reader to supply their own, and theirs is always more flattering. */}
        <span className="text-[10px] tabular-nums text-[var(--color-ink-subtle)]">
          {fmtNum(knownFor)} van {fmtNum(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--color-ink-muted)]">Niets meegegeven.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, 8).map((r) => (
            <li key={r.label} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="truncate">{r.label}</span>
              <span className="tabular-nums text-[var(--color-ink-subtle)] shrink-0">{fmtNum(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-[var(--color-ink-subtle)] mt-3 leading-relaxed">
        {lead != null && rows.length > 0 && (
          <>Grootste: {rows[0].label}, {lead.toFixed(0)}%. </>
        )}
        {note}
      </p>
    </Card>
  )
}

/** Says what was cut. A list that silently stops at 60 reads as "that is all
 *  of them", which is the difference between a ranking and a census. */
function Listed({ listed, total, noun }: { listed: number; total: number; noun: string }) {
  if (listed >= total) return null
  return (
    <p className="text-[11px] text-[var(--color-ink-subtle)]">
      De bovenste {fmtNum(listed)} van {fmtNum(total)} {noun} staan hier. De tellingen
      hierboven gaan over alle {fmtNum(total)}; alleen de lijst is ingekort.
    </p>
  )
}
