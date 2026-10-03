// Authenticated identity helpers (moved from App.jsx during STAGE 5).
// Session shape: { email, name, avatarUrl, id } — name/avatar come from the
// authenticated profile (GET /api/v1/auth/me, enriched server-side from the
// same store register/login use). Nothing is hardcoded; when the provider
// has no name, the email local-part is prettified as a last resort.

export function displayNameOf(session) {
  const n = (session?.name ?? '').trim()
  if (n) return n
  const local = (session?.email ?? '').split('@')[0] ?? ''
  const words = local.split(/[._\-+]+/).filter(Boolean)
  if (words.length === 0) return session?.email ? session.email : 'Student'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function firstNameOf(session) {
  return displayNameOf(session).split(/\s+/)[0] ?? 'there'
}

export function initialsOf(name, email) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1 && parts[0][0]) return parts[0][0].toUpperCase()
  const c = (email ?? '').trim().charAt(0)
  return (c || 'S').toUpperCase()
}
