import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/authContext'
import { authErrorMessage } from '../lib/authErrors'
import { AuthShell, GoogleButton } from './Login'

export default function Signup() {
  const { user, loading, signInGoogle } = useAuth()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && user) nav('/onboarding', { replace: true })
  }, [loading, user, nav])

  async function onGoogle() {
    setBusy(true); setErr(null)
    try { await signInGoogle() }
    catch (e) { setErr(authErrorMessage(e)); setBusy(false) }
  }

  return (
    <AuthShell mode="signup">
      <div className="mb-10">
        <h1 className="text-[28px] font-medium tracking-tight leading-[1.15] mb-2">
          Start your<br />free trial.
        </h1>
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          14 days, no credit card. Set up your brand in 5 minutes.
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
        Already have an account? <a className="text-[var(--color-ink)] underline" href="/login">Sign in</a>.
        <br />
        By continuing you agree to our{' '}
        <a className="text-[var(--color-ink)] underline" href="/terms">Terms</a> and{' '}
        <a className="text-[var(--color-ink)] underline" href="/privacy">Privacy Policy</a>.
      </div>
    </AuthShell>
  )
}
