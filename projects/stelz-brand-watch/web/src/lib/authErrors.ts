// Firebase Auth-codes naar iets dat een mens kan lezen.
//
// Losgetrokken van de provider in lib/auth.tsx: dat bestand exporteert een
// component, en een component-bestand met iets anders erin kost Fast Refresh.

// Friendly error mapper for Firebase Auth codes
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? ''
  switch (code) {
    case 'auth/invalid-email': return 'Invalid email address.'
    case 'auth/user-not-found': return 'No account with that email.'
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Email or password is incorrect.'
    case 'auth/email-already-in-use': return 'An account with this email already exists.'
    case 'auth/weak-password': return 'Password must be at least 6 characters.'
    case 'auth/popup-closed-by-user': return 'Sign-in cancelled.'
    case 'auth/network-request-failed': return 'Network error. Check your connection.'
    case 'auth/too-many-requests': return 'Too many attempts. Try again later.'
    default: return (err as { message?: string })?.message ?? 'Sign-in failed.'
  }
}
