import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, Route, Routes, Navigate, useLocation } from 'react-router-dom'
import { InboxBell } from './components/InboxBell'
import { ScanProgressLine } from './components/ScanPanel'
import { fbSubscribeScanState, type ScanState } from './lib/firestore'
import { useAuth } from './lib/authContext'
import Home from './pages/Home'
import Creator from './pages/Creator'
import Sounds from './pages/Sounds'
import { useMembership } from './lib/membershipContext'
import { ABSORBED_ROUTES, absorbedTarget, type AbsorbedRoute } from './lib/absorbedRoutes'
import Costs from './pages/Costs'
import ProjectPage from './pages/Project'
import EventsPage from './pages/Events'
import EventPage from './pages/Event'
import Settings from './pages/Settings'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Terms from './pages/Terms'
import Privacy from './pages/Privacy'
import { useResetOn } from './lib/useResetOn'

// Primary routes:
//   /              Home (tabs: Dashboard · Feed · Review · Creators)
//   /evenementen   Festivals and activations: the list, and adding one
//   /evenementen/:eventId
//                  One event — roster, organic pickup, stories, settings.
//                  Absorbed /campagne, which showed the same three surfaces
//                  with no period at all.
//   /sounds(/:key) Sound leaderboard + drill-down
//   /creators/:id  Creator detail
//   /projects/:id  Project detail (tracked creator groups)
//   /settings      Settings
//   /login + /signup + /landing  Public auth + marketing
//   /terms /privacy              Static legal (no nav)

// adminOnly: hidden from read-only viewers. For /kosten that is discretion
// rather than access control — firestore.rules is what actually closes the
// usage collection (see the `usage` match there).
const NAV: { to: string; label: string; matchPrefix?: string; adminOnly?: boolean }[] = [
  // matchPrefix '/projects': a project roster is reached from an event's
  // settings, so Home keeps the lamp on rather than leaving it nowhere. It sat
  // on the Lowlands tab, which no longer exists.
  { to: '/', label: 'Home', matchPrefix: '/projects' },
  // Two tabs became one. "Lowlands" named a single festival in a route, and
  // "Campagne" was the same three surfaces with no event attached — so the
  // event page is both.
  { to: '/evenementen', label: 'Evenementen', matchPrefix: '/evenementen' },
  // Stories was a third tab for one surface of one event. It is now a tab
  // INSIDE that event, where it has a period and a roster split — see
  // ABSORBED_ROUTES. /stories still resolves; it just lands there.
  { to: '/sounds', label: 'Sounds', matchPrefix: '/sounds' },
  { to: '/kosten', label: 'Kosten', matchPrefix: '/kosten', adminOnly: true },
  { to: '/settings', label: 'Settings' },
]

const OLD_ROUTE_REDIRECTS: Record<string, string> = {
  '/today': '/',
  '/feed': '/',
  '/dashboard': '/',
  '/highlights': '/',
  '/reports': '/',
  '/outreach': '/',
  '/discover': '/',
  '/welcome': '/',
  '/checkout': '/settings',
  '/accept-invite': '/',
  '/onboarding': '/settings',
}

function KeepQuery({ route }: { route: AbsorbedRoute }) {
  const { search } = useLocation()
  return <Navigate to={absorbedTarget(route, search)} replace />
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/landing" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />

      {/* Legacy redirects (so old bookmarks don't 404) */}
      {Object.entries(OLD_ROUTE_REDIRECTS).map(([from, to]) => (
        <Route key={from} path={from} element={<Navigate to={to} replace />} />
      ))}
      {/* Absorbed tabs. Separate from the table above because these keep their
          querystring — see lib/absorbedRoutes. */}
      {ABSORBED_ROUTES.map((r) => (
        <Route key={r.path} path={r.path} element={<KeepQuery route={r} />} />
      ))}

      {/* App (protected) */}
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<Home />} />
        <Route path="/creators/:handle" element={<Creator />} />
        <Route path="/kosten" element={<Costs />} />
        <Route path="/sounds" element={<Sounds />} />
        <Route path="/sounds/:soundKey" element={<Sounds />} />
        <Route path="/evenementen" element={<EventsPage />} />
        <Route path="/evenementen/:eventId" element={<EventPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-[12px] text-[var(--color-ink-subtle)]">Loading…</div>
  }
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return <>{children}</>
}

function AppLayout() {
  const { pathname } = useLocation()
  const { canWrite } = useMembership()
  const [navOpen, setNavOpen] = useState(false)
  // Closes on navigation. During render, not in an effect: as an effect the
  // new page painted once with the menu still covering it before closing.
  useResetOn(pathname, () => setNavOpen(false))

  // Scan state at layout level so the mobile bar can show progress from any
  // page — below the sm breakpoint there was previously no scan signal at all.
  const [scan, setScan] = useState<ScanState | null>(null)
  useEffect(() => fbSubscribeScanState(setScan), [])

  return (
    <div className="min-h-screen flex relative">
      {/* Mobile top bar — navy, like the Stelz announcement bar */}
      <div className="lg:hidden fixed top-0 inset-x-0 h-12 z-30 bg-[var(--color-ink)] flex items-center px-4 justify-between">
        <ScanProgressLine scan={scan} />
        <button onClick={() => setNavOpen((v) => !v)} className="w-8 h-8 flex items-center justify-center -ml-2">
          <span className="block w-4 h-px bg-white relative before:content-[''] before:absolute before:w-4 before:h-px before:bg-white before:-top-1.5 after:content-[''] after:absolute after:w-4 after:h-px after:bg-white after:top-1.5"></span>
        </button>
        <SidebarLogo />
        <div className="text-white"><InboxBell /></div>
      </div>

      {navOpen && <div className="lg:hidden fixed inset-0 bg-black/20 z-30" onClick={() => setNavOpen(false)} />}

      {/* Navy sidebar — the Stelz hero panel */}
      <aside
        className={`fixed lg:sticky top-0 left-0 h-screen w-60 shrink-0 bg-[var(--color-ink)] text-white flex flex-col z-40 transition-transform lg:transition-none ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0`}
      >
        <div className="h-16 flex items-center justify-between px-5 border-b border-white/10">
          <SidebarLogo />
          <div className="hidden lg:block text-white">
            <InboxBell />
          </div>
        </div>

        <BrandSwitcher />

        <nav className="flex-1 py-3 overflow-y-auto">
          {NAV.filter((n) => !n.adminOnly || canWrite).map((n) => {
            const active = pathname === n.to || (n.matchPrefix && pathname.startsWith(n.matchPrefix))
            return (
              <NavLink
                key={n.to}
                to={n.to}
                className={`block px-5 py-2.5 text-[12px] uppercase tracking-[0.08em] font-medium border-l-2 transition-colors ${
                  active
                    ? 'border-[var(--color-accent)] bg-white/5 text-white'
                    : 'border-transparent text-white/55 hover:text-white'
                }`}
              >
                {n.label}
              </NavLink>
            )
          })}
        </nav>

        <UserStrip />
      </aside>

      <main className="flex-1 min-w-0 pt-12 lg:pt-0">
        <Outlet />
      </main>
    </div>
  )
}

function SidebarLogo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="w-9 h-9 rounded-full bg-white flex items-center justify-center shrink-0">
        <img src="/stelz-logo.png" alt="" className="w-7 h-7 object-contain" />
      </span>
      <span className="stelz-display text-[15px] text-white leading-none">Stëlz</span>
    </span>
  )
}

function BrandSwitcher() {
  return (
    <div className="px-5 py-4 border-b border-white/10">
      <div className="text-[9px] uppercase tracking-widest text-[var(--color-accent)] font-medium mb-1.5">Community Watch</div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-white">Stëlz Hard Drinks</span>
      </div>
    </div>
  )
}

function UserStrip() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  return (
    <div className="px-5 py-3 border-t border-white/10 relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[11px] text-white/50 hover:text-white"
      >
        <span className="truncate text-left">{user?.email ?? '—'}</span>
        <span className="ml-2">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-3 right-3 mb-1 z-20 bg-[var(--color-surface)] border border-[var(--color-border-strong)]">
            <button
              onClick={async () => { setOpen(false); await signOut(); window.location.href = '/login' }}
              className="w-full px-3 py-2 text-left text-[12px] hover:bg-[var(--color-bg)]"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
