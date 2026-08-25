/// <reference types="node" />
// The scrape endpoints turn a browser URL into a shell argument and two file
// names, and a lock file plus a log into "is it safe to start another paid
// round". This tests the part that decides both — the I/O stays in the vite
// plugin, exactly like preview-paths.ts and its middleware.
import { describe, expect, it } from 'vitest'
import {
  DONE_MARKER, deriveStatus, lockPath, logPath, parseLock, parseRunnerUrl,
} from '../../scrape-runner'

const events = new Set(['lowlands-2026', 'pinkpop-2027'])

describe('parseRunnerUrl', () => {
  it('accepts exactly the events that have a definition', () => {
    expect(parseRunnerUrl('/scrape-run/lowlands-2026', '/scrape-run/', events))
      .toBe('lowlands-2026')
    expect(parseRunnerUrl('/scrape-status/pinkpop-2027', '/scrape-status/', events))
      .toBe('pinkpop-2027')
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
})
