import { apiFetch, authHeaders } from '../../services/api.js'

// STAGE 5 document transport. Every call goes through the canonical API client
// so cookie/Bearer handling and the central 401 reconciliation stay in one
// place. Errors carry the HTTP status/code so the studio can distinguish a
// stale revision (409) from a failed save (5xx/network).

function documentError(data, status, fallback) {
  const error = new Error(data?.error ?? fallback)
  error.status = status
  if (data?.code) error.code = data.code
  if (Number.isInteger(data?.revision)) error.revision = data.revision
  return error
}

export async function fetchAssignmentDocument({ apiBase, recordId, signal }) {
  const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/document`, {
    headers: authHeaders(),
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw documentError(data, res.status, "Couldn't load this document. Please try again.")
  return data.document
}

export async function saveAssignmentDocument({
  apiBase,
  recordId,
  revision,
  schemaVersion,
  blocks,
  signal,
}) {
  const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/document`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ revision, schemaVersion, blocks }),
    signal: signal ?? AbortSignal.timeout(60000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw documentError(data, res.status, "Couldn't save the document. Your edits are still here.")
  return data.document
}

export function describeDocumentError(error) {
  if (error?.status === 401) return 'Please log in to continue — then retry.'
  if (error?.status === 404) return 'This assignment was removed. Close the editor and refresh the board.'
  if (error?.status === 409) {
    return 'Someone else saved a newer version. Your edits are still here; reload the latest version before saving again.'
  }
  return error instanceof Error ? error.message : String(error)
}
