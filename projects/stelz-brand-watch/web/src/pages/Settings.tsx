// Settings — user-friendly, section-grouped. All the backend calls are the
// same as before; the change is purely UX: friendlier copy, progressive
// disclosure for the technical dials, cleaner hierarchy.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { activeReferenceIds, REFERENCE_SLOTS } from '../lib/refselect'
import {
  PageShell, Card, Button, Badge, Field, Input, Textarea,
} from '../components/ui'
import { MediaTile } from '../components/MediaTile'
import {
  fbListReferenceImages,
  fbUploadReferenceImage,
  fbDeleteReferenceImage,
  fbGetBrand,
  fbUpdateBrandSettings,
  fbListHashtagPool,
  fbRecomputeCentroid,
  fbStepSentiment,
  fbStepProfiles,
  fbListMembers,
  fbAddMember,
  fbRemoveMember,
  type BrandMember,
  type ReferenceImage,
  type BrandDoc,
  type HashtagPoolEntry,
} from '../lib/firestore'
import { ReadOnlyNotice } from '../lib/membership'
import { useMembership } from '../lib/membershipContext'
import { useResetOn } from '../lib/useResetOn'

type SectionId = 'brand' | 'detector' | 'hashtags' | 'access' | 'maintenance' | 'advanced' | 'danger'

/**
 * Settings is a stack of seven independent panels, and it was rendered as one
 * continuous page. That made the whole thing as long as its longest part — the
 * hashtag pool alone runs to a hundred-odd rows — so everything below it was
 * effectively invisible, and finding anything meant scrolling past a wall of
 * tags.
 *
 * A left rail fixes that without hiding anything behind a modal. Each panel
 * keeps its own heading and copy, so a linked screenshot still makes sense on
 * its own, and only the selected panel mounts — which also means the hashtag
 * pool stops fetching on every visit to Settings.
 */
const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
  { id: 'brand', label: 'Brand', hint: 'Name and website' },
  { id: 'detector', label: 'Detector', hint: 'Reference images, identity' },
  { id: 'hashtags', label: 'Hashtags', hint: 'What we scan' },
  { id: 'access', label: 'Access', hint: 'Who can change things' },
  { id: 'maintenance', label: 'Maintenance', hint: 'Manual steps' },
  { id: 'advanced', label: 'Advanced', hint: 'Thresholds, budget' },
  { id: 'danger', label: 'Danger zone', hint: 'Export, delete' },
]

export default function Settings() {
  // The section lives in the URL hash so a link to a specific panel works —
  // "check Settings#access" is a sentence people actually say.
  const [active, setActive] = useState<SectionId>(() => {
    const fromHash = window.location.hash.replace('#', '') as SectionId
    return SECTIONS.some((s) => s.id === fromHash) ? fromHash : 'brand'
  })

  function go(id: SectionId) {
    setActive(id)
    window.history.replaceState(null, '', `#${id}`)
  }

  return (
    <PageShell title="Settings" subtitle="Stëlz Community Watch">
      <ReadOnlyNotice />

      <div className="grid grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)] gap-8 lg:gap-10">
        {/* Rail. On narrow screens it becomes a horizontal strip rather than
            eating a third of the viewport. */}
        <nav
          className="lg:sticky lg:top-6 self-start -mx-1 lg:mx-0 overflow-x-auto lg:overflow-visible"
          aria-label="Settings sections"
        >
          <ul className="flex lg:flex-col gap-1 lg:gap-0 min-w-max lg:min-w-0">
            {SECTIONS.map((sec) => {
              const on = sec.id === active
              return (
                <li key={sec.id}>
                  <button
                    onClick={() => go(sec.id)}
                    aria-current={on ? 'page' : undefined}
                    className={`w-full text-left px-3 py-2.5 border-l-2 transition-colors whitespace-nowrap lg:whitespace-normal ${
                      on
                        ? 'border-[var(--color-accent)] bg-[var(--color-bg)] text-[var(--color-ink)]'
                        : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    <span className={`block text-[13px] ${on ? 'font-medium' : ''}`}>{sec.label}</span>
                    <span className="hidden lg:block text-[11px] text-[var(--color-ink-subtle)] mt-0.5">
                      {sec.hint}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {active === 'brand' && <BrandProfileSection />}
          {active === 'detector' && <TrainingSection />}
          {active === 'hashtags' && <HashtagPoolSection />}
          {active === 'access' && <TeamSection />}
          {active === 'maintenance' && <MaintenanceSection />}
          {active === 'advanced' && <AdvancedSection />}
          {active === 'danger' && <DangerSection />}
        </div>
      </div>
    </PageShell>
  )
}

// ─── Shared shell ────────────────────────────────────────────────────

function SectionShell({
  eyebrow, title, hint, action, children,
}: {
  eyebrow: string
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-6 border-b-2 border-[var(--color-ink)] pb-4">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)] font-medium mb-2">{eyebrow}</div>
          <h2 className="stelz-display text-[22px] lg:text-[26px] leading-none text-[var(--color-ink)]">{title}</h2>
          {hint && <p className="text-[13px] text-[var(--color-ink-muted)] mt-2 leading-relaxed max-w-[560px]">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  )
}

function SavedInline({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-ink-muted)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-good)]" />
      {msg}
    </span>
  )
}

function ErrorInline({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <div className="text-[12px] text-[var(--color-bad)] border border-[var(--color-bad)] px-3 py-2 leading-relaxed">
      {msg}
    </div>
  )
}

// ─── 1. Brand ────────────────────────────────────────────────────────

function BrandProfileSection() {
  const { canWrite } = useMembership()
  const [brand, setBrand] = useState<BrandDoc | null>(null)
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fbGetBrand().then((b) => {
      setBrand(b); setName(b?.name ?? ''); setWebsite(b?.website ?? '')
    })
  }, [])

  async function save() {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await fbUpdateBrandSettings({ name, website })
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2500)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  if (!brand) return null
  return (
    <SectionShell
      eyebrow="Brand"
      title="Your brand's profile"
      hint="Public-facing name and website. Used across the dashboard and in outreach templates."
    >
      <Card className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Field label="Brand name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stelz" />
          </Field>
          <Field label="Website">
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://drinkstelz.com" />
          </Field>
        </div>
        <ErrorInline msg={err} />
        <div className="flex items-center gap-3 pt-2">
          <Button variant="primary" size="sm" disabled={busy || !canWrite} onClick={save}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          <SavedInline msg={msg} />
        </div>
      </Card>
    </SectionShell>
  )
}

// ─── 2. Training the detector (identity + wordmarks + reference images) ──

function TrainingSection() {
  const [identity, setIdentity] = useState('')
  const [wordmarks, setWordmarks] = useState('')
  const [items, setItems] = useState<ReferenceImage[]>([])
  // Which of these the detector is actually shown — see lib/refselect.ts.
  const activeIds = useMemo(() => activeReferenceIds(items), [items])
  const [loadingRefs, setLoadingRefs] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [centroidBusy, setCentroidBusy] = useState(false)
  const [savingIdentity, setSavingIdentity] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [centroidComputedAt, setCentroidComputedAt] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { canWrite } = useMembership()

  // De fetch staat in het effect; wie verse gegevens wil, bumpt `reloadKey`.
  // Als losse functie die het mount-effect aanriep was dit precies wat
  // react-hooks/set-state-in-effect afvangt. En het levert annulering op, die
  // er niet was: wie tijdens het laden wegnavigeert kreeg nog een setState.
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = () => { setLoadingRefs(true); setReloadKey((k) => k + 1) }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [list, brand] = await Promise.all([fbListReferenceImages(), fbGetBrand()])
        if (cancelled) return
        setItems(list)
        setIdentity(brand?.visualIdentity ?? '')
        setWordmarks((brand?.wordmarkAliases ?? []).join(', '))
        setCentroidComputedAt(brand?.visualCentroidComputedAt ?? null)
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
      finally { if (!cancelled) setLoadingRefs(false) }
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  async function saveIdentity() {
    setSavingIdentity(true); setMsg(null); setErr(null)
    try {
      const aliases = wordmarks.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      await fbUpdateBrandSettings({ visualIdentity: identity, wordmarkAliases: aliases })
      setMsg('Identity saved. Next scan will use it.')
      setTimeout(() => setMsg(null), 3000)
    } catch (e) { setErr((e as Error).message) }
    finally { setSavingIdentity(false) }
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true); setErr(null); setMsg(null)
    try {
      const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
      for (const f of arr) {
        if (f.size > 8 * 1024 * 1024) { setErr(`${f.name} is over 8 MB — skipped`); continue }
        await fbUploadReferenceImage(f)
      }
      refresh()
      setMsg(`Uploaded ${arr.length} image${arr.length === 1 ? '' : 's'}. Recomputing detection profile…`)
      void autoRecompute()
    } catch (e) { setErr((e as Error).message) }
    finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function onDelete(item: ReferenceImage) {
    if (!confirm('Remove this reference image?')) return
    setUploading(true); setErr(null)
    try {
      await fbDeleteReferenceImage(item.id, item.storagePath)
      refresh()
      void autoRecompute()
    } catch (e) { setErr((e as Error).message) }
    finally { setUploading(false) }
  }

  async function autoRecompute() {
    setCentroidBusy(true)
    try {
      const r = await fbRecomputeCentroid()
      if (r.computed) setMsg(`Detection profile updated · using ${r.refsUsed} of ${r.refsFound} images.`)
      else if ((r.refsFound ?? 0) === 0) setMsg('Upload at least one reference image to enable the visual filter.')
      else if ((r.fetchErrors ?? []).length > 0) setErr(`Couldn't process ${r.fetchErrors.length} of ${r.refsFound} images. First error: ${r.fetchErrors[0]}`)
      else setErr("Reference images uploaded but couldn't be processed. Try re-uploading.")
      refresh()
    } catch (e) { setErr(`Auto-refresh failed: ${(e as Error).message}`) }
    finally { setCentroidBusy(false) }
  }

  return (
    <SectionShell
      eyebrow="Detection"
      title="Teach the AI what to look for"
      hint="Describe your brand's look, add exact spellings to catch by text, and drop in a few product photos. The more it sees, the smarter it gets."
    >
      <div className="space-y-6">
        {/* Reference images — first because it's the highest signal */}
        <Card className="p-6">
          <SubHeader
            step="Product photos"
            title="Reference images"
            desc="Clean product shots at different angles and lighting work best. Every image here is shown to the AI as “this IS the product”, so a photo containing another brand's can teaches it wrong — there is no way to mark an image as a counter-example."
            trailing={items.length > 0 ? (
              <span className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
                {items.length} image{items.length === 1 ? '' : 's'}
              </span>
            ) : null}
          />

          {canWrite ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files) }}
              className={`border border-dashed py-10 px-6 text-center transition-colors ${dragOver ? 'border-[var(--color-ink)] bg-[var(--color-bg)]' : 'border-[var(--color-border-strong)]'}`}
            >
              <div className="text-[13px] font-medium text-[var(--color-ink)] mb-1.5">Drop images here</div>
              <div className="text-[12px] text-[var(--color-ink-muted)] mb-4">or</div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && uploadFiles(e.target.files)}
              />
              <Button size="sm" variant="primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading…' : 'Choose files'}
              </Button>
            </div>
          ) : (
            <div className="border border-dashed border-[var(--color-border-strong)] py-8 px-6 text-center text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
              These are what the AI is taught to recognise. Editing them is
              restricted — note anything that looks wrong and pass it on rather
              than removing it.
            </div>
          )}

          {(msg || err) && (
            <div className="mt-4 space-y-2">
              {err && <ErrorInline msg={err} />}
              {msg && !err && (
                <div className="text-[12px] text-[var(--color-ink-muted)] border border-[var(--color-border)] px-3 py-2 leading-relaxed">
                  {msg}
                </div>
              )}
            </div>
          )}

          {centroidComputedAt && !centroidBusy && (
            <div className="mt-4 flex items-center justify-between text-[11px] text-[var(--color-ink-subtle)]">
              <span>Detection profile updated {new Date(centroidComputedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>
          )}
          {centroidBusy && (
            <div className="mt-4 text-[11px] text-[var(--color-ink-muted)]">Rebuilding detection profile…</div>
          )}

          {loadingRefs && <div className="mt-6 text-[12px] text-[var(--color-ink-muted)] text-center">Loading…</div>}
          {!loadingRefs && items.length > 0 && (
            <>
              {/* Which images are actually in play. The detector is sent 8, chosen
                  newest-first with one slot reserved per product line — so with
                  more than 8 uploads, some are dead weight and an operator hunting
                  a bad reference could delete one the model never sees. See
                  lib/refselect.ts, which mirrors refs.py _select_reference_docs. */}
              <p className="mt-6 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
                {items.length > REFERENCE_SLOTS ? (
                  <>
                    The detector is shown <strong className="text-[var(--color-ink)]">{REFERENCE_SLOTS} of these {items.length}</strong>{' '}
                    — newest first, with one slot kept for each product line. The dimmed ones
                    are stored but never sent. If a detection keeps confusing another brand's
                    can for yours, check the {REFERENCE_SLOTS} highlighted here first.
                  </>
                ) : (
                  <>All {items.length} of these are shown to the detector on every scan.</>
                )}
              </p>
              <div className="mt-3 grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-px bg-[var(--color-border)] border border-[var(--color-border)]">
              {items.map((it) => (
                <div
                  key={it.id}
                  className={`bg-[var(--color-surface)] p-1.5 relative group ${activeIds.has(it.id) ? '' : 'opacity-40'}`}
                  title={activeIds.has(it.id) ? 'Sent to the detector' : 'Stored, but not sent — the detector only takes 8'}
                >
                  <MediaTile src={it.url} size="thumb" />
                  {activeIds.has(it.id) && (
                    <span className="absolute bottom-2 left-2 text-[9px] uppercase tracking-widest bg-[var(--color-ink)]/80 text-white px-1.5 py-0.5">
                      in use
                    </span>
                  )}
                  {canWrite && (
                    <button
                      onClick={() => onDelete(it)}
                      disabled={uploading}
                      className="absolute top-2 right-2 w-5 h-5 bg-[var(--color-surface)] border border-[var(--color-border-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-bad)] hover:border-[var(--color-bad)] flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove image"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              </div>
            </>
          )}
        </Card>

        {/* Brand name spellings (OCR wordmarks) */}
        <Card className="p-6 space-y-5">
          <SubHeader
            step="Brand names"
            title="Spellings we catch on sight"
            desc="Every way your brand can be written (accents, common misspellings). If we read one of these on a can, shirt, or sign, it's an instant match."
          />
          <Field label="">
            <Input
              value={wordmarks}
              onChange={(e) => setWordmarks(e.target.value)}
              placeholder="stelz, stélz, stëlz"
            />
          </Field>
          <div className="text-[11px] text-[var(--color-ink-subtle)]">Comma-separated. Case doesn't matter.</div>
        </Card>

        {/* Visual identity description */}
        <Card className="p-6 space-y-5">
          <SubHeader
            step="Look & feel"
            title="Describe how your brand looks"
            desc="Colors, logo, packaging, tagline. In plain English. Bullets work great."
          />
          <Field label="">
            <Textarea
              rows={8}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={`- Slim navy can with the STËLZ wordmark and an umlaut on the E\n- A circle-S ring icon — its color shows the flavor (orange = lemonade, red = seltzer, teal = iced tea)\n- Curved tagline: HARD SELTZER / HARD LEMONADE\n- Dutch beverage, 250–330ml can format`}
              className="text-[12px] leading-relaxed"
            />
          </Field>
        </Card>

        <div className="flex items-center gap-3 pt-2">
          <Button variant="primary" size="sm" disabled={savingIdentity || !canWrite} onClick={saveIdentity}>
            {savingIdentity ? 'Saving…' : 'Save identity & spellings'}
          </Button>
          <SavedInline msg={msg && !err ? msg : null} />
        </div>
      </div>
    </SectionShell>
  )
}

function SubHeader({ step, title, desc, trailing }: { step: string; title: string; desc: string; trailing?: ReactNode }) {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)] mb-1.5">{step}</div>
        <h3 className="text-[15px] font-medium text-[var(--color-ink)] tracking-tight">{title}</h3>
        <p className="text-[12px] text-[var(--color-ink-muted)] mt-1.5 leading-relaxed max-w-[540px]">{desc}</p>
      </div>
      {trailing}
    </header>
  )
}

// ─── 3. Hashtag pool ─────────────────────────────────────────────────

function HashtagPoolSection() {
  const { canWrite } = useMembership()
  const [items, setItems] = useState<HashtagPoolEntry[]>([])
  const [draft, setDraft] = useState('')
  // The pool runs to a hundred-plus tags. Even in its own tab that is a wall,
  // and the thing people come here to do is find ONE tag — usually to switch it
  // off after it turned out to pull noise.
  const [filter, setFilter] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [draftPlatform, setDraftPlatform] = useState<'instagram' | 'tiktok'>('instagram')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Zelfde reden als hierboven: de fetch hoort in het effect, aanroepers vragen
  // een nieuwe ronde aan.
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = () => setReloadKey((k) => k + 1)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await fbListHashtagPool()
      if (!cancelled) setItems(list)
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  async function save(next: HashtagPoolEntry[], replace = false) {
    // Guards every caller at once — the Add button, the active checkbox, the
    // priority input and Remove all land here. Disabling only the button left
    // the three inline controls firing writes that the server then refused.
    if (!canWrite) return
    setBusy(true); setMsg(null); setErr(null)
    try {
      await fbUpdateBrandSettings({}, {
        // family/maxResults/kind round-trip as-is. Nulls are safe: the server
        // (hashtags.pool_patch_docs) only writes fields that are non-null, so
        // legacy seeded tags are never restamped by a save.
        hashtagPool: next.map(({ tag, platform, priority, active, family, maxResults, kind }) =>
          ({ tag, platform, priority, active, family, maxResults, kind })),
        replaceHashtags: replace,
      })
      refresh()
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2000)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  async function addTag() {
    const t = draft.trim().toLowerCase().replace(/^#/, '')
    if (!t) return
    // family "custom" + a 200-results cap, matching the server defaults in
    // hashtags.pool_patch_docs. The cap is the feature: an uncapped tag
    // scrapes at the full per-scan depth (500 results ≈ $1.15 per tag per
    // scan). "custom" also guarantees the tag a slot in every scan via the
    // family floor in select_tags — client terms are never starved out.
    const next: HashtagPoolEntry[] = [...items, {
      id: `${draftPlatform}_${t}`, tag: t, platform: draftPlatform,
      priority: 5, active: true, family: 'custom', maxResults: 200, kind: 'hashtag',
    }]
    setDraft('')
    await save(next)
  }

  const activeCount = items.filter((i) => i.active).length

  // Cost preview — an UPPER BOUND, stated as one. Apify bills per result
  // (~$2.30/1k on Instagram; the TikTok actor is free), each tag scrapes at
  // most min(500, its cap) results, and a scan takes at most 50 tags. The
  // server-side selection (hashtags.select_tags) may pick fewer or different
  // tags, so this previews the ceiling, not the invoice.
  const scanCeiling = (() => {
    const active = items.filter((i) => i.active)
    const perTag = (h: HashtagPoolEntry) => Math.min(500, h.maxResults ?? 500)
    const ig = active.filter((h) => h.platform === 'instagram')
      .sort((a, b) => perTag(b) - perTag(a)).slice(0, 50)
    const results = ig.reduce((s, h) => s + perTag(h), 0)
    return { results, usd: (results * 2.3) / 1000 }
  })()
  const VISIBLE = 40
  const q = filter.trim().toLowerCase().replace(/^#/, '')
  const filtered = items
    .filter((h) => (activeOnly ? h.active : true))
    .filter((h) => (q ? h.tag.includes(q) : true))
    .sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag))
  const shown = showAll ? filtered : filtered.slice(0, VISIBLE)

  return (
    <SectionShell
      eyebrow="Discovery"
      title="Hashtags we watch"
      hint="We scan Instagram and TikTok for posts using these tags. Higher-priority tags are scanned first."
      action={
        <div className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums text-right">
          <div>{activeCount} active · {items.length} total</div>
          {scanCeiling.results > 0 && (
            <div title="Upper bound: Apify bills per result (~$2.30/1k on Instagram). A scan takes at most 50 tags at at most their cap; the actual selection can be smaller.">
              next scan ≤ {scanCeiling.results.toLocaleString()} results (~${scanCeiling.usd.toFixed(2)})
            </div>
          )}
        </div>
      }
    >
      <Card className="p-6 space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={draftPlatform}
            onChange={(e) => setDraftPlatform(e.target.value as 'instagram' | 'tiktok')}
            className="border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 h-9 text-[13px] focus:outline-none focus:border-[var(--color-ink)]"
          >
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
          </select>
          <Input
            placeholder="stelz, vrijmibo, koningsdag…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            className="max-w-xs flex-1"
          />
          <Button variant="primary" size="sm" disabled={busy || !draft.trim() || !canWrite} onClick={addTag}>Add</Button>
          <SavedInline msg={msg} />
        </div>

        {err && <ErrorInline msg={err} />}

        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
            <Input
              placeholder="Filter tags…"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setShowAll(false) }}
              className="max-w-[220px]"
            />
            <label className="flex items-center gap-2 text-[12px] text-[var(--color-ink-muted)] select-none">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => { setActiveOnly(e.target.checked); setShowAll(false) }}
                className="accent-[var(--color-ink)]"
              />
              Active only
            </label>
            <span className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums ml-auto">
              {filtered.length === items.length
                ? `${items.length} tags`
                : `${filtered.length} of ${items.length}`}
            </span>
          </div>
        )}

        {items.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border-strong)] py-10 text-center text-[12px] text-[var(--color-ink-muted)]">
            No hashtags yet. Add 3–5 to get discovery started.
          </div>
        ) : filtered.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border-strong)] py-10 text-center text-[12px] text-[var(--color-ink-muted)]">
            No tag matches "{filter}".
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {shown.map((h) => (
              <li key={h.id} className="py-3 grid grid-cols-[24px_1fr_88px_84px_120px_110px_60px] gap-3 items-center text-[13px]">
                <input
                  type="checkbox"
                  checked={h.active}
                  disabled={!canWrite || busy}
                  onChange={() => save(items.map((x) => x.id === h.id ? { ...x, active: !x.active } : x))}
                  className="accent-[var(--color-ink)] disabled:opacity-40"
                />
                <span className={h.active ? '' : 'text-[var(--color-ink-subtle)] line-through'}>
                  #{h.tag}
                </span>
                <Badge tone="muted">{h.platform}</Badge>
                {/* Family drives budget + the guaranteed slot in select_tags.
                    Legacy docs without one show a dash rather than a made-up
                    value — the server only stamps families on NEW tags. */}
                {h.family ? (
                  <Badge tone={h.family === 'custom' ? 'accent' : 'neutral'}>{h.family.replace(/_/g, ' ')}</Badge>
                ) : (
                  <span className="text-[11px] text-[var(--color-ink-subtle)]">—</span>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">Priority</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={h.priority}
                    disabled={!canWrite || busy}
                    onChange={(e) => save(items.map((x) => x.id === h.id ? { ...x, priority: parseInt(e.target.value) || 5 } : x))}
                    className="w-11 border border-[var(--color-border)] px-2 h-7 text-[12px] tabular-nums text-center disabled:opacity-40"
                  />
                </div>
                <CapInput
                  value={h.maxResults}
                  disabled={!canWrite || busy}
                  onCommit={(v) => save(items.map((x) => x.id === h.id ? { ...x, maxResults: v } : x))}
                />
                {canWrite ? (
                  <button
                    onClick={() => save(items.filter((x) => x.id !== h.id), true)}
                    disabled={busy}
                    className="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-bad)] text-right disabled:opacity-40"
                  >
                    Remove
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}

        {!showAll && filtered.length > shown.length && (
          <button
            onClick={() => setShowAll(true)}
            className="text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline decoration-dotted underline-offset-4"
          >
            Show the remaining {filtered.length - shown.length}
          </button>
        )}
      </Card>
    </SectionShell>
  )
}

/** Per-tag result cap editor.
 *
 * Draft state committed on blur/Enter — NOT a save per keystroke. The naive
 * version fired a full pool save on every digit: typing "150" saved "1" (which
 * the server clamps to 10), the busy flag then disabled the input mid-word,
 * and the refresh overwrote what the user was still typing. Review-confirmed.
 */
function CapInput({ value, disabled, onCommit }: {
  value: number | null
  disabled: boolean
  onCommit: (v: number | null) => void
}) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  // Re-sync when the saved value changes underneath (another row's save
  // triggered a refresh). Tijdens de render, niet in een effect: als effect
  // stond het veld een frame lang op de oude waarde nadat de nieuwe binnen was.
  useResetOn(value, () => setDraft(value == null ? '' : String(value)))
  const commit = () => {
    const v = parseInt(draft)
    const next = Number.isFinite(v) ? v : null
    if (next !== value) onCommit(next)
  }
  return (
    <div className="flex items-center gap-2" title="Maximum Apify results per scan for this tag — this is what caps its cost. Empty = scans at the full per-scan depth (500).">
      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-subtle)]">Cap</span>
      <input
        type="number"
        min={10}
        max={1000}
        step={10}
        value={draft}
        placeholder="500"
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-16 border border-[var(--color-border)] px-2 h-7 text-[12px] tabular-nums text-center disabled:opacity-40"
      />
    </div>
  )
}


// ─── 4. Team (who can change things) ─────────────────────────────────

/**
 * Membership is the whole access model: it decides who can reject detections,
 * edit the reference images the detector is trained on, and spend money on a
 * scan. Everyone else — testers included — gets the same dashboard in
 * read-only mode.
 *
 * Before this panel existed the only ways to grant it were a bug (bootstrap
 * enrolled every caller as an owner) and a hand-written Firestore document.
 * The list is shown to non-members too: knowing who to ask is not privileged
 * information, and it is the first thing a read-only tester wants.
 */
function TeamSection() {
  const { canWrite } = useMembership()
  const [members, setMembers] = useState<BrandMember[] | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'owner'>('member')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // "Could not load" and "empty" are opposite findings and must not share a
  // render path: the server refuses this list to non-members (403), and
  // mapping that onto an empty array showed a read-only tester the raw error
  // text PLUS "Nobody has moderator access yet" — a false statement about a
  // brand that has owners.
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    fbListMembers()
      .then(setMembers)
      .catch(() => setLoadFailed(true))
  }, [])

  async function add() {
    const addr = email.trim().toLowerCase()
    if (!addr || !canWrite) return
    setBusy(true); setMsg(null); setErr(null)
    try {
      setMembers(await fbAddMember(addr, role))
      setEmail('')
      setMsg(`${addr} can now moderate.`)
      setTimeout(() => setMsg(null), 4000)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  async function remove(m: BrandMember) {
    if (!canWrite) return
    const who = m.email ?? m.uid
    if (!confirm(m.isYou
      ? `Remove your own access? You will lose the ability to moderate, and only another member can add you back.`
      : `Remove ${who}? They keep read access but can no longer change anything.`)) return
    setBusy(true); setMsg(null); setErr(null)
    try {
      setMembers(await fbRemoveMember(m.uid))
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <SectionShell
      eyebrow="Access"
      title="Who can change things"
      hint="Everyone signed in can read the whole dashboard. Only the people listed here can reject detections, edit reference images or start a scan — everyone else is read-only."
      action={members ? (
        <div className="text-[11px] text-[var(--color-ink-subtle)] tabular-nums">
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </div>
      ) : null}
    >
      <Card className="p-6 space-y-5">
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              placeholder="collega@bedrijf.nl"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              className="max-w-xs flex-1"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'member' | 'owner')}
              className="border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 h-9 text-[13px] focus:outline-none focus:border-[var(--color-ink)]"
            >
              <option value="member">Moderator</option>
              <option value="owner">Owner</option>
            </select>
            <Button variant="primary" size="sm" disabled={busy || !email.trim()} onClick={add}>
              Give access
            </Button>
            <SavedInline msg={msg} />
          </div>
        )}

        {canWrite && (
          /* The uid only exists after a first sign-in, so this is a real
             constraint rather than a nicety — the server refuses unknown
             addresses instead of creating a membership nobody can use. */
          <p className="text-[11px] text-[var(--color-ink-subtle)] leading-relaxed">
            They need to have signed in with that address at least once. An owner can
            add and remove other owners; a moderator cannot.
          </p>
        )}

        <ErrorInline msg={err} />

        {loadFailed ? (
          <div className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
            De ledenlijst kon niet worden opgehaald — de server toont hem alleen
            aan leden. Vraag een teamlid met toegang wie je toegang kan geven.
          </div>
        ) : members === null ? (
          <div className="text-[12px] text-[var(--color-ink-muted)]">Loading…</div>
        ) : members.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border-strong)] py-8 text-center text-[12px] text-[var(--color-ink-muted)]">
            Nobody has moderator access yet.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {members.map((m) => (
              <li key={m.uid} className="py-3 flex items-center gap-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate">
                  {m.email ?? <span className="text-[var(--color-ink-subtle)]">{m.uid}</span>}
                  {m.isYou && <span className="text-[var(--color-ink-subtle)]"> · you</span>}
                </span>
                <Badge tone={m.role === 'owner' ? 'accent' : 'muted'}>
                  {m.role === 'owner' ? 'owner' : 'moderator'}
                </Badge>
                {canWrite ? (
                  <button
                    onClick={() => remove(m)}
                    disabled={busy}
                    className="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-bad)] disabled:opacity-40 w-16 text-right"
                  >
                    Remove
                  </button>
                ) : (
                  <span className="w-16" />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </SectionShell>
  )
}

// ─── 5. Maintenance (manual pipeline steps) ──────────────────────────

/**
 * Sentiment scoring runs automatically at the end of each scan, capped per run.
 * That is fine for new hits and useless for the back catalogue: it was added
 * long after most detections were written, so thousands of posts start
 * unscored and would only drain one scan at a time. This button exists so the
 * backfill can be driven deliberately without waiting for scans nobody wants
 * to pay for.
 */
function MaintenanceSection() {
  const { canWrite } = useMembership()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function runProfiles() {
    if (!canWrite) return
    setBusy(true); setMsg(null); setErr(null)
    try {
      const r = await fbStepProfiles(500)
      setMsg(
        r.updated > 0
          ? `Refreshed ${r.updated} of ${r.scanned} Instagram creators.` +
            (r.without_follower_count
              ? ` ${r.without_follower_count} came back without a follower count — Instagram doesn't always return one.`
              : '')
          : r.reason === 'budget'
            ? "Stopped: today's budget cap is already reached."
            : 'No Instagram creators to refresh.',
      )
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  async function runSentiment() {
    if (!canWrite) return
    setBusy(true); setMsg(null); setErr(null)
    try {
      const r = await fbStepSentiment(400)
      const parts = Object.entries((r.breakdown ?? {}) as Record<string, number>)
        .map(([k, v]) => `${v} ${k}`)
        .join(' · ')
      setMsg(
        r.scored > 0
          ? `Scored ${r.scored} post${r.scored === 1 ? '' : 's'}${parts ? ` — ${parts}` : ''}.` +
            (r.failed ? ` ${r.failed} couldn't be read and will be retried.` : '') +
            ' Run again to continue through the backlog.'
          : r.reason === 'budget_exhausted'
            ? "Stopped: today's budget cap is already reached."
            : 'Nothing left to score.',
      )
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  if (!canWrite) return null
  return (
    <SectionShell
      eyebrow="Maintenance"
      title="Manual steps"
      hint="Things that normally run themselves after a scan, but can be driven by hand."
    >
      <Card className="p-6 divide-y divide-[var(--color-border)]">
        <div className="flex items-start justify-between gap-6 pb-5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--color-ink)]">Refresh creator profiles</div>
            <div className="text-[12px] text-[var(--color-ink-muted)] mt-1 leading-relaxed max-w-[460px]">
              Fetches follower counts, bios and profile pictures for Instagram creators.
              Instagram post data carries none of this, so this is the only thing that puts
              real follower numbers on the dashboard. About $1.15 per 500 creators.
            </div>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={runProfiles}>
            {busy ? 'Working…' : 'Refresh'}
          </Button>
        </div>
        <div className="flex items-start justify-between gap-6 pt-5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--color-ink)]">Score post sentiment</div>
            <div className="text-[12px] text-[var(--color-ink-muted)] mt-1 leading-relaxed max-w-[460px]">
              Reads the caption of hits that don't have a sentiment label yet and classifies
              them as positive, neutral, negative or promotional. 400 posts per run, about
              $0.08 each time. Safe to run repeatedly — it only ever picks up what's unscored.
            </div>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={runSentiment}>
            {busy ? 'Scoring…' : 'Run now'}
          </Button>
        </div>
        {(msg || err) && (
          <div className="mt-4">
            {err ? <ErrorInline msg={err} /> : (
              <div className="text-[12px] text-[var(--color-ink-muted)] border border-[var(--color-border)] px-3 py-2 leading-relaxed">
                {msg}
              </div>
            )}
          </div>
        )}
      </Card>
    </SectionShell>
  )
}

// ─── 6. Advanced (collapsed by default) ──────────────────────────────

function AdvancedSection() {
  const { canWrite } = useMembership()
  // Was collapsed behind a "Show options" toggle because it sat in the middle
  // of one long page. It has its own tab now, so reaching it is already a
  // deliberate act and a second click buys nothing.
  const [open] = useState(true)
  const [confidenceMin, setConfidenceMin] = useState(0.7)
  const [dailyBudget, setDailyBudget] = useState(5)
  const [storiesAutoScan, setStoriesAutoScan] = useState(false)
  const [dailyAutoScan, setDailyAutoScan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fbGetBrand().then((b) => {
      if (!b) return
      if (typeof b.confidenceMin === 'number') setConfidenceMin(b.confidenceMin)
      if (typeof b.dailyBudgetUsd === 'number') setDailyBudget(b.dailyBudgetUsd)
      setStoriesAutoScan(b.storiesAutoScan === true)
      setDailyAutoScan(b.dailyAutoScan === true)
    })
  }, [])

  async function save() {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await fbUpdateBrandSettings({
        confidenceMin,
        dailyBudgetUsd: dailyBudget,
        storiesAutoScan,
        dailyAutoScan,
      })
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2500)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <SectionShell
      eyebrow="Advanced"
      title="Fine-tuning"
      hint="Sensible defaults are already set. Change these only if you want to trade precision for reach, or cap daily costs."
    >
      {open && (
        <Card className="p-6 space-y-8">
          <Slider
            label="Only show detections above"
            hint="Anything the AI is less sure about stays hidden from the main feed. You can still find them in a filter."
            value={confidenceMin}
            min={0} max={1} step={0.05}
            onChange={setConfidenceMin}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />

          {/* The only unattended spend in the product, so it gets an explicit
              switch and an honest explanation of what it costs. */}
          <Field
            label="Stories automatisch ophalen"
            hint="Elke 6 uur de stories van gevolgde creators binnenhalen — ongeveer $0,28 per keer. Stories verdwijnen na 24 uur, dus zonder deze scan mis je alles wat valt terwijl niemand op Scan drukt. De dagbudgetlimiet hieronder blijft gelden."
          >
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={storiesAutoScan}
                disabled={!canWrite}
                onChange={(e) => setStoriesAutoScan(e.target.checked)}
              />
              <span>{storiesAutoScan ? 'Aan — elke 6 uur' : 'Uit'}</span>
            </label>
          </Field>

          <Field
            label="Dagelijkse scan"
            hint="Elke ochtend om 07:00 een volledige scan: hashtags, creators, profielen, scenes en resonantie. De scan maakt zichzelf passend binnen het resterende dagbudget voordat er iets wordt uitgegeven — de limiet hieronder is dus ook hier de baas."
          >
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={dailyAutoScan}
                disabled={!canWrite}
                onChange={(e) => setDailyAutoScan(e.target.checked)}
              />
              <span>{dailyAutoScan ? 'Aan — elke ochtend 07:00' : 'Uit'}</span>
            </label>
          </Field>

          <Field label="Daily budget cap (USD)" hint="Once the day's estimated spend hits this, further scans pause until tomorrow.">
            <Input
              type="number"
              min={0}
              step={1}
              value={dailyBudget}
              onChange={(e) => setDailyBudget(parseFloat(e.target.value) || 0)}
              className="max-w-[140px]"
            />
          </Field>

          <ErrorInline msg={err} />
          <div className="flex items-center gap-3 pt-2 border-t border-[var(--color-border)]">
            <Button variant="primary" size="sm" disabled={busy || !canWrite} onClick={save}>
              {busy ? 'Saving…' : 'Save advanced settings'}
            </Button>
            <SavedInline msg={msg} />
          </div>
        </Card>
      )}
    </SectionShell>
  )
}

function Slider({ label, hint, value, min, max, step, onChange, format }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string
}) {
  return (
    <div>
      <div className="flex items-start justify-between mb-3 gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-ink)]">{label}</div>
          {hint && <div className="text-[11px] text-[var(--color-ink-muted)] mt-1 leading-relaxed max-w-[440px]">{hint}</div>}
        </div>
        <div className="text-[16px] font-medium tabular-nums text-[var(--color-ink)] shrink-0">{format(value)}</div>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[var(--color-ink)]"
      />
    </div>
  )
}

// ─── 6. Danger zone (collapsed by default) ───────────────────────────

function DangerSection() {
  const [open, setOpen] = useState(false)
  return (
    <SectionShell
      eyebrow="Danger zone"
      title="Irreversible actions"
      hint="Export all your data or delete this brand entirely. These aren't wired up yet — they'll ask twice before doing anything. Kept behind one more click on purpose: nothing here should be one stray click away."
      action={
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-bad)] underline decoration-dotted underline-offset-4"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open && (
        <Card className="p-6 divide-y divide-[var(--color-border)]">
          <div className="flex items-center justify-between pb-5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-ink)]">Export all data</div>
              <div className="text-[11px] text-[var(--color-ink-muted)] mt-0.5">Download every detection and creator as CSV.</div>
            </div>
            <Button size="sm" disabled>Coming soon</Button>
          </div>
          <div className="flex items-center justify-between pt-5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-bad)]">Delete brand</div>
              <div className="text-[11px] text-[var(--color-ink-muted)] mt-0.5">Removes every detection, hashtag, and reference image. Cannot be undone.</div>
            </div>
            <Button variant="danger" size="sm" disabled>Coming soon</Button>
          </div>
        </Card>
      )}
    </SectionShell>
  )
}
