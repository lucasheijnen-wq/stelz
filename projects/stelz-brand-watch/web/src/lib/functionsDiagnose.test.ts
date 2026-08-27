// The three verdicts a failed Cloud Functions POST can get, and why each says
// what it says.
//
// The rule under test is negative as much as positive: the message may only
// claim what the probes PROVED. The first version of this message guessed
// "waarschijnlijk niet uitgerold", and the third time it fired the guess was
// wrong — the function existed and the message sent an entire debugging
// session toward a deploy that was not the problem. So: the 'readable' branch
// must never mention deploying, and the 'blocked' branch must, because there
// the 404-without-CORS signature actually establishes it.
import { describe, expect, it } from 'vitest'
import { diagnoseUnreachable } from './functionsDiagnose'

describe('diagnoseUnreachable', () => {
  it('readable: the function exists — say the POST broke off, and that a started scan survives it', () => {
    const msg = diagnoseUnreachable('api_step_creators', 'readable')
    expect(msg).toContain('api_step_creators')
    expect(msg).toContain('bestaat en antwoordt')
    // The scan keeps running server-side after the connection drops; the
    // message must point at the progress stream instead of implying failure.
    expect(msg).toContain('loopt hij op de server gewoon door')
    // And it must NOT resurrect the old wrong guess.
    expect(msg).not.toContain('uitgerold')
  })

  it('blocked: a server answered unreadably — that IS the not-deployed signature', () => {
    const msg = diagnoseUnreachable('api_import_event', 'blocked')
    expect(msg).toContain('api_import_event')
    expect(msg).toContain('bestaat niet in productie')
    expect(msg).toContain('functions-deploy')
  })

  it('down: nothing answered — no network, and no speculation beyond that', () => {
    const msg = diagnoseUnreachable('api_step_stories', 'down')
    expect(msg).toContain('geen netwerkverbinding')
    expect(msg).not.toContain('uitgerold')
  })

  it('every verdict names the function, so parallel steps stay tellable apart', () => {
    for (const probe of ['readable', 'blocked', 'down'] as const) {
      expect(diagnoseUnreachable('api_step_srs', probe)).toContain('api_step_srs')
    }
  })
})
