import { API_BASE, apiFetch, authHeaders } from '../../services/api.js'

// STAGE 3 admin/template UI transport. Authorization is always decided by the
// API; these helpers only keep error handling consistent across the new views.

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
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

// The Vercel reverse proxy does not match trailing-slash URLs
// (/api/v1/templates/ 404s at the edge), while Express and the Vite dev proxy
// treat "/api/v1/templates" and "/api/v1/templates/" identically — so callers
// have no way to notice. Strip any bare trailing slash here, once, so every
// request these helpers build is safe behind both hosts.
function normalizeApiUrl(url) {
  const queryIndex = url.indexOf('?')
  if (queryIndex >= 0) {
    return `${url.slice(0, queryIndex).replace(/\/+$/, '')}${url.slice(queryIndex)}`;
  }
  return url.replace(/\/+$/, '');
}

export async function adminRequest(path, { method = 'GET', body, signal } = {}) {
  const res = await apiFetch(normalizeApiUrl(`${API_BASE}/api/v1/admin${path}`), {
    method,
    headers: body === undefined ? authHeaders() : authHeaders({ 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const data = await readJson(res)
  if (!res.ok) throw new ApiError(data?.error ?? 'The request failed. Please try again.', res.status)
  return data
}

export async function adminUpload(path, formData, { signal } = {}) {
  const res = await apiFetch(normalizeApiUrl(`${API_BASE}/api/v1/admin${path}`), {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
    signal: signal ?? AbortSignal.timeout(60000),
  })
  const data = await readJson(res)
  if (!res.ok) throw new ApiError(data?.error ?? 'The upload failed. Please try again.', res.status)
  return data
}

export async function templateRequest(path, { method = 'GET', body, signal } = {}) {
  const res = await apiFetch(normalizeApiUrl(`${API_BASE}/api/v1/templates${path}`), {
    method,
    headers: body === undefined ? authHeaders() : authHeaders({ 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60000),
  })
  const data = await readJson(res)
  if (!res.ok) throw new ApiError(data?.error ?? 'The request failed. Please try again.', res.status)
  return data
}

export async function templateUpload(path, formData, { signal } = {}) {
  const res = await apiFetch(normalizeApiUrl(`${API_BASE}/api/v1/templates${path}`), {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
    signal: signal ?? AbortSignal.timeout(120000),
  })
  const data = await readJson(res)
  if (!res.ok) throw new ApiError(data?.error ?? 'The import failed. Please try again.', res.status)
  return data
}

export function describeApiError(err) {
  if (err?.status === 401) return 'Please log in again to continue.'
  if (err?.status === 403) return 'You do not have permission to perform that action.'
  if (err?.status === 404) return 'That item is no longer available. Refresh and try again.'
  if (err?.status === 409) return err.message || 'That value is already in use.'
  return err instanceof Error ? err.message : String(err)
}
