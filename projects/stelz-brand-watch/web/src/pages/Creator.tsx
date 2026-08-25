// Eén creator: wie het is, en elk stuk content waar Stëlz in beeld kwam.
//
// TWEE BRONNEN, ÉÉN PAGINA. De pagina las alleen Firestore, en de Cloud
// Functions staan niet uitgerold — dus elke link vanuit de creatortabel kwam
// uit op "geen detecties", ook voor iemand met vier posts. Er is nu een tweede
// tak die de evenement-fixture leest.
//
// DIE TAK REKENT NIETS ZELF UIT. Hij haalt joinCampaign en campaignRollup aan,
// precies zoals de evenementpagina, zodat het getal in deze kop en het getal in
// haar rij van de creatortabel niet uit elkaar kunnen lopen. Dat was ook geen
// vrije keuze: de detectierijen dragen géén cijfers — 0 van 2693 heeft een
// like- of weergavetelling — want die zitten allemaal aan de item-kant. Wie
// hier op DetectionRow.likes_count optelt, krijgt gegarandeerd nul.

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageShell, Card, Badge, Button, Avatar, CARD_GRID } from '../components/ui'
import { PRODUCT_LINE_LABEL } from '../lib/labels'
import { MediaTile } from '../components/MediaTile'
import { imageUrlFor, dedupeByPost, parentPostKey, type DetectionRow, type ResonanceRow } from '../lib/types'
import { fetchDetections, fetchResonanceForCreator, fetchCreatorProfile } from '../lib/data'
import { DetectionDrawer } from '../components/DetectionDrawer'
import { StoryDetail } from '../components/StoryDetail'
import { ContentCard } from '../components/campaign/ContentCard'
import { srsLayers, srsMode, srsHeadline, MODE_BLURB } from '../lib/srs'
import { sceneBreakdown } from '../lib/scenes'
import { ReadOnlyNotice } from '../lib/membership'
import { useEventCampaign } from '../lib/eventData'
import {
  joinCampaign, campaignRollup, SURFACE_LABEL, SURFACES,
  type CampaignRow,
} from '../lib/campaign'
import { followerIndex, groupHitsByPost, hitTotals, stelzHits } from '../lib/hits'
import { bookingFor, evidencedHandlesFor, formatWindow, matchEvent } from '../lib/events'
import { EVENTS } from '../data/events'
import { compactNum, fmtDate, fmtNum } from '../lib/format'
import { useResetOn } from '../lib/useResetOn'

export default function Creator() {
  const { handle = '' } = useParams()
  const h = handle.toLowerCase()
  const [rows, setRows] = useState<DetectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<DetectionRow | null>(null)
  const [openRow, setOpenRow] = useState<CampaignRow | null>(null)
  const [resonance, setResonance] = useState<ResonanceRow | null>(null)
  // Het creator-record: de enige actuele bron van een Instagram-volgersaantal,
  // bio en avatar. Detecties bevroren wat bekend was tijdens de detectie, en
  // het resonantie-doc is zo vers als de laatste SRS-run.
  const [profileRecord, setProfileRecord] = useState<{ followerCount: number | null; bio: string | null; avatarUrl: string | null; fullName: string | null } | null>(null)


  // Een andere creator betekent: het vorige antwoord is niet meer van
  // toepassing. Dat hoort in de render, niet in het effect — als effect stond
  // de nieuwe naam al boven de cijfers van de vorige, één frame lang.
  // De beginwaarden hierboven (loading = true, de rest leeg) dekken de eerste
  // render al; dit dekt elke wisseling daarna.
  useResetOn(handle, () => {
    setLoading(true)
    setResonance(null)
    setProfileRecord(null)
  })

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    fetchDetections({ creatorHandle: handle, limit: 300 })
      .then((det) => { if (!cancelled) { setRows(det); setLoading(false) } })
      .catch((e) => { if (!cancelled) { setError(e.message ?? String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [handle])

  // Resonantie is een aparte, optionele read: een creator mét detecties en
  // zónder SRS-doc is normaal (scoren is een eigen stap), dus een fout hier mag
  // de pagina niet meenemen in zijn val.
  useEffect(() => {
    if (!handle) return
    let cancelled = false
    fetchResonanceForCreator(handle)
      .then((r) => { if (!cancelled) setResonance(r) })
      .catch(() => { if (!cancelled) setResonance(null) })
    fetchCreatorProfile(handle)
      .then((p) => { if (!cancelled) setProfileRecord(p) })
      .catch(() => { if (!cancelled) setProfileRecord(null) })
    return () => { cancelled = true }
  }, [handle])

  // Staat deze persoon op een roster? Zo ja, dan is "plaatste niets" een
  // bevinding met een naam eraan, in plaats van een lege pagina.
  const booking = useMemo(() => bookingFor(h), [h])

  // Campagnerijen: preview in dev, de geïmporteerde Firestore-rijen in
  // productie (lib/eventData). Gekozen evenement: waar deze persoon geboekt
  // is, anders het eerste — met één evenement in de definitie dekt dat alles,
  // en een tweede evenement krijgt zijn eigen boeking.
  const campaignEventId = booking?.event.id ?? EVENTS[0]?.id ?? null
  const { items: campaignItems, detections: campaignDetections,
          preview: campaignPreview, loading: campaignLoading } =
    useEventCampaign(campaignEventId)

  // Alles wat deze persoon binnen een evenement plaatste. Op creatorHandle én
  // platformHandle, want bij een samenwerkingspost is de tweede het account van
  // de co-auteur en de eerste de geboekte creator — beide moeten hier uitkomen.
  const mine = useMemo(() => {
    if (!campaignItems) return [] as CampaignRow[]
    return joinCampaign(campaignItems, campaignDetections).filter((r) =>
      (r.creatorHandle ?? '').toLowerCase() === h
      || (r.platformHandle ?? '').toLowerCase() === h
      || (r.scrapedFor ?? '').toLowerCase() === h)
  }, [campaignItems, campaignDetections, h])

  // GESCHAALD OP HET EVENEMENT, door dezelfde matchEvent als de evenementpagina.
  // Zonder dit telde deze pagina ook wat er in juli stond: @lizebooij kwam hier
  // op 19 beelden uit tegen 6 in haar rij van de creatortabel, en twee schermen
  // die hetzelfde zouden moeten zeggen en dat niet doen zijn erger dan één
  // scherm dat er niet is. Wie nergens geboekt is, wordt tegen alle evenementen
  // gelegd — anders zou een los gevonden account leeg blijven.
  const eventRows = useMemo(() => {
    const events = booking ? [booking.event] : EVENTS
    const out: CampaignRow[] = []
    for (const ev of events) {
      // Bewijs over déze rijen is genoeg: evidencedHandlesFor kijkt per account,
      // en alle rijen van dit account zitten in `mine` — dezelfde uitkomst als
      // de evenementpagina die over alle rijen rekent.
      const evidenced = evidencedHandlesFor(ev, mine)
      for (const r of mine) {
        if (out.some((o) => o.itemId === r.itemId)) continue
        const m = matchEvent(ev, r, evidenced)
        if (m) out.push({ ...r, source: m.source, foundVia: r.foundVia ?? m.foundVia })
      }
    }
    return out
  }, [mine, booking])

  // Wat er buiten elk evenementvenster viel. Niet stilzwijgend weggelaten: het
  // is echte content van deze persoon, alleen niet van deze campagne.
  const outsideHits = useMemo(
    () => stelzHits(mine).length - stelzHits(eventRows).length,
    [mine, eventRows],
  )

  const fromEvent = eventRows.length > 0
  const eventHits = useMemo(() => stelzHits(eventRows), [eventRows])
  // Volgersaantallen uit ALLE rijen van deze persoon, niet alleen uit de
  // treffers — zie followerIndex. Een volgersaantal hangt niet af van welke
  // post je toevallig bekijkt.
  const totals = useMemo(
    () => hitTotals(eventHits, followerIndex(mine)), [eventHits, mine])
  const eventRollup = useMemo(() => campaignRollup(eventRows), [eventRows])

  const posts = useMemo(
    () => dedupeByPost(rows).filter((d) => d.detected === true && d.is_false_positive !== true),
    [rows],
  )

  // Detecties dragen een volgersaantal alleen als de scrape er toevallig een
  // teruggaf — Instagrams hashtag-endpoint doet dat niet. Neem wat we hebben.
  const followersFromPosts = useMemo(
    () => rows.reduce((mx, r) => Math.max(mx, r.follower_count ?? 0), 0),
    [rows],
  )
  const fromProfile = Math.max(
    followersFromPosts,
    resonance?.follower_count ?? 0,
    profileRecord?.followerCount ?? 0,
  )
  const followers = Math.max(fromProfile, totals.tiktokFollowers)
  // Zegt WELK publiek dit is. In de evenement-tak komt elk volgersaantal van
  // TikTok — Instagram geeft er in deze scrape geen enkele — en @lizebooij
  // "5.436 volgers" noemen terwijl dat haar TikTok-account @booijagency is,
  // is een precies verkeerd getal onder een precies verkeerd woord.
  const followersNote = followers === 0 ? null
    : fromProfile >= followers ? 'volgers' : 'TikTok-volgers'

  const profile = useMemo(() => {
    const withAuthor = rows.find((r) => r.extras?.author)
    const author = withAuthor?.extras?.author ?? null
    const platform = eventRows[0]?.platform ?? rows[0]?.platform ?? 'instagram'
    const avgConf = posts.length ? posts.reduce((s, r) => s + (r.confidence ?? 0), 0) / posts.length : 0
    const dates = posts.map((p) => p.posted_at).filter(Boolean).sort() as string[]
    const products = new Map<string, number>()
    for (const p of posts) if (p.product_line) products.set(p.product_line, (products.get(p.product_line) ?? 0) + 1)
    for (const r of eventHits) {
      const pl = r.detection?.product_line
      if (pl) products.set(pl, (products.get(pl) ?? 0) + 1)
    }
    const externalUrl = author?.profileUrl
      || (platform === 'tiktok' ? `https://www.tiktok.com/@${handle}` : `https://www.instagram.com/${handle}/`)
    return {
      platform,
      avatar: author?.avatar ?? null,
      bio: author?.signature ?? null,
      verifiedAccount: author?.verified ?? false,
      avgConf,
      firstSeen: dates[0] ?? null,
      lastSeen: dates[dates.length - 1] ?? null,
      products: [...products.entries()].sort((a, b) => b[1] - a[1]),
      externalUrl,
      videoCount: posts.filter((p) => p.frame_idx != null).length,
      imageCount: posts.filter((p) => p.frame_idx == null).length,
    }
  }, [rows, posts, eventRows, eventHits, handle])

  // The campaign rows load asynchronously too — without that term this page
  // told a client "@handle plaatste niets" for the half second between the
  // Firestore answer and the campaign rows landing. On a paid booking that
  // sentence is a finding; it may never render while the data is in flight.
  const nothingAnywhere = !loading && !campaignLoading && !fromEvent && posts.length === 0
  const fullName = profileRecord?.fullName ?? booking?.member.name ?? null

  return (
    <PageShell
      title={`@${handle}`}
      crumbs={[{ label: 'Overzicht', to: '/' }, { label: 'Creators', to: '/?tab=creators' }]}
      brandMark={false}
      subtitle={[
        profile.platform === 'tiktok' ? 'TikTok-creator' : 'Instagram-creator',
        booking ? `geboekt voor ${booking.event.name}` : null,
      ].filter(Boolean).join(' · ')}
      actions={
        <a href={profile.externalUrl} target="_blank" rel="noreferrer">
          <Button variant="secondary" size="sm">Profiel openen ↗</Button>
        </a>
      }
    >
      <ReadOnlyNotice />

      {/* Only when the rows really come from the local fixture — in production
          the same hook serves the imported Firestore rows, and this banner
          would then be claiming a scrape that never ran on that machine. */}
      {fromEvent && campaignPreview && (
        <Card className="mb-4 px-4 py-2.5 text-[12px] text-[var(--color-warn)]">
          Lokale data: rechtstreeks van de laatste scrape op deze computer, nog niet
          uit de online database.
        </Card>
      )}

      {loading && !fromEvent && (
        <div className="text-[14px] text-[var(--color-ink-muted)] py-16 text-center">Laden…</div>
      )}
      {error && !fromEvent && (
        <div className="text-[13px] text-[var(--color-bad)] py-16 text-center">{error}</div>
      )}

      {nothingAnywhere && (
        <Card className="p-10 text-center">
          {booking ? (
            <>
              <p className="text-[14px] text-[var(--color-ink)]">
                @{handle} staat op het roster van {booking.event.name} en plaatste niets.
              </p>
              <p className="text-[12px] text-[var(--color-ink-muted)] mt-2 leading-relaxed max-w-lg mx-auto">
                Het venster liep {formatWindow(booking.event)}. Dit is geen lege pagina bij gebrek
                aan data — er is gezocht op {booking.member.instagram ? `@${booking.member.instagram}` : 'het account'}
                {booking.member.tiktok ? ` en @${booking.member.tiktok}` : ''} en er kwam niets terug.
                Bij een betaalde boeking is dat de bevinding.
              </p>
            </>
          ) : (
            <p className="text-[14px] text-[var(--color-ink-muted)]">
              Geen bevestigde detecties voor @{handle}.
            </p>
          )}
        </Card>
      )}

      {/* ─── De evenement-tak ────────────────────────────────────────── */}
      {fromEvent && (
        <div className="space-y-10">
          <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6">
            <IdentityCard
              handle={handle} fullName={fullName} platform={profile.platform}
              followers={followers} followersNote={followersNote}
              avatar={profileRecord?.avatarUrl ?? profile.avatar}
              bio={profileRecord?.bio ?? profile.bio} verified={profile.verifiedAccount}
              products={profile.products} booking={booking}
            />

            {/* Per vlak, nooit opgeteld. Een TikTok-afspeling en een IG-like
                zijn niet hetzelfde en een "totaal bereik" over de twee zegt
                niets — zie lib/campaign.ts. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[var(--color-border)] border border-[var(--color-border)] self-start">
              <CreatorKpi
                label="Met Stëlz"
                value={fmtNum(totals.posts)}
                sub={`${fmtNum(totals.hits)} beelden · uit ${fmtNum(eventRollup.judged)} bekeken`}
              />
              <CreatorKpi
                label="TikTok-weergaven"
                value={totals.tiktokVideos > 0 ? compactNum(totals.tiktokViews) : '—'}
                sub={totals.tiktokVideos > 0
                  ? `over ${fmtNum(totals.tiktokVideos)} video's met Stëlz`
                  : 'geen TikToks met Stëlz'}
              />
              <CreatorKpi
                label="IG-likes"
                value={totals.likedPosts > 0 ? compactNum(totals.postLikes) : '—'}
                sub={totals.likedPosts > 0
                  ? `over ${fmtNum(totals.likedPosts)} posts`
                  : 'geen posts met Stëlz'}
              />
              {SURFACES.map((s) => (
                <CreatorKpi
                  key={s}
                  label={SURFACE_LABEL[s]}
                  value={fmtNum(eventRollup.bySurface[s].posts || eventRollup.bySurface[s].items)}
                  sub={eventRollup.bySurface[s].withStelz > 0
                    ? `${fmtNum(eventRollup.bySurface[s].withStelz)} met Stëlz`
                    : 'niets met Stëlz'}
                />
              ))}
            </div>
          </div>

          <section className="space-y-5">
            <header className="border-b-2 border-[var(--color-ink)] pb-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)] font-medium mb-2">
                Content
              </div>
              <h2 className="stelz-display text-[22px] lg:text-[26px] leading-none text-[var(--color-ink)]">
                Waar Stëlz in beeld komt
              </h2>
              <p className="text-[11px] text-[var(--color-ink-subtle)] mt-2 leading-relaxed">
                {fmtNum(eventHits.length)} van {fmtNum(eventRollup.items)} beelden
                {booking && <>, binnen {formatWindow(booking.event)}</>}.
                {totals.storyHits > 0 && (
                  <> Stories dragen geen kijkcijfers — Instagram geeft die alleen aan het
                    account zelf.</>
                )}
                {/* Niet stilzwijgend weglaten. Het is echte content van deze
                    persoon, alleen niet van deze campagne — en zonder deze zin
                    lijkt het alsof de tool haar posts gemist heeft. */}
                {outsideHits > 0 && (
                  <> Daarbuiten {outsideHits === 1 ? 'staat nog 1 beeld' : `staan nog ${fmtNum(outsideHits)} beelden`}{' '}
                    met Stëlz erop, van vóór of ná deze periode — die tellen niet mee in
                    de campagnecijfers.</>
                )}
              </p>
            </header>
            {eventHits.length === 0 ? (
              <Card className="p-10 text-center text-[13px] text-[var(--color-ink-muted)]">
                @{handle} plaatste {fmtNum(eventRollup.items)} beelden binnen het venster,
                maar Stëlz stond op geen daarvan in beeld.
              </Card>
            ) : (
              <div className="flex flex-wrap gap-2">
                {groupHitsByPost(eventHits).map(({ row: r, moreSlides }) => (
                  <ContentCard
                    key={`${r.surface}_${r.itemId}`}
                    row={r}
                    moreSlides={moreSlides}
                    showTag={r.source === 'discovery'}
                    onOpen={() => setOpenRow(r)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ─── De Firestore-tak, ongewijzigd ───────────────────────────── */}
      {!fromEvent && !loading && posts.length > 0 && (
        <div className="space-y-10">
          <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6">
            <IdentityCard
              handle={handle} fullName={fullName} platform={profile.platform}
              followers={followers} followersNote={followersNote}
              avatar={profileRecord?.avatarUrl ?? profile.avatar}
              bio={profileRecord?.bio ?? profile.bio} verified={profile.verifiedAccount}
              products={profile.products} booking={booking}
              firstSeen={profile.firstSeen} lastSeen={profile.lastSeen}
            />

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[var(--color-border)] border border-[var(--color-border)] self-start">
              <CreatorKpi label="Vermeldingen" value={fmtNum(posts.length)} sub="unieke posts" />
              <CreatorKpi label="Video's" value={fmtNum(profile.videoCount)} sub={`${fmtNum(profile.imageCount)} beelden`} />
              <CreatorKpi label="Gem. zekerheid" value={`${(profile.avgConf * 100).toFixed(0)}%`} sub="over de treffers" />
              <CreatorKpi
                label={followersNote === 'TikTok-volgers' ? 'TikTok-volgers' : 'Volgers'}
                value={followers > 0 ? fmtNum(followers) : '—'}
                sub={followers > 0
                  ? (profile.platform === 'tiktok' ? 'TikTok' : 'Instagram')
                  : 'niet meegegeven door de scrape'}
              />
            </div>
          </div>

          <WhyTheyMatter resonance={resonance} posts={posts} followers={followers} />

          <section className="space-y-5">
            <header className="border-b-2 border-[var(--color-ink)] pb-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)] font-medium mb-2">
                Content
              </div>
              <h2 className="stelz-display text-[22px] lg:text-[26px] leading-none text-[var(--color-ink)]">
                Waar Stëlz in beeld komt
              </h2>
            </header>

            <div className={CARD_GRID}>
              {posts.map((d) => {
                const conf = (d.confidence ?? 0) * 100
                return (
                  <button
                    key={d.detection_id}
                    onClick={() => setActive(d)}
                    className="text-left bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-colors flex flex-col"
                  >
                    <MediaTile src={imageUrlFor(d)} size="card">
                      {d.frame_idx != null && (
                        <span className="absolute bottom-2 right-2 text-[10px] bg-[var(--color-ink)]/80 text-white px-2 py-0.5">
                          ▶ video{(d.frame_hits ?? 0) > 1 ? ` · ${d.frame_hits} beelden` : ''}
                        </span>
                      )}
                      {d.verified === true && (
                        <span className="absolute top-2 left-2 text-[10px] uppercase tracking-widest bg-[var(--color-good)] text-white px-2 py-0.5">✓</span>
                      )}
                    </MediaTile>
                    <div className="p-3 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-[var(--color-ink-muted)] truncate">
                          {d.product_line ? (PRODUCT_LINE_LABEL[d.product_line] ?? d.product_line) : 'Detectie'}
                          {d.surface_type ? ` · ${d.surface_type.replace(/_/g, ' ')}` : ''}
                        </span>
                        <span className={`text-[12px] tabular-nums font-medium shrink-0 ${conf >= 85 ? 'text-[var(--color-good)]' : conf >= 75 ? 'text-[var(--color-warn)]' : 'text-[var(--color-bad)]'}`}>
                          {conf.toFixed(0)}%
                        </span>
                      </div>
                      {d.post_caption && (
                        <p className="text-[11px] text-[var(--color-ink-subtle)] line-clamp-1">{d.post_caption}</p>
                      )}
                      <div className="flex items-center justify-between text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
                        <span>
                          {(d.likes_count ?? 0) > 0 && `♥ ${fmtNum(d.likes_count)}`}
                          {(d.views_count ?? 0) > 0 && `  ▶ ${fmtNum(d.views_count)}`}
                        </span>
                        <span>{fmtDate(d.posted_at)}</span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      )}

      <DetectionDrawer
        detection={active}
        similar={active ? posts.filter((d) => d.detection_id !== active.detection_id).slice(0, 8) : []}
        frames={active ? rows
          .filter((d) => d.detected === true && parentPostKey(d) === parentPostKey(active))
          .sort((a, b) => (a.frame_idx ?? 0) - (b.frame_idx ?? 0)) : []}
        onClose={() => setActive(null)}
      />
      <StoryDetail
        row={openRow ? { ...openRow, surfaceLabel: SURFACE_LABEL[openRow.surface] } : null}
        onClose={() => setOpenRow(null)}
      />
    </PageShell>
  )
}

/** Wie het is. Gedeeld door beide takken, zodat een creator er hetzelfde
 *  uitziet of het cijfer nu uit Firestore of uit een evenement komt. */
function IdentityCard({
  handle, fullName, platform, followers, followersNote, avatar, bio, verified,
  products, booking, firstSeen, lastSeen,
}: {
  handle: string
  fullName: string | null
  platform: string
  followers: number
  avatar: string | null
  bio: string | null
  verified: boolean
  /** Welk publiek dit getal beschrijft — "volgers" of "TikTok-volgers". Zonder
   *  dit woord staat er een TikTok-cijfer onder een Instagram-profiel. */
  followersNote: string | null
  products: [string, number][]
  booking: { event: { id: string; name: string }; member: { name: string } } | null
  firstSeen?: string | null
  lastSeen?: string | null
}) {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-4 mb-5">
        <div className="w-20 h-20 rounded-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
          <Avatar src={avatar} handle={handle} className="w-full h-full text-[24px]" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-[17px] font-medium truncate">@{handle}</div>
            {verified && <span className="text-[var(--color-accent)]" title="Geverifieerd account">✓</span>}
          </div>
          {fullName && (
            <div className="text-[12px] text-[var(--color-ink-muted)] truncate">{fullName}</div>
          )}
          <div className="text-[12px] text-[var(--color-ink-subtle)] mt-0.5">
            {platform === 'tiktok' ? 'TikTok' : 'Instagram'}
            {followers > 0
              ? ` · ${fmtNum(followers)} ${followersNote ?? 'volgers'}`
              : ' · volgersaantal niet meegegeven door de scrape'}
          </div>
        </div>
      </div>

      {bio && (
        <p className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed whitespace-pre-line mb-5 border-b border-[var(--color-border)] pb-5">
          {bio}
        </p>
      )}

      <div className="space-y-2.5 text-[12px]">
        {booking && (
          <div>
            <Badge tone="accent">Geboekt · {booking.event.name}</Badge>
          </div>
        )}
        {products.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {products.map(([p, n]) => (
              <Badge key={p} tone="muted">{PRODUCT_LINE_LABEL[p] ?? p} ×{n}</Badge>
            ))}
          </div>
        )}
        {(firstSeen || lastSeen) && (
          <div className="text-[var(--color-ink-subtle)] tabular-nums pt-1">
            {firstSeen && <>Eerst gezien {fmtDate(firstSeen)}</>}
            {lastSeen && lastSeen !== firstSeen && <> · laatst {fmtDate(lastSeen)}</>}
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * "Waarom doet deze persoon ertoe": de SRS-opbouw links, het publieksprofiel
 * rechts.
 *
 * Een volgersaantal alleen kan die vraag niet beantwoorden — het scheidt iemand
 * met bereik niet van iemand die echt in de scene zit waar het merk leeft. De
 * SRS-lagen kunnen dat wél, en dat is de hele reden dat de score bestaat; hij
 * werd alleen nergens getekend (fetchResonanceForCreator stond ongebruikt).
 */
function WhyTheyMatter({
  resonance, posts, followers,
}: { resonance: ResonanceRow | null; posts: DetectionRow[]; followers: number }) {
  const scenes = useMemo(() => sceneBreakdown(posts).filter((s) => s.key !== 'other').slice(0, 3), [posts])
  const engagement = useMemo(() => {
    // Likes per post afgezet tegen het volgersaantal. Alleen zinvol met allebei,
    // en alleen over posts die daadwerkelijk een like-telling dragen.
    const withLikes = posts.filter((p) => (p.likes_count ?? 0) > 0)
    if (!withLikes.length || followers <= 0) return null
    const avgLikes = withLikes.reduce((s, p) => s + (p.likes_count ?? 0), 0) / withLikes.length
    return { avgLikes, rate: (avgLikes / followers) * 100 }
  }, [posts, followers])

  const layers = resonance ? srsLayers(resonance) : []
  const headline = resonance ? srsHeadline(resonance) : null
  const mode = resonance ? srsMode(resonance) : null

  return (
    <section className="space-y-5">
      <header className="border-b-2 border-[var(--color-ink)] pb-4">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)] font-medium mb-2">Publiek</div>
        <h2 className="stelz-display text-[22px] lg:text-[26px] leading-none text-[var(--color-ink)]">
          Waarom deze creator ertoe doet
        </h2>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          {!resonance ? (
            <div className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
              Nog geen resonantiescore voor @{posts[0]?.creator_handle}. Scoren is een
              aparte stap na een scan, dus creators uit de laatste run verschijnen hier later.
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-3 mb-1">
                <span className="stelz-display text-[34px] leading-none tabular-nums text-[var(--color-ink)]">
                  {Math.round(resonance.srs)}
                </span>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">
                  Resonantie
                </span>
              </div>
              {headline && (
                <p className="text-[13px] font-medium text-[var(--color-ink)] mb-1">{headline}</p>
              )}
              {mode && (
                <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed mb-5">
                  {MODE_BLURB[mode]}
                </p>
              )}

              <ul className="space-y-3">
                {layers.map((l) => (
                  <li key={l.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] font-medium" title={l.meaning}>{l.label}</span>
                      <span className="text-[11px] tabular-nums text-[var(--color-ink-subtle)] shrink-0">
                        {/* Een lege laag zegt "niet berekend" en mag niet als
                            nulbalk getekend worden — dat betekent het omgekeerde. */}
                        {l.value == null ? 'niet gescoord' : `${Math.round(l.value * 100)}`}
                        <span className="text-[var(--color-ink-subtle)]"> · {l.weight}% gewicht</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 bg-[var(--color-border)] relative overflow-hidden">
                      {l.value != null && (
                        <span
                          className="absolute inset-y-0 left-0 bg-[var(--color-ink)]"
                          style={{ width: `${Math.round(Math.max(0, Math.min(1, l.value)) * 100)}%` }}
                        />
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">{l.meaning}</p>
                  </li>
                ))}
              </ul>

              <p className="mt-5 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
                Gewichten hangen af van hoeveel bevestigde data het merk heeft, dus scores zijn
                onderling vergelijkbaar maar niet tussen merken in verschillende fases.
              </p>
            </>
          )}
        </Card>

        <Card className="p-6">
          <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)] mb-4">
            Publieksprofiel
          </div>

          <dl className="space-y-3 text-[12px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Volgers</dt>
              <dd className="tabular-nums font-medium">
                {followers > 0 ? fmtNum(followers) : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Gem. likes op merkposts</dt>
              <dd className="tabular-nums font-medium">
                {engagement ? fmtNum(engagement.avgLikes) : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Interactiepercentage</dt>
              <dd className="tabular-nums font-medium">
                {engagement ? `${engagement.rate.toFixed(1)}%` : '—'}
              </dd>
            </div>
            {resonance?.tier && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--color-ink-muted)]">Tier</dt>
                <dd className="font-medium">{resonance.tier.replace('_', ' ')}</dd>
              </div>
            )}
            {resonance?.category && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--color-ink-muted)]">Categorie</dt>
                <dd className="font-medium capitalize">{resonance.category}</dd>
              </div>
            )}
          </dl>

          <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)] mb-2.5">
              Waar ze over posten
            </div>
            {scenes.length === 0 ? (
              <p className="text-[12px] text-[var(--color-ink-muted)]">
                Te weinig sceneinformatie op deze posts om ze te plaatsen.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {scenes.map((s) => (
                  <li key={s.key} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span>{s.label}</span>
                    <span className="tabular-nums text-[var(--color-ink-subtle)] shrink-0">
                      {s.total} {s.total === 1 ? 'post' : 'posts'}
                      {s.untagged > 0 ? ` · ${s.untagged} zonder tag` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </section>
  )
}

function CreatorKpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-5 flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">{label}</div>
      <div className="stelz-display text-[26px] tabular-nums leading-none text-[var(--color-ink)]">{value}</div>
      <div className="text-[11px] text-[var(--color-ink-muted)]">{sub}</div>
    </div>
  )
}
