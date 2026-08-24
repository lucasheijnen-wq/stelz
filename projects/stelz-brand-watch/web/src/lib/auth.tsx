import { useEffect, useState, type ReactNode } from 'react'
import { AuthCtx } from './authContext'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth'
import { fbAuth } from './firebase'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const off = onAuthStateChanged(fbAuth, (u) => {
      setUser(u)
      setLoading(false)
    })
    return off
  }, [])

  const signInGoogle = async () => {
    const provider = new GoogleAuthProvider()
    const { user } = await signInWithPopup(fbAuth, provider)
    return user
  }
  const signInEmail = async (email: string, password: string) => {
    const { user } = await signInWithEmailAndPassword(fbAuth, email, password)
    return user
  }
  const signUpEmail = async (email: string, password: string) => {
    const { user } = await createUserWithEmailAndPassword(fbAuth, email, password)
    return user
  }
  const signOut = async () => {
    await fbSignOut(fbAuth)
  }
  const getIdToken = async () => {
    if (!fbAuth.currentUser) return null
    return fbAuth.currentUser.getIdToken()
  }

  return (
    <AuthCtx.Provider value={{ user, loading, signInGoogle, signInEmail, signUpEmail, signOut, getIdToken }}>
      {children}
    </AuthCtx.Provider>
  )
}

