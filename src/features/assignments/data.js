// Assignment domain data + pure helpers (moved from App.jsx in the final
// stage). No JSX, no React — plain constants and functions shared by the
// workspace board, views, drawer, and creation flow.

// Server record -> assignment (keyed by record id so reloads stay consistent).
// Accepts FULL records (content/input/options) and LIST SUMMARIES
// ({id,status,title,aim,subject,technology,experimentNumber,template,...}):
// summaries have no content, so top-level fields backstop every display
// value. Without this, every card from a fresh load renders the
// "Imported assignment" fallback with no content until opened.
export function recordToIssue(record) {
  const c = record.content ?? {}
  const exp = c.experimentNumber ?? record.experimentNumber;
  return {
    key: record.id,
    aim: c.aim ?? record.aim ?? 'Imported assignment',
    description: '',
    subject: record.input?.subject ?? record.subject ?? 'DBMS',
    experimentNumber: exp === null || exp === undefined || exp === '' ? '' : String(exp),
    technology: record.input?.technology ?? record.technology ?? '',
    difficulty: 'Intermediate',
    templateId: record.template?.id ?? '',
    includeVivaTitle: record.options?.includeVivaTitle ?? false,
    typedConclusion: record.options?.typedConclusion ?? true,
    status: 'done',
    error: '',
    stale: false,
    record,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
  }
}

/* ---------------------------------- data --------------------------------- */

export const SUBJECTS = ['DBMS', 'DSA', 'UHV', 'DLDCA', 'Professional Skills / AWS']

export const SUBJECT_META = {
  DBMS: { color: '#1A4543', bg: '#E1EAE5' },
  DSA: { color: '#3E6B5E', bg: '#E2EDE6' },
  UHV: { color: '#8A5F22', bg: '#F8EDD2' },
  DLDCA: { color: '#3D5A5C', bg: '#E0E8E8' },
  'Professional Skills / AWS': { color: '#2E6A66', bg: '#DDE8E4' },
}

export const DIFFICULTIES = ['Introductory', 'Intermediate', 'Advanced']

export const EXAMPLES = [
  { aim: 'Explore subqueries in SQL', subject: 'DBMS', experimentNumber: '7', technology: 'SQL', description: 'Single-row and multi-row subqueries with IN, EXISTS and derived tables.' },
  { aim: 'Implement binary search tree traversals', subject: 'DSA', experimentNumber: '4', technology: 'Java', description: 'Inorder, preorder and postorder traversals with complexity analysis.' },
  { aim: 'Study harmony in professional relationships', subject: 'UHV', experimentNumber: '3', technology: '', description: 'Trust, respect and affection as foundational values in relationships.' },
]

export const EDITABLE_SECTIONS = ['title', 'aim', 'objectives', 'theory', 'steps', 'conclusion']

export function sectionToText(section, value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function sectionFromText(section, text) {
  if (['title', 'aim', 'conclusion'].includes(section)) return text
  return JSON.parse(text)
}

/* --------------------------------- helpers -------------------------------- */

export function timeAgo(iso) {
  const t = new Date(iso ?? '').getTime()
  if (!Number.isFinite(t)) return '—'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function fullDate(iso) {
  const t = new Date(iso ?? '')
  if (Number.isNaN(t.getTime())) return '—'
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function subjectStyle(subject) {
  return SUBJECT_META[subject] ?? { color: '#35413F', bg: '#EFECE3' }
}

const loginMessages = [
  "Look who's here instead of doing their assignment on their own. 👀",
  'We hope the time you save here gets reinvested in sleep. 😴',
  'Back again? We respect the efficiency.',
  "Your practical isn't going to write itself… actually, that's why we're here.",
  "Welcome back. Let's get this practical out of the way.",
]

export function pickGreeting() {
  return loginMessages[Math.floor(Math.random() * loginMessages.length)]
}

export function timeOfDay() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function priorityOf(difficulty) {
  if (difficulty === 'Advanced') return { label: 'High', color: '#B3812F', glyph: '▲' }
  if (difficulty === 'Introductory') return { label: 'Low', color: '#44645B', glyph: '▼' }
  return { label: 'Medium', color: '#1A4543', glyph: '＝' }
}

export function uiStatus(issue) {
  if (issue.stale) return 'stale'
  if (issue.status === 'inprogress') return 'generating'
  if (issue.status === 'failed') return 'failed'
  if (issue.status === 'done') return 'done'
  return 'todo'
}

// Merges a fresh server list into board state WITHOUT clobbering locally
// tracked in-flight generations (job cards). A blind replace drops resumed
// cards whenever the list resolves after the jobs fetch — the card then
// vanishes until the next manual refresh. Namespaces are disjoint
// (job_<id> vs record ids), so a job card can never collide with a record.
export function mergeServerIssues(prev, serverRecords) {
  const server = (serverRecords ?? []).map(recordToIssue)
  const serverKeys = new Set(server.map((it) => it.key))
  const pending = (prev ?? []).filter((it) => it.jobId && it.status === 'inprogress' && !serverKeys.has(it.key))
  return [...pending, ...server]
}

// Swaps a tracked job card for its completed record (newest-first, like
// creation). Drops any record-keyed duplicate that arrived via the list
// while the job was still polling.
export function materializeJobCard(prev, jobKey, record) {
  const next = { ...recordToIssue(record), key: record.id }
  return [next, ...(prev ?? []).filter((it) => it.key !== jobKey && it.key !== record.id)]
}
