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

export async function adminRequest(path, { method = 'GET', body, signal } = {}) {
  const res = await apiFetch(`${API_BASE}/api/v1/admin${path}`, {
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
  const res = await apiFetch(`${API_BASE}/api/v1/admin${path}`, {
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
  const res = await apiFetch(`${API_BASE}/api/v1/templates${path}`, {
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
  const res = await apiFetch(`${API_BASE}/api/v1/templates${path}`, {
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
