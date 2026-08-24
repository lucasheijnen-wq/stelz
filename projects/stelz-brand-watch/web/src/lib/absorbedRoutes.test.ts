// Old bookmarks, after two tabs became one.
//
// The failure this guards is quiet: <Navigate to="/x"> drops the querystring,
// so a redirect that "works" lands the reader on a page that is missing what
// they came for. On /campagne that is the whole fixture — ?preview=campaign is
// the only way to open it, and a production build contains no link to it.
import { describe, expect, it } from 'vitest'
import { ABSORBED_ROUTES, absorbedTarget } from './absorbedRoutes'

const route = (path: string) => {
  const r = ABSORBED_ROUTES.find((x) => x.path === path)
  if (!r) throw new Error(`no absorbed route for ${path}`)
  return r
}
const go = (path: string, search: string) => absorbedTarget(route(path), search)

describe('the absorbed routes', () => {
  it('all point at an event page', () => {
    for (const r of ABSORBED_ROUTES) {
      expect(r.to, r.path).toMatch(/^\/evenementen\/[a-z0-9-]+$/)
    }
  })

  it('leave a bare URL bare', () => {
    expect(go('/lowlands', '')).toBe('/evenementen/lowlands-2026')
    expect(go('/campagne', '')).toBe('/evenementen/lowlands-2026')
  })
})

describe('the preview flag', () => {
  it('survives both redirects', () => {
    // Without this the local fixture becomes unreachable: the empty state's
    // link is dev-only and the flag is the only other way in.
    expect(go('/campagne', '?preview=campaign')).toBe(
      '/evenementen/lowlands-2026?preview=campaign')
    expect(go('/lowlands', '?preview=campaign')).toBe(
      '/evenementen/lowlands-2026?preview=campaign')
  })

  it('survives alongside other parameters', () => {
    const out = new URL(go('/campagne', '?preview=campaign&c=brittmessing&s=tiktok'),
                        'http://x')
    expect(out.searchParams.get('preview')).toBe('campaign')
    expect(out.searchParams.get('c')).toBe('brittmessing')
    expect(out.searchParams.get('s')).toBe('tiktok')
  })
})

describe('?bron became ?tab', () => {
  it('carries a bookmarked half across', () => {
    expect(go('/campagne', '?bron=discovery')).toBe(
      '/evenementen/lowlands-2026?tab=discovery')
    expect(go('/campagne', '?bron=roster')).toBe(
      '/evenementen/lowlands-2026?tab=roster')
  })

  it('drops ?bron=all, which no longer has a meaning', () => {
    // The old page had an "Alles" tab over both halves. An event's roster and
    // its organic pickup are never one total, so that tab does not exist and
    // the default (roster) is the honest landing place.
    expect(go('/campagne', '?bron=all')).toBe('/evenementen/lowlands-2026')
  })

  it('never leaves the old parameter behind', () => {
    for (const bron of ['roster', 'discovery', 'all', 'onzin']) {
      expect(go('/campagne', `?bron=${bron}`)).not.toContain('bron=')
    }
  })

  it('ignores a value that was never a tab', () => {
    expect(go('/campagne', '?bron=onzin')).toBe('/evenementen/lowlands-2026')
  })

  it('rewrites ?bron only where it existed', () => {
    // /lowlands never took the parameter. Rewriting it there would invent a
    // tab from a query nobody could have typed.
    expect(go('/lowlands', '?bron=discovery')).toContain('bron=discovery')
  })
})

describe('/stories', () => {
  it('lands on the Stories tab of the default event', () => {
    expect(go('/stories', '')).toBe('/evenementen/lowlands-2026?tab=stories')
  })

  it('keeps the preview switch, which is the only way to open the fixture', () => {
    // There is no link to ?preview=stories in a production build, so the
    // bookmark IS the entry point. A redirect that dropped it would look like
    // the page lost its contents rather than moved.
    const out = go('/stories', '?preview=stories')
    expect(out).toContain('preview=stories')
    expect(out).toContain('tab=stories')
  })

  it('overrides a tab the old route could not have meant', () => {
    // /stories showed one surface and nothing else, so ?tab= on it was never
    // meaningful. Landing anywhere but the Stories tab would lose the surface
    // the bookmark was about.
    expect(go('/stories', '?tab=roster')).toContain('tab=stories')
  })
})
