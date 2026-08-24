// De context en de hook, los van de provider.
//
// Ze stonden in lib/auth.tsx, dat ook een component exporteert. Een
// bestand met beide kost Fast Refresh: elke bewerking herlaadt de pagina in
// plaats van het component te verversen. De provider importeert de context
// hiervandaan, dus er is nog steeds precies een van.

import { createContext, useContext } from 'react'
import type { User } from 'firebase/auth'

export type AuthState = {
  user: User | null
  loading: boolean
  signInGoogle: () => Promise<User>
  signInEmail: (email: string, password: string) => Promise<User>
  signUpEmail: (email: string, password: string) => Promise<User>
  signOut: () => Promise<void>
  getIdToken: () => Promise<string | null>
}

export const AuthCtx = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
