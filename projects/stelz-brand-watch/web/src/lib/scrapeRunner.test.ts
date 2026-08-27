/// <reference types="node" />
// The scrape endpoints turn a browser URL into a shell argument and two file
// names, and a lock file plus a log into "is it safe to start another paid
// round". This tests the part that decides both — the I/O stays in the vite
// plugin, exactly like preview-paths.ts and its middleware.
import { describe, expect, it } from 'vitest'
import {
  DONE_MARKER, authPath, deriveStatus, lockPath, logPath, parseAuthBody, parseLock,
  parseRunnerUrl,
} from '../../scrape-runner'

const events = new Set(['lowlands-2026', 'pinkpop-2027'])

describe('parseRunnerUrl', () => {
  it('accepts exactly the events that have a definition', () => {
    expect(parseRunnerUrl('/scrape-run/lowlands-2026', '/scrape-run/', events))
      .toBe('lowlands-2026')
    expect(parseRunnerUrl('/scrape-status/pinkpop-2027', '/scrape-status/', events))
      .toBe('pinkpop-2027')
    expect(parseRunnerUrl('/scrape-stop/lowlands-2026', '/scrape-stop/', events))
      .toBe('lowlands-2026')
  })

  it('ignores a query string', () => {
    expect(parseRunnerUrl('/scrape-run/lowlands-2026?x=1', '/scrape-run/', events))
      .toBe('lowlands-2026')
  })

  it('refuses everything else — the id becomes a shell argument', () => {
    // Not a member: never sanitised into one, simply refused.
    expect(parseRunnerUrl('/scrape-run/unknown', '/scrape-run/', events)).toBeNull()
    expect(parseRunnerUrl('/scrape-run/', '/scrape-run/', events)).toBeNull()
    // Traversal and subshell shapes fail Set membership by construction.
    expect(parseRunnerUrl('/scrape-run/../../etc', '/scrape-run/', events)).toBeNull()
    expect(parseRunnerUrl('/scrape-run/lowlands-2026%3Brm', '/scrape-run/', events)).toBeNull()
    expect(parseRunnerUrl('/scrape-run/lowlands-2026/extra', '/scrape-run/', events)).toBeNull()
    // Wrong prefix entirely.
    expect(parseRunnerUrl('/preview-campaign.json', '/scrape-run/', events)).toBeNull()
  })
})

describe('lock parsing', () => {
  it('reads a pid and refuses everything that is not one', () => {
    expect(parseLock('12345\n')).toBe(12345)
    expect(parseLock('')).toBeNull()
    expect(parseLock('geen pid')).toBeNull()
    expect(parseLock('-4')).toBeNull()
    expect(parseLock(null)).toBeNull()
  })

  it('names the files under .tmp for the validated id', () => {
    expect(lockPath('/repo/.tmp', 'lowlands-2026')).toBe('/repo/.tmp/scrape-lowlands-2026.lock')
    expect(logPath('/repo/.tmp', 'lowlands-2026')).toBe('/repo/.tmp/scrape-lowlands-2026.log')
  })
})

describe('deriveStatus', () => {
  const base = { lockPid: null, pidAlive: false, logText: null, fixtureMtime: null }

  it('live pid in the lock = running; exitOk stays open until it ends', () => {
    const s = deriveStatus({ ...base, lockPid: 99, pidAlive: true, logText: 'bezig…' })
    expect(s.running).toBe(true)
    expect(s.stale).toBe(false)
    expect(s.exitOk).toBeNull()
  })

  it('dead pid in the lock = the previous round crashed, and it says so', () => {
    const s = deriveStatus({ ...base, lockPid: 99, pidAlive: false, logText: 'half\n' })
    expect(s.running).toBe(false)
    expect(s.stale).toBe(true)
    expect(s.exitOk).toBe(false)
  })

  it('a finished round is recognised by the runner script\'s final line', () => {
    const log = `[t] verversronde start\n[t] → 72_campaign_fixture.py\n[t] ${DONE_MARKER}\n`
    const ok = deriveStatus({ ...base, logText: log })
    expect(ok.running).toBe(false)
    expect(ok.exitOk).toBe(true)
    // Died halfway: no lock (trap cleaned it), no final line.
    expect(deriveStatus({ ...base, logText: '[t] verversronde start\n' }).exitOk).toBe(false)
  })

  it('no log at all means no round ever ran here', () => {
    expect(deriveStatus(base).exitOk).toBeNull()
    expect(deriveStatus(base).running).toBe(false)
  })

  it('keeps only the tail of a long log, newest last', () => {
    const log = Array.from({ length: 40 }, (_, i) => `regel ${i}`).join('\n')
    const s = deriveStatus({ ...base, logText: log })
    expect(s.logTail.length).toBe(15)
    expect(s.logTail.at(-1)).toBe('regel 39')
  })

  it('counts failed steps — the runner keeps going, the status must not hide it', () => {
    const log = [
      '[t] → 62_stories_archive.py --event lowlands-2026',
      '[t] 62_stories_archive.py faalde — door naar de volgende stap',
      '[t] → 70_tiktok_archive.py --event lowlands-2026',
      `[t] ${DONE_MARKER}`,
    ].join('\n')
    const s = deriveStatus({ ...base, logText: log })
    expect(s.failedSteps).toBe(1)
    // The marker was reached, but "finished" and "finished cleanly" differ.
    expect(s.exitOk).toBe(true)
  })

  it('sums the three harvester counter spellings into one yield number', () => {
    // Real lines from the 25 aug round: 62, 70/71 and 73 each spell their
    // counter differently. All of them are new items.
    const log = [
      '  archived 4 new · 49 already had · 0 not stories',
      '  +12 new · 708 already archived · 1050 in .tmp/events/lowlands-2026/tiktok',
      '  +0 new · 0 already archived · 0 older than --since',
      '18 nieuw · 3 al gearchiveerd · 2 van roster-creators (overgeslagen) · 1 te oud',
    ].join('\n')
    expect(deriveStatus({ ...base, logText: log }).newItems).toBe(34)
    // No counter line seen at all → null, not zero: "nothing reported yet"
    // and "zero new" are different facts.
    expect(deriveStatus({ ...base, logText: 'bezig…' }).newItems).toBeNull()
  })

  it('filters SDK noise out of the tail — hundreds of AFC warnings per step', () => {
    const noise = 'Direct use of automatic function calling (AFC) in Models.generate_content is not recommended.'
    const log = ['[t] → 74_analyse.py --event x --archive stories --max-dim 0', noise, noise].join('\n')
    const s = deriveStatus({ ...base, logText: log })
    expect(s.lastLine).toContain('74_analyse.py')
    expect(s.logTail.some((l) => l.includes('AFC'))).toBe(false)
  })

  it('derives the current step from the last "→ script" line', () => {
    const log = [
      '[t] verversronde start — lowlands-2026, nieuwe posts sinds 2026-08-18',
      '[t] → 62_stories_archive.py --event lowlands-2026',
      '[t] → 74_analyse.py --event lowlands-2026 --archive ig-posts --max-dim 0',
    ].join('\n')
    const s = deriveStatus({ ...base, lockPid: 9, pidAlive: true, logText: log })
    expect(s.currentStep).toEqual({ index: 7, total: 13, label: 'analyse: Instagram-posts' })
    expect(s.lastLine).toContain('74_analyse.py')
    expect(deriveStatus(base).currentStep).toBeNull()
  })
})

// THE LIST AND THE SCRIPT MUST NOT DRIFT.
//
// deriveStatus recognises a step by matching its "→ script" log line against a
// hard-coded list. A step added to the runner and not to the list is invisible:
// the caption freezes on the step before it and the button reads as hung for
// however long the new step takes. That is not hypothetical — the upload step
// was added to the runner in this change set, and on a first run it is the
// slowest step in the round.
//
// So rather than asserting a number, this reads the actual shell script and
// asserts the list covers every step it runs, in the same order.
const RUNNER = import.meta.glob('../../../../../tools/stelz_brand_watch/79_verversronde.sh', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

describe('the step list matches 79_verversronde.sh', () => {
  const script = Object.values(RUNNER)[0]

  it('finds the runner script at all', () => {
    expect(script, 'runner script not found — has it moved?').toBeTruthy()
  })

  it('recognises every step the script runs, in order', () => {
    // The analysis step is INDENTED inside `for archief in …; do`, so it is one
    // line in the file and four steps in the round. Expanding it here is the
    // difference between testing the script and testing a regex — the first
    // version of this test matched at column 0, found 9 of 13, and passed a
    // total that agreed with nothing.
    const loop = script.match(/for archief in ([^;]+); do/)
    const archives = (loop?.[1] ?? '').trim().split(/\s+/).filter(Boolean)
    expect(archives, 'the archive loop is gone or reshaped').toHaveLength(4)

    const invocations = [...script.matchAll(/^[ \t]*step (\S+\.py)(.*)$/gm)]
      .flatMap((m) => (m[2].includes('"$archief"')
        ? archives.map((a) => m[2].replace('"$archief"', a))
        : [m[2]]).map((tail) => `[2026-08-25T14:00:00] → ${m[1]}${tail}`))
    expect(invocations.length, 'no step lines parsed out of the script')
      .toBeGreaterThan(10)

    const log = [
      '[2026-08-25T13:59:00] verversronde start — lowlands-2026',
      ...invocations,
    ].join('\n')
    const s = deriveStatus({
      lockPid: 4242, pidAlive: true, logText: log, fixtureMtime: null,
    })

    // The LAST step the script runs must be the LAST step the list knows, and
    // the totals must agree: that is true only when the list covers all of them.
    expect(s.currentStep).not.toBeNull()
    expect(s.currentStep!.total).toBe(invocations.length)
    expect(s.currentStep!.index).toBe(invocations.length)
  })

  it('names the upload step, so the round can be watched to the end', () => {
    const s = deriveStatus({
      lockPid: 1, pidAlive: true, fixtureMtime: null,
      logText: '[2026-08-25T14:00:00] → 78_upload_event.py --event lowlands-2026 --if-authed',
    })
    expect(s.currentStep?.label).toBe('naar productie uploaden')
  })
})

// The round's last step uploads to production, and the credentials for it come
// out of a request body a browser sent. Two things have to hold: a body that
// does not carry a real credential yields null rather than something that gets
// written to disk as one, and null is treated as "this round stays local"
// rather than as a failure — signing in is optional, the harvest is not.
describe('parseAuthBody', () => {
  it('takes a well-formed pair', () => {
    expect(parseAuthBody('{"refreshToken":"rt-abc","apiKey":"AIza-xyz"}'))
      .toEqual({ refreshToken: 'rt-abc', apiKey: 'AIza-xyz' })
  })

  it('drops everything to null rather than half a credential', () => {
    // A signed-out click: the button posts {} on purpose.
    expect(parseAuthBody('{}')).toBeNull()
    expect(parseAuthBody('')).toBeNull()
    // Half a pair is not a credential — 78 would fail on it a scrape later.
    expect(parseAuthBody('{"refreshToken":"rt-abc"}')).toBeNull()
    expect(parseAuthBody('{"apiKey":"AIza-xyz"}')).toBeNull()
    // Empty strings are present-but-useless, and read as truthy to a naive check.
    expect(parseAuthBody('{"refreshToken":"","apiKey":"AIza-xyz"}')).toBeNull()
    expect(parseAuthBody('{"refreshToken":"rt-abc","apiKey":""}')).toBeNull()
  })

  it('survives a body that is not what it claims', () => {
    expect(parseAuthBody('not json at all')).toBeNull()
    expect(parseAuthBody('null')).toBeNull()
    expect(parseAuthBody('[1,2,3]')).toBeNull()
    expect(parseAuthBody('{"refreshToken":42,"apiKey":"AIza-xyz"}')).toBeNull()
  })

  it('ignores anything else the body carries', () => {
    // Extra fields are not a reason to refuse; only the two matter.
    expect(parseAuthBody('{"refreshToken":"r","apiKey":"k","uid":"u","evil":true}'))
      .toEqual({ refreshToken: 'r', apiKey: 'k' })
  })
})

describe('authPath', () => {
  it('is the file 78_upload_event.py looks for by default', () => {
    // The tool builds this name independently (token_file_for). If either side
    // is renamed alone the upload silently never authenticates, and the round
    // reports a clean, local-only success — the exact failure mode this whole
    // change set exists to remove.
    expect(authPath('/x/.tmp', 'lowlands-2026')).toBe('/x/.tmp/scrape-auth-lowlands-2026.json')
  })

  it('sits beside the round it belongs to', () => {
    expect(authPath('/x/.tmp', 'lowlands-2026')).not.toBe(lockPath('/x/.tmp', 'lowlands-2026'))
    expect(authPath('/x/.tmp', 'lowlands-2026')).not.toBe(logPath('/x/.tmp', 'lowlands-2026'))
  })
})
