// What this tool costs to run — one table, checked against the backend.
//
// There were two price tables. The Python one (firebase/functions/lib/usage.py)
// is measured against a real invoice; the copy that used to live in
// fbListUsage was the model that Python had ALREADY corrected, and it was
// wrong in both directions at once:
//
//   apify_runs        $0.10/run   → runs are free; RESULTS are billed
//   gemini_flash_calls $0.00075   → $0.00175, 2.3x higher
//   apify_ig_results   missing    → $0.0023, the dominant Apify cost
//
// It charged for something free while ignoring where the money actually goes,
// under-reporting Apify spend by roughly 11x. It was never rendered — the
// function had no call sites — so nobody saw the number, which is the only
// reason it survived. Now that costs go on screen, the table has to be right
// and has to stay right: tests/test_cost_parity.py reads THIS FILE and fails
// if a single key or amount drifts from COST_PER_UNIT.
//
// Everything here is an ESTIMATE from measured unit prices, not an invoice.
// Cloud Functions, Firestore and Storage are not counted; at this volume they
// are small, but they are not zero, and the UI says so.

/** USD per unit of the named counter. Parity-checked against lib/usage.py. */
export const COST_PER_UNIT: Record<string, number> = {
  apify_ig_results: 0.0023,
  apify_tt_results: 0.0,
  apify_story_runs: 0.099,
  apify_story_usernames: 0.003,
  gemini_flash_calls: 0.00175,
  gemini_video_calls: 0.00288,
  gemini_embed_calls: 0.0001,
  gemini_verify_calls: 0.0033,
  gemini_sentiment_calls: 0.0002,
}

export type CostGroup = 'apify' | 'gemini'

export type UnitMeta = {
  label: string
  group: CostGroup
  /** What one unit is, in words. */
  note: string
  /** False when no handler increments this counter — shown as unused rather
   *  than as a silent zero, which reads like "we spent nothing on it". */
  recorded: boolean
}

export const UNIT_META: Record<string, UnitMeta> = {
  apify_ig_results: {
    label: 'Instagram-resultaten', group: 'apify', recorded: true,
    note: 'Apify rekent per resultaat, niet per run — dit is de grootste post.',
  },
  apify_tt_results: {
    label: 'TikTok-resultaten', group: 'apify', recorded: true,
    note: 'Gratis actor. Wordt geteld zodat een overstap naar de betaalde versie meteen zichtbaar is.',
  },
  apify_story_runs: {
    label: 'Story-sweeps', group: 'apify', recorded: true,
    note: 'Deze actor rekent per rún — de uitzondering op "runs zijn gratis". Daarom gaan alle handles in één run.',
  },
  apify_story_usernames: {
    label: 'Accounts in story-sweeps', group: 'apify', recorded: true,
    note: 'Per account dat in een sweep wordt meegegeven.',
  },
  gemini_flash_calls: {
    label: 'Beeldanalyses', group: 'gemini', recorded: true,
    note: 'Eén foto beoordeeld, inclusief de 8 referentiebeelden die elke call meestuurt.',
  },
  gemini_video_calls: {
    label: 'Video-analyses', group: 'gemini', recorded: true,
    note: 'Alle frames van één video in één call — losse frames zouden de referenties zes keer versturen.',
  },
  gemini_verify_calls: {
    label: 'Tweede blik', group: 'gemini', recorded: true,
    note: 'Alleen op gedegradeerde hits, op 1024px in plaats van 512px.',
  },
  gemini_sentiment_calls: {
    label: 'Sentiment', group: 'gemini', recorded: true,
    note: 'Tekst-only over het onderschrift. Fractie van een beeldanalyse.',
  },
  gemini_embed_calls: {
    label: 'Embeddings', group: 'gemini', recorded: false,
    note: 'Staat in de prijstabel maar wordt door geen enkele handler geteld.',
  },
}

/** Counters that are volume, not money. Shown separately so a reader does not
 *  hunt for the price of something that has none. */
export const VOLUME_COUNTERS: Record<string, string> = {
  apify_runs: 'Actor-runs (gratis)',
  detections_written: 'Detecties weggeschreven',
  detections_hit: 'Waarvan met Stëlz',
}

export type SpendLine = { key: string; units: number; usd: number }

/** Spend for one day's counters, biggest line first. Unknown keys are ignored
 *  rather than guessed at — a counter with no price is not free, it is
 *  unpriced, and inventing one would be the original bug again. */
export function spendBreakdown(counters: Record<string, number>): {
  total: number
  lines: SpendLine[]
} {
  const lines: SpendLine[] = []
  let total = 0
  for (const [key, price] of Object.entries(COST_PER_UNIT)) {
    const units = counters[key] ?? 0
    if (!units) continue
    const usd = units * price
    total += usd
    lines.push({ key, units, usd })
  }
  lines.sort((a, b) => b.usd - a.usd)
  return { total, lines }
}

// ── The degrade ladder, mirroring lib/usage.py ──────────────────────────────
// Spending is throttled by narrowing the INPUTS, never by stopping mid-scan:
// work already paid for at Apify should finish being analysed.

export type Degrade = 'normal' | 'trim' | 'brand_only' | 'no_scrape' | 'cache_only'

export const DEGRADE_LABEL: Record<Degrade, string> = {
  normal: 'Volledige snelheid',
  trim: 'Licht afgeknepen',
  brand_only: 'Alleen merk-hashtags',
  no_scrape: 'Scrapen gestopt',
  cache_only: 'Budget op',
}

export const DEGRADE_NOTE: Record<Degrade, string> = {
  normal: 'Onder 70% van het dagbudget.',
  trim: 'Vanaf 70%: minder hashtags per scan, minder videoframes.',
  brand_only: 'Vanaf 85%: alleen merk-hashtags en gerichte creator-scans.',
  no_scrape: 'Vanaf 95%: geen nieuwe scrapes meer. Wat al opgehaald is, wordt nog wel geanalyseerd.',
  cache_only: 'Boven 100%: alleen analyses die al in de cache zitten, en die zijn gratis.',
}

export function degradeLevel(spend: number, budget: number): Degrade {
  if (!Number.isFinite(budget) || budget <= 0) return 'normal'
  const pct = spend / budget
  if (pct < 0.70) return 'normal'
  if (pct < 0.85) return 'trim'
  if (pct < 0.95) return 'brand_only'
  if (pct < 1.0) return 'no_scrape'
  return 'cache_only'
}

// ── What one action costs ───────────────────────────────────────────────────
// The defaults mirror the arguments the UI actually sends (lib/firestore.ts:
// fbStepHashtags(500, 50), fbStepCreators(80, 8), fbStepStories(60)), so the
// price card describes the button you are about to press, not a hypothetical.

export const DEFAULTS = {
  // Lowered from 500/50, which projected ~$40 of Apify against the $5 default
  // daily budget — the whole day spent in one click. The server now also trims
  // any request to the remaining budget (publish_tags), so these are the
  // opening bid, not the guarantee. test_cost_parity pins them to the
  // fbStepHashtags call site so this card always describes the real button.
  hashtagPerTag: 150,
  hashtagMaxTags: 30,
  creatorMax: 80,
  creatorPostsPer: 8,
  storyMaxHandles: 60,
  /** scheduled_stories in main.py — every 6 hours, the only cron in the app. */
  storySweepsPerDay: 4,
} as const

export type Recipe = {
  id: string
  label: string
  /** The arithmetic, spelled out, so a number on screen can be checked. */
  formula: string
  usd: number
}

export function storySweepCost(handles: number): number {
  return COST_PER_UNIT.apify_story_runs + handles * COST_PER_UNIT.apify_story_usernames
}

export function creatorScanCost(creators: number, postsPer: number): number {
  return creators * postsPer * COST_PER_UNIT.apify_ig_results
}

export function hashtagScanCost(perTag: number, maxTags: number): number {
  return perTag * maxTags * COST_PER_UNIT.apify_ig_results
}

/**
 * @param trackedHandles Instagram creators on tier 1 or 2 — what a story sweep
 *   actually submits. Falls back to the server-side cap.
 */
export function recipes(trackedHandles: number = DEFAULTS.storyMaxHandles): Recipe[] {
  const h = trackedHandles || DEFAULTS.storyMaxHandles
  return [
    {
      id: 'hashtags',
      label: 'Hashtag-scan ("Run scan")',
      formula: `${DEFAULTS.hashtagPerTag} posts × ${DEFAULTS.hashtagMaxTags} hashtags × $${COST_PER_UNIT.apify_ig_results}`,
      usd: hashtagScanCost(DEFAULTS.hashtagPerTag, DEFAULTS.hashtagMaxTags),
    },
    {
      id: 'creators',
      label: 'Creator-scan',
      formula: `${DEFAULTS.creatorMax} creators × ${DEFAULTS.creatorPostsPer} posts × $${COST_PER_UNIT.apify_ig_results}`,
      usd: creatorScanCost(DEFAULTS.creatorMax, DEFAULTS.creatorPostsPer),
    },
    {
      id: 'stories',
      label: 'Story-sweep',
      formula: `$${COST_PER_UNIT.apify_story_runs} per run + ${h} accounts × $${COST_PER_UNIT.apify_story_usernames}`,
      usd: storySweepCost(h),
    },
    {
      id: 'image',
      label: 'Eén foto analyseren',
      formula: '1 Gemini-call met 8 referentiebeelden',
      usd: COST_PER_UNIT.gemini_flash_calls,
    },
    {
      id: 'video',
      label: 'Eén video analyseren',
      formula: 'alle frames in 1 call',
      usd: COST_PER_UNIT.gemini_video_calls,
    },
    {
      id: 'verify',
      label: 'Tweede blik op een twijfelgeval',
      formula: '1 call op 1024px',
      usd: COST_PER_UNIT.gemini_verify_calls,
    },
  ]
}

export type Projection = {
  /** Runs on a schedule whether anyone opens the app or not. */
  fixedPerMonth: number
  fixedNote: string
  /** Per press of a button — no assumption about how often that happens. */
  perHashtagScan: number
  perCreatorScan: number
}

/**
 * Only `scheduled_stories` is automatic (every 6h, the sole cron in main.py).
 * Everything else waits for a click, so projecting a monthly total for it
 * would be inventing a usage pattern. The split says which is which.
 */
export function projection(trackedHandles: number, storiesAutoScan: boolean): Projection {
  const perSweep = storySweepCost(trackedHandles || DEFAULTS.storyMaxHandles)
  const sweeps = storiesAutoScan ? DEFAULTS.storySweepsPerDay * 30 : 0
  return {
    fixedPerMonth: perSweep * sweeps,
    fixedNote: storiesAutoScan
      ? `${DEFAULTS.storySweepsPerDay} story-sweeps per dag × 30 dagen`
      : 'Automatisch ophalen staat uit — er draait niets vanzelf.',
    perHashtagScan: hashtagScanCost(DEFAULTS.hashtagPerTag, DEFAULTS.hashtagMaxTags),
    perCreatorScan: creatorScanCost(DEFAULTS.creatorMax, DEFAULTS.creatorPostsPer),
  }
}

/** USD, Dutch formatting, enough decimals to keep a cent visible. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0,00'
  if (n < 0.01) return `$${n.toFixed(4).replace('.', ',')}`
  return `$${n.toFixed(2).replace('.', ',')}`
}
