import { API_BASE, apiFetch, authHeaders } from '../../services/api.js'

// STAGE 4 preferences transport. The API always derives the owner from the
// authenticated session, so these helpers never send a user id.

export class PreferencesApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'PreferencesApiError'
    this.status = status
  }
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

async function preferencesRequest(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(`${API_BASE}/api/v1/preferences${path}`, {
    method,
    headers: body === undefined ? authHeaders() : authHeaders({ 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const data = await readJson(res)
  if (!res.ok) {
    throw new PreferencesApiError(
      data?.error ?? 'The preferences request failed. Please try again.',
      res.status,
    )
  }
  return data
}

export function fetchPreferences() {
  return preferencesRequest('/')
}

export function fetchPreferenceOptions() {
  return preferencesRequest('/options')
}

export function savePreferences(payload) {
  return preferencesRequest('/', { method: 'PUT', body: payload })
}

export function describePreferencesError(err) {
  if (err?.status === 401) return 'Please log in again to continue.'
  if (err?.status === 403) return 'You do not have permission to change these preferences.'
  if (err?.status === 503) return 'Preferences are temporarily unavailable. Please try again.'
  return err instanceof Error ? err.message : String(err)
}
