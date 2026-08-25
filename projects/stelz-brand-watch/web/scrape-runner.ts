// The decisions behind the dev server's scrape endpoints, kept pure.
//
// Like preview-paths.ts this lives outside src/ because it is dev-server code
// that must never enter the bundle, and outside vite.config.ts because it is
// the part worth testing: which URLs name a runnable event, and what a lock
// file plus a log add up to. The vite plugin does the I/O (spawn, read, stat);
// everything that can be wrong without touching a disk is decided here.
//
// THE RULES
//
//   exact Set membership     The event id comes from a browser URL and becomes
//                            a shell argument and two file names. It is only
//                            accepted when it exactly matches an event with a
//                            definition on disk — never sanitised into one.
//   the lock is the truth    A round is running exactly when the lock file
//                            names a live pid. The runner script removes its
//                            lock on exit (trap EXIT); a lock naming a dead pid
//                            therefore means the previous round crashed, which
//                            the status reports rather than hides.
//   the log has one ending   79_verversronde.sh prints "verversronde klaar" as
//                            its final line. A log without that line and
//                            without a live pid is a round that died halfway.

export type ScrapeStatus = {
  /** A round is underway — the lock names a pid that is alive. */
  running: boolean
  /** A lock is present but its pid is dead: the previous round crashed. */
  stale: boolean
  /** Did the most recent finished round reach its final line? Null if no
   *  round ever ran (no log). */
  exitOk: boolean | null
  /** How many pipeline steps printed the runner's "faalde" line. The runner
   *  deliberately keeps going after a failed step, so "finished" and "finished
   *  cleanly" are different facts — this is the difference. */
  failedSteps: number
  /** New items the harvesters reported so far, summed across their three
   *  counter spellings. Null when no counter line has appeared yet. */
  newItems: number | null
  /** Where the round is in its 12-step pipeline, from the last "→ script"
   *  line. Null before the first step or when no round ever ran. */
  currentStep: { index: number; total: number; label: string } | null
  /** The last non-empty log line — the most specific thing to show on error. */
  lastLine: string | null
  /** The last lines of the log, newest last — enough to see where it is. */
  logTail: string[]
  /** mtime (ms) of the campaign fixture: "when was the data last rebuilt". */
  fixtureMtime: number | null
}

/** The final line 79_verversronde.sh prints; the two must change together. */
export const DONE_MARKER = 'verversronde klaar'

/** The runner's per-failed-step line; counted, never hidden. */
export const FAILED_MARKER = ' faalde — '

const TAIL_LINES = 15

/** The 12 steps of 79_verversronde.sh, in order, keyed by their "→" log line.
 *  The labels are what a person waiting at the button gets to read. */
const STEPS: { match: RegExp; label: string }[] = [
  { match: /→ 62_stories_archive\.py/, label: 'stories ophalen' },
  { match: /→ 70_tiktok_archive\.py/, label: 'TikTok-roster ophalen' },
  { match: /→ 71_ig_posts_archive\.py/, label: 'Instagram-posts ophalen' },
  { match: /→ 73_lowlands_discovery\.py/, label: 'discovery via tags' },
  { match: /→ 74_analyse\.py .*--archive stories/, label: 'analyse: stories' },
  { match: /→ 74_analyse\.py .*--archive tiktok/, label: 'analyse: TikTok' },
  { match: /→ 74_analyse\.py .*--archive ig-posts/, label: 'analyse: Instagram-posts' },
  { match: /→ 74_analyse\.py .*--archive discovery/, label: 'analyse: discovery' },
  { match: /→ 72_campaign_fixture\.py/, label: 'dashboard bijwerken' },
  { match: /→ 76_audience\.py/, label: 'publiek bijwerken' },
  { match: /→ 61_stories_preview_fixture\.py/, label: 'stories-weergave bijwerken' },
  { match: /→ 77_voortgang\.py/, label: 'tellers bijwerken' },
]

/** The harvesters report their yield in three different spellings — this is
 *  measured from the real logs, not designed: `archived 4 new` (62),
 *  `+12 new` (70/71) and `18 nieuw ·` (73). All three count as new items. */
const NEW_COUNTERS = [/archived (\d+) new/g, /\+(\d+) new/g, /(\d+) nieuw ·/g]

/** Library noise that would otherwise dominate the tail and the caption — the
 *  google-genai SDK prints its AFC deprecation warning to stderr on every
 *  call, hundreds of times per analysis step. */
const NOISE = /automatic function calling \(AFC\)/

/**
 * Which event does this endpoint URL name, if any?
 *
 * @returns the event id, or null to 404. Query strings are ignored; anything
 * that is not an exact member of `eventIds` — including ids with slashes,
 * dots, or an empty remainder — is refused.
 */
export function parseRunnerUrl(
  url: string,
  prefix: '/scrape-run/' | '/scrape-status/' | '/scrape-stop/',
  eventIds: Set<string>,
): string | null {
  const clean = (url || '').split('?')[0]
  if (!clean.startsWith(prefix)) return null
  const id = clean.slice(prefix.length)
  return eventIds.has(id) ? id : null
}

/** `.tmp/scrape-<event>.lock` — holds the runner's pid while it runs. The id
 *  is Set-validated before it gets here, so this is naming, not sanitising. */
export function lockPath(tmp: string, eventId: string): string {
  return `${tmp}/scrape-${eventId}.lock`
}

/** `.tmp/scrape-<event>.log` — stdout+stderr of the running round. */
export function logPath(tmp: string, eventId: string): string {
  return `${tmp}/scrape-${eventId}.log`
}

/** The pid a lock file names, or null when the content is not one. */
export function parseLock(text: string | null): number | null {
  if (text == null) return null
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Fold what the disk says into one status. Pure: the caller reads the lock,
 * checks the pid, reads the log and stats the fixture; this only decides.
 */
export function deriveStatus(opts: {
  lockPid: number | null
  pidAlive: boolean
  logText: string | null
  fixtureMtime: number | null
}): ScrapeStatus {
  const running = opts.lockPid != null && opts.pidAlive
  const stale = opts.lockPid != null && !opts.pidAlive
  const text = opts.logText ?? ''
  const lines = text.split('\n').map((l) => l.trimEnd())
    .filter((l) => l && !NOISE.test(l))

  let currentStep: ScrapeStatus['currentStep'] = null
  for (const line of lines) {
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].match.test(line)) currentStep = { index: i + 1, total: STEPS.length, label: STEPS[i].label }
    }
  }

  let newItems: number | null = null
  for (const re of NEW_COUNTERS) {
    for (const m of text.matchAll(re)) {
      newItems = (newItems ?? 0) + Number.parseInt(m[1], 10)
    }
  }

  return {
    running,
    stale,
    // While a round runs the marker of a PREVIOUS round may still sit in an
    // old log; exitOk only means something once nothing is running.
    exitOk: running || opts.logText == null
      ? null
      : lines.some((l) => l.includes(DONE_MARKER)),
    failedSteps: lines.filter((l) => l.includes(FAILED_MARKER)).length,
    newItems,
    currentStep,
    lastLine: lines.length > 0 ? lines[lines.length - 1] : null,
    logTail: lines.slice(-TAIL_LINES),
    fixtureMtime: opts.fixtureMtime,
  }
}
