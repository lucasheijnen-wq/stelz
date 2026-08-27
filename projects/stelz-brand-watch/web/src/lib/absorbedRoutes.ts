// Where the two absorbed tabs went, and what happens to the query behind them.
//
// /lowlands named a single festival in a route. /campagne showed the same three
// surfaces with no event attached, and therefore no period. Both are now
// /evenementen/:eventId.
//
// WHY THIS IS NOT IN OLD_ROUTE_REDIRECTS. That map is a plain string table and
// <Navigate to="/x"> drops everything after the '?'. These two routes carry
// query state that is not decoration: `?preview=campaign` WAS the only way to
// open the local fixture (it is the dev default now, but old bookmarks still
// carry the parameter and `?preview=off` still means something), and
// `?bron=discovery` is a bookmark someone made to one half of the data. A
// redirect that silently discards either one looks like the page lost its
// contents rather than moved.
//
// Pure, and in lib/ rather than inline in App.tsx, so the mapping can be tested
// without mounting a router.

export type AbsorbedRoute = {
  path: string
  to: string
  /** Rewrites the query in place. Omitted where it carries over unchanged. */
  map?: (p: URLSearchParams) => void
}

export const ABSORBED_ROUTES: AbsorbedRoute[] = [
  { path: '/lowlands', to: '/evenementen/lowlands-2026' },
  // /stories showed the same 348 stories the event page shows under its Stories
  // tab, minus everything that makes them mean something: no period, so a story
  // from July sat beside one from the festival, and no roster split, so a
  // stranger's story and a booked creator's read identically. One screen for
  // one surface is worth less than that surface inside the event it belongs to.
  //
  // ?preview=stories carries over, so the bookmark that opens the local fixture
  // still opens it — it just lands on the tab now.
  {
    path: '/stories',
    to: '/evenementen/lowlands-2026',
    map: (p) => p.set('tab', 'stories'),
  },
  {
    path: '/campagne',
    to: '/evenementen/lowlands-2026',
    // ?bron=roster|discovery became ?tab=roster|discovery. 'all' has no
    // equivalent and is dropped: an event's two halves are never one total, so
    // the tab that showed both no longer exists.
    map: (p) => {
      const bron = p.get('bron')
      p.delete('bron')
      if (bron === 'roster' || bron === 'discovery') p.set('tab', bron)
    },
  },
]

/** The destination for one of these routes, query included. */
export function absorbedTarget(route: AbsorbedRoute, search: string): string {
  const next = new URLSearchParams(search)
  route.map?.(next)
  const qs = next.toString()
  return qs ? `${route.to}?${qs}` : route.to
}
