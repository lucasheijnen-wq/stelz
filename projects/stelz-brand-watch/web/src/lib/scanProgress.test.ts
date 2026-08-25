import { describe, expect, it } from 'vitest'
import { analysisProgress, scanHeadline, scanIsStale, scanPhase, stepViews, STEP_ORDER } from './scanProgress'
import type { ScanState } from './firestore'

const NOW = Date.parse('2026-08-20T12:00:00Z')

function state(over: Partial<ScanState> = {}): ScanState {
  return {
    startedAt: '2026-08-20T11:50:00Z',
    finishedAt: null,
    steps: {},
    hashtagQueued: 0,
    hashtagDone: 0,
    postsWritten: 0,
    detectTasksEnqueued: 0,
    detectionsCompleted: 0,
    detectionsHit: 0,
    tags: [],
    lastActivityAt: '2026-08-20T11:59:00Z',
    skippedCount: 0,
    endReason: null,
    ...over,
  }
}

describe('scanPhase', () => {
  it('is idle before anything ran', () => {
    expect(scanPhase(null, NOW)).toBe('idle')
    expect(scanPhase(state({ startedAt: null }), NOW)).toBe('idle')
  })

  it('reports scraping while a step runs', () => {
    const s = state({ steps: { creators: { state: 'running', startedAt: null, finishedAt: null, error: null, counts: {} } } })
    expect(scanPhase(s, NOW)).toBe('scraping')
  })

  it('reports analysing once scraping is done but detections lag', () => {
    const s = state({
      finishedAt: '2026-08-20T11:58:00Z',
      steps: { hashtags: { state: 'done', startedAt: null, finishedAt: null, error: null, counts: {} } },
      detectTasksEnqueued: 100,
      detectionsCompleted: 40,
    })
    expect(scanPhase(s, NOW)).toBe('analysing')
  })

  it('calls a scan stalled after five silent minutes', () => {
    const s = state({ lastActivityAt: '2026-08-20T11:50:00Z' })
    expect(scanPhase(s, NOW)).toBe('stalled')
  })

  it('does NOT call it stalled while detections are still landing', () => {
    // The heartbeat used to freeze during the detect phase, so a perfectly
    // healthy scan was reported as dead.
    const s = state({
      lastActivityAt: '2026-08-20T11:50:00Z',
      finishedAt: '2026-08-20T11:52:00Z',
      detectTasksEnqueued: 100,
      detectionsCompleted: 40,
    })
    expect(scanPhase(s, NOW)).toBe('analysing')
  })

  it('surfaces an error only once nothing is still running', () => {
    const running = state({
      steps: {
        srs: { state: 'error', startedAt: null, finishedAt: null, error: 'boom', counts: {} },
        creators: { state: 'running', startedAt: null, finishedAt: null, error: null, counts: {} },
      },
    })
    expect(scanPhase(running, NOW)).toBe('scraping')
    const settled = state({
      finishedAt: '2026-08-20T11:58:00Z',
      steps: { srs: { state: 'error', startedAt: null, finishedAt: null, error: 'boom', counts: {} } },
    })
    expect(scanPhase(settled, NOW)).toBe('error')
  })

  it('falls back to the flat fields when the steps map is absent', () => {
    // A frontend that ships before the backend must not go blank.
    expect(scanPhase(state({ steps: {} }), NOW)).toBe('scraping')
    expect(scanPhase(state({ steps: {}, finishedAt: '2026-08-20T11:58:00Z' }), NOW)).toBe('done')
  })
})

describe('analysisProgress', () => {
  it('is null before anything is enqueued', () => {
    expect(analysisProgress(state(), NOW)).toBeNull()
  })

  it('clamps a numerator that overshoots its denominator', () => {
    const s = state({ detectTasksEnqueued: 10, detectionsCompleted: 14 })
    expect(analysisProgress(s, NOW)).toMatchObject({ done: 10, pct: 100 })
  })

  it('suppresses the ETA until there are enough samples to extrapolate from', () => {
    const few = state({ detectTasksEnqueued: 500, detectionsCompleted: 5 })
    expect(analysisProgress(few, NOW)?.etaMs).toBeNull()
    const many = state({ detectTasksEnqueued: 500, detectionsCompleted: 100 })
    expect(analysisProgress(many, NOW)?.etaMs).toBeGreaterThan(0)
  })
})

describe('stepViews', () => {
  it('renders one row per step plus the derived analysis row', () => {
    expect(stepViews(state(), {}, NOW)).toHaveLength(STEP_ORDER.length)
  })

  it('marks a step that never ran as skipped once the scan is over', () => {
    // These are the five fire-and-forget steps that used to be invisible.
    const s = state({ finishedAt: '2026-08-20T11:58:00Z' })
    const srs = stepViews(s, {}, NOW).find((v) => v.key === 'srs')
    expect(srs?.state).toBe('skipped')
  })

  it('keeps a step pending, not skipped, while the scan is still going', () => {
    const srs = stepViews(state(), {}, NOW).find((v) => v.key === 'srs')
    expect(srs?.state).toBe('pending')
  })

  it('shows a server error verbatim', () => {
    const s = state({ steps: { srs: { state: 'error', startedAt: null, finishedAt: null, error: 'Gemini quota op', counts: {} } } })
    const srs = stepViews(s, {}, NOW).find((v) => v.key === 'srs')
    expect(srs?.state).toBe('error')
    expect(srs?.error).toBe('Gemini quota op')
  })

  it('surfaces a client-side failure for a step the server never recorded', () => {
    // The chain swallowed these with .catch(() => {}); now they show up.
    const views = stepViews(state({ finishedAt: '2026-08-20T11:58:00Z' }), { profiles: 'network down' }, NOW)
    const profiles = views.find((v) => v.key === 'profiles')
    expect(profiles?.error).toBe('network down')
  })

  it('summarises a finished step from its counts', () => {
    const s = state({ steps: { stories: { state: 'done', startedAt: null, finishedAt: null, error: null, counts: { storiesFound: 4, accountsChecked: 28 } } } })
    const stories = stepViews(s, {}, NOW).find((v) => v.key === 'stories')
    expect(stories?.detail).toContain('4 stories')
  })

  it('shows analysis progress while detections land', () => {
    const s = state({ detectTasksEnqueued: 100, detectionsCompleted: 40 })
    const analysis = stepViews(s, {}, NOW).find((v) => v.key === 'analysis')
    expect(analysis?.state).toBe('running')
    expect(analysis?.detail).toContain('40 van 100')
  })
})

describe('scanHeadline', () => {
  it('speaks Dutch and matches the phase', () => {
    expect(scanHeadline(null, NOW).title).toMatch(/Nog geen scan/)
    expect(scanHeadline(state({ lastActivityAt: '2026-08-20T11:50:00Z' }), NOW).tone).toBe('bad')
    expect(scanHeadline(state({ finishedAt: '2026-08-20T11:58:00Z' }), NOW).tone).toBe('good')
  })
})

// De drie manieren waarop de homepage-scan eeuwig "bezig" kon lijken. Alle
// drie gevonden op een dashboard dat wekenlang "Beelden analyseren 40 van 100"
// toonde over een fan-out die allang dood was — wat leest als een scrape die
// tegelijk draait én kapot is.
describe('een dode scan mag niet eeuwig bezig lijken', () => {
  const WEKEN_LATER = NOW + 21 * 24 * 3600_000

  it('verklaart een halverwege bevroren fan-out na uren dood, niet analysing', () => {
    // Het "does NOT call it stalled"-geval hierboven, maar dan weken later:
    // dezelfde tellers, allang geen workers meer. analysing overrulet
    // staleness bewust (de heartbeat bevriest tijdens de detect-fase), dus
    // zonder tijdshorizon was dit voor altijd "Beelden analyseren".
    const s = state({
      lastActivityAt: '2026-08-20T11:50:00Z',
      finishedAt: '2026-08-20T11:52:00Z',
      detectTasksEnqueued: 100,
      detectionsCompleted: 40,
    })
    expect(scanPhase(s, WEKEN_LATER)).toBe('error')
    const row = stepViews(s, {}, WEKEN_LATER).find((v) => v.key === 'analysis')!
    expect(row.state).toBe('error')
    expect(row.detail).toBe('40 van 100')
    expect(row.error).toContain('niet afgemaakt')
  })

  it('laat een gezonde, verse fan-out gewoon analysing zijn', () => {
    const s = state({
      finishedAt: '2026-08-20T11:58:00Z',
      detectTasksEnqueued: 100,
      detectionsCompleted: 40,
    })
    expect(scanPhase(s, NOW)).toBe('analysing')
  })

  it('noemt een onafgemaakte, verlaten scan stalled', () => {
    const s = state({ detectTasksEnqueued: 100, detectionsCompleted: 40 })
    expect(scanPhase(s, WEKEN_LATER)).toBe('stalled')
  })

  it('vangt een scan die vóór zijn eerste heartbeat crashte', () => {
    // lastActivityAt is er nooit gekomen; de oude guard eiste last > 0 en
    // liet deze sessie voor altijd als 'scraping' staan — een pulserende stip
    // op een scan die bij de geboorte stierf.
    const s = state({ lastActivityAt: null })
    expect(scanPhase(s, NOW)).toBe('stalled')
  })

  it('scanIsStale: een net gestarte scan zonder heartbeat is niet stale', () => {
    // De knop rekende met lastActivityAt ?? 0 en flitste "Stalled at 0/0" in
    // de seconde tussen startedAt en de eerste worker-write.
    const s = state({ startedAt: '2026-08-20T11:59:30Z', lastActivityAt: null })
    expect(scanIsStale(s, NOW)).toBe(false)
    expect(scanPhase(s, NOW)).toBe('scraping')
  })
})

// De vierde weg waarop de homepage eeuwig "bezig" leek: de backend sloot de
// hashtags-stap vier commits lang nooit af (ontbrekende import, pas ná het
// stempelen van finishedAt), dus steps.hashtags bleef "running" — en een
// running step won het van elke ontsnapping omdat finishedAt de stale-check
// kortsluit. "Running" wordt nu alleen geloofd zolang de backend überhaupt
// recent iets schreef.
describe('een step die eeuwig running zegt', () => {
  const UREN_LATER = NOW + 7 * 3600_000
  const runningStep = {
    hashtags: { state: 'running' as const, startedAt: null, finishedAt: null,
                error: null, counts: {} },
  }

  it('wordt na uren stilte een fout, geen eeuwige "Bezig met scannen"', () => {
    const s = state({ finishedAt: '2026-08-20T11:52:00Z', steps: runningStep })
    expect(scanPhase(s, UREN_LATER)).toBe('error')
    const row = stepViews(s, {}, UREN_LATER).find((v) => v.key === 'hashtags')!
    expect(row.state).toBe('error')
    expect(row.error).toContain('niet afgemaakt')
  })

  it('blijft gewoon scraping terwijl de backend nog recent schreef', () => {
    const s = state({ steps: runningStep })
    expect(scanPhase(s, NOW)).toBe('scraping')
    expect(stepViews(s, {}, NOW).find((v) => v.key === 'hashtags')!.state)
      .toBe('running')
  })

  it('binnen de horizon telt running op een afgeronde scan ook nog', () => {
    // finishedAt is het einde van de PUBLISHER; een step die daarna nog
    // doorwerkt is normaal, zolang het geen uren stilte is.
    const s = state({ finishedAt: '2026-08-20T11:58:00Z', steps: runningStep })
    expect(scanPhase(s, NOW)).toBe('scraping')
  })
})
