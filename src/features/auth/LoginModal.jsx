import { useState } from 'react'
import { Button, Field, ModalShell, inputCls } from '../../components/ui.jsx'
import { useAuth } from '../../contexts/AuthContext.jsx'

export function LoginModal({ onClose, onSuccess }) {
  const auth = useAuth()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // AuthContext owns the whole flow: server call, Bearer store, cookie
      // session, and the authoritative /me profile. No token plumbing here.
      const user =
        mode === 'register'
          ? await auth.register({ email, password, name })
          : await auth.login({ email, password })
      onSuccess(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title={mode === 'login' ? 'Welcome back' : 'Create your account'}
      subtitle={mode === 'login' ? 'Log in to generate and manage practicals.' : 'One account for all your practicals and templates.'}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }} className="text-[13px] font-semibold text-pine-800 hover:underline">
            {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
          </button>
          <Button onClick={() => document.getElementById('login-form')?.requestSubmit()} disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Register'}
          </Button>
        </div>
      }
    >
      <form id="login-form" onSubmit={submit} className="flex flex-col gap-3">
        {mode === 'register' && (
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputCls} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@college.edu" className={inputCls} autoComplete="email" />
        </Field>
        <Field label="Password" hint="Minimum 8 characters.">
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className={inputCls} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </Field>
        {error && <p className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[13px] font-medium text-[#8F1D17]">{error}</p>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1}>submit</button>
      </form>
    </ModalShell>
  )
}
