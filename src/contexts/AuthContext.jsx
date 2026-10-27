import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'
import { API_BASE, apiFetch, clearAuthToken, setAuthHooks, setAuthToken } from '../services/api.js'
import { authReducer, createInitialAuthState } from './authMachine.js'

// Single source of truth for frontend authentication. Every component reads
// status/user/actions from here — nothing maintains its own "logged in"
// notion, token copy, or /me bootstrap.
//
// Lifecycle: mount → GET /auth/me (cookie rides via credentials:include) →
// authenticated | unauthenticated | error. Only a genuine 401 moves state
// toward unauthenticated; network/5xx never clear a session.

const AuthContext = createContext(null)

async function readJsonSafe(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

function userFromMe(data) {
  const u = data?.user
  if (!u?.email) return null
  return {
    email: u.email,
    name: u.name ?? '',
    avatarUrl: u.avatarUrl ?? '',
    id: u.sub ?? u.id ?? '',
    // STAGE 3: persisted role/scope comes from /auth/me (MongoDB), never from
    // a JWT claim or a client-supplied value. UI affordances use these fields;
    // the API still enforces every permission server-side.
    role: ['user', 'college_admin', 'platform_admin'].includes(u.role) ? u.role : 'user',
    collegeAdminOf: Array.isArray(u.collegeAdminOf) ? u.collegeAdminOf.map(String) : [],
    tenantIds: Array.isArray(u.tenantIds) ? u.tenantIds.map(String) : [],
    preferences: u.preferences ?? null,
  }
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, undefined, createInitialAuthState)

  const refreshSession = useCallback(async () => {
    // Reconcile with the server without disturbing UI state on transport
    // failures: only a genuine 401 clears the session (via BOOT_NO_SESSION).
    // reconcileAuth:false — the verdict mapping below owns the transition.
    let res
    try {
      res = await apiFetch(`${API_BASE}/api/v1/auth/me`, { reconcileAuth: false })
    } catch (err) {
      dispatch({ type: 'TRANSPORT_ERROR', error: { type: 'network', message: err?.message ?? String(err) } })
      return null
    }
    if (res.ok) {
      const data = await readJsonSafe(res)
      const user = userFromMe(data)
      if (user) {
        dispatch({ type: 'BOOT_OK', user })
        return user
      }
      dispatch({ type: 'BOOT_NO_SESSION' })
      return null
    }
    if (res.status === 401) {
      dispatch({ type: 'BOOT_NO_SESSION' })
      return null
    }
    const data = await readJsonSafe(res)
    dispatch({
      type: 'TRANSPORT_ERROR',
      error: { type: 'server', status: res.status, message: data?.error ?? `Request failed (${res.status})` },
    })
    return null
  }, [])

  // Central 401 reconciliation for every canonical-client request: a live
  // 401 means the session died server-side. Transport failures are ignored
  // here by construction (apiFetch only calls this hook on HTTP 401).
  useEffect(() => {
    setAuthHooks({
      onUnauthorized: () => dispatch({ type: 'UNAUTHORIZED' }),
    })
    return () => setAuthHooks({ onUnauthorized: null })
  }, [])

  // Single bootstrap on mount — exactly one /me, before any protected fetch.
  useEffect(() => {
    let alive = true
    ;(async () => {
      let res
      try {
        res = await apiFetch(`${API_BASE}/api/v1/auth/me`, { reconcileAuth: false })
      } catch (err) {
        if (alive) dispatch({ type: 'BOOT_TRANSPORT_ERROR', error: { type: 'network', message: err?.message ?? String(err) } })
        return
      }
      if (!alive) return
      if (res.ok) {
        const data = await readJsonSafe(res)
        const user = userFromMe(data)
        dispatch(user ? { type: 'BOOT_OK', user } : { type: 'BOOT_NO_SESSION' })
      } else if (res.status === 401) {
        dispatch({ type: 'BOOT_NO_SESSION' })
      } else {
        const data = await readJsonSafe(res)
        dispatch({
          type: 'BOOT_TRANSPORT_ERROR',
          error: { type: 'server', status: res.status, message: data?.error ?? `Request failed (${res.status})` },
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const login = useCallback(async ({ email, password }) => {
    const res = await apiFetch(`${API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      reconcileAuth: false,
    })
    const data = await readJsonSafe(res)
    if (!res.ok) throw new Error(data?.error ?? "Couldn't log you in. Please try again.")
    // Token first (memory Bearer for API use), then the authoritative
    // profile from /me — the form identity is never trusted for display.
    // The httpOnly cookie set by this response is what survives refresh.
    if (data?.token) setAuthToken(data.token)
    const me = await apiFetch(`${API_BASE}/api/v1/auth/me`, { reconcileAuth: false })
    if (me.ok) {
      const meData = await readJsonSafe(me)
      const user = userFromMe(meData) ?? { email, name: '', avatarUrl: '', id: '' }
      dispatch({ type: 'LOGIN_OK', user })
      return user
    }
    if (me.status === 401) {
      dispatch({ type: 'BOOT_NO_SESSION' })
      throw new Error('Login succeeded but the session was rejected. Please try again.')
    }
    // Session cookie almost certainly set (login 200) but /me hit a
    // transport/server failure: keep the login, surface a retryable error.
    const user = { email, name: '', avatarUrl: '', id: '' }
    dispatch({ type: 'LOGIN_OK', user })
    return user
  }, [])

  const register = useCallback(async ({ email, password, name }) => {
    const res = await apiFetch(`${API_BASE}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      reconcileAuth: false,
    })
    const data = await readJsonSafe(res)
    if (!res.ok) throw new Error(data?.error ?? "Couldn't create the account. Please try again.")
    if (data?.token) setAuthToken(data.token)
    const me = await apiFetch(`${API_BASE}/api/v1/auth/me`, { reconcileAuth: false })
    if (me.ok) {
      const meData = await readJsonSafe(me)
      const user = userFromMe(meData) ?? { email, name: name ?? '', avatarUrl: '', id: '' }
      dispatch({ type: 'LOGIN_OK', user })
      return user
    }
    const user = { email, name: name ?? '', avatarUrl: '', id: '' }
    dispatch({ type: 'LOGIN_OK', user })
    return user
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiFetch(`${API_BASE}/api/v1/auth/logout`, { method: 'POST', reconcileAuth: false })
    } catch {
      // Cookie may already be gone — clearing local state is what matters.
    }
    clearAuthToken()
    dispatch({ type: 'LOGOUT_OK' })
  }, [])

  const value = useMemo(
    () => ({
      status: state.status,
      user: state.user,
      error: state.error,
      initialized: state.initialized,
      isAuthenticated: state.status === 'authenticated',
      isLoading: state.status === 'loading',
      login,
      register,
      logout,
      refreshSession,
    }),
    [state, login, register, logout, refreshSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
