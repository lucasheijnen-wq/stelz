import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/authContext'
import { authErrorMessage } from '../lib/authErrors'
export default function Login() {
  const { user, loading, signInGoogle } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const next = (loc.state as { from?: string } | null)?.from || '/today'
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && user) nav(next, { replace: true })
  }, [loading, user, nav, next])

  async function onGoogle() {
    setBusy(true); setErr(null)
    try { await signInGoogle() }
    catch (e) { setErr(authErrorMessage(e)); setBusy(false) }
  }

  return (
    <AuthShell mode="login">
      <div className="mb-10">
        <h1 className="stelz-display text-[30px] leading-[1.1] mb-2 text-[var(--color-ink)]">
          The Stëlz<br />Community Watch
        </h1>
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          See everywhere Stëlz shows up on Instagram and TikTok.
        </p>
      </div>

      <GoogleButton busy={busy} onClick={onGoogle}>
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </GoogleButton>

      {err && (
        <div className="mt-4 px-3 py-2 border border-[var(--color-bad)] text-[12px] text-[var(--color-bad)]">
          {err}
        </div>
      )}

      <div className="mt-10 pt-6 border-t border-[var(--color-border)] text-[12px] text-[var(--color-ink-subtle)] leading-relaxed">
        New here? <a className="text-[var(--color-ink)] underline" href="/signup">Create an account</a>.
        <br />
        By continuing you agree to our{' '}
        <a className="text-[var(--color-ink)] underline" href="/terms">Terms</a> and{' '}
        <a className="text-[var(--color-ink)] underline" href="/privacy">Privacy Policy</a>.
      </div>
    </AuthShell>
  )
}

// Shared shell — two-column on desktop, hero panel left, form panel right.
export function AuthShell({ children, mode }: { children: ReactNode; mode: 'login' | 'signup' }) {
  return (
    <div className="min-h-screen flex flex-col lg:grid lg:grid-cols-2 bg-[var(--color-bg)]">
      {/* Left: brand panel */}
      <aside className="hidden lg:flex flex-col justify-between p-10 border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <a href="/landing" className="inline-block"><Logo /></a>

        <div className="max-w-md">
          <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
            What you'll see inside
          </div>
          <ul className="space-y-3">
            {[
              ['Live detections', 'AI vision finds Stëlz in IG + TikTok content — even when nobody tags the brand.'],
              ['Creator ranking', 'Six-layer scoring surfaces the creators that actually move Stëlz.'],
              ['Daily briefing', 'Wake up to what changed: new hits, biggest fans, trending sounds.'],
            ].map(([t, d]) => (
              <li key={t} className="border-l-2 border-[var(--color-ink)] pl-3">
                <div className="text-[14px] font-medium">{t}</div>
                <div className="text-[12px] text-[var(--color-ink-muted)] leading-relaxed mt-0.5">{d}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="text-[11px] text-[var(--color-ink-subtle)]">
          © 2026 JackandAI · Built in NL
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden h-14 px-5 border-b border-[var(--color-border)] flex items-center bg-[var(--color-surface)]">
        <a href="/landing"><Logo small /></a>
      </header>

      {/* Right: form panel */}
      <main className="flex-1 flex items-center justify-center px-6 py-12 lg:py-16">
        <div className="w-full max-w-[400px]">
          <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

export function GoogleButton({
  children,
  onClick,
  busy,
}: {
  children: ReactNode
  onClick: () => void
  busy?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center justify-center gap-3 border border-[var(--color-ink)] bg-[var(--color-ink)] text-white px-4 py-3 text-[14px] hover:bg-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <GoogleMark />
      <span>{children}</span>
    </button>
  )
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#FFFFFF" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#FFFFFF" opacity=".9" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FFFFFF" opacity=".75" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#FFFFFF" opacity=".6" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  )
}
