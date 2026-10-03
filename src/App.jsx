import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingRows,
  ModalShell,
  PageHeader,
  SearchBar,
  StatusBadge,
  inputCls,
} from './components/ui.jsx'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4000'

// No browser storage anywhere in this app: board state lives in React state
// (gone on reload), records live in MongoDB via the API, and the auth token
// lives in memory (reloading logs you out — by design).
let memoryToken = ''
function authHeaders(extra = {}) {
  return memoryToken ? { ...extra, Authorization: `Bearer ${memoryToken}` } : extra
}

// credentials:'include' lets the httpOnly session cookie ride along.
// Transport failures surface here as friendly product copy.
async function apiFetch(url, options = {}) {
  try {
    return await fetch(url, { credentials: 'include', ...options })
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('The request timed out. Please try again.')
    throw new Error("Couldn't reach the Markly service. Check your connection and try again.")
  }
}

// Server record -> assignment (keyed by record id so reloads stay consistent).
function recordToIssue(record) {
  const c = record.content ?? {}
  return {
    key: record.id,
    aim: c.aim ?? 'Imported assignment',
    description: '',
    subject: record.input?.subject ?? 'DBMS',
    experimentNumber: c.experimentNumber ? String(c.experimentNumber) : '',
    technology: record.input?.technology ?? '',
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

const SUBJECTS = ['DBMS', 'DSA', 'UHV', 'DLDCA', 'Professional Skills / AWS']

const SUBJECT_META = {
  DBMS: { color: '#1A4543', bg: '#E1EAE5' },
  DSA: { color: '#3E6B5E', bg: '#E2EDE6' },
  UHV: { color: '#8A5F22', bg: '#F8EDD2' },
  DLDCA: { color: '#3D5A5C', bg: '#E0E8E8' },
  'Professional Skills / AWS': { color: '#2E6A66', bg: '#DDE8E4' },
}

const DIFFICULTIES = ['Introductory', 'Intermediate', 'Advanced']

const EXAMPLES = [
  { aim: 'Explore subqueries in SQL', subject: 'DBMS', experimentNumber: '7', technology: 'SQL', description: 'Single-row and multi-row subqueries with IN, EXISTS and derived tables.' },
  { aim: 'Implement binary search tree traversals', subject: 'DSA', experimentNumber: '4', technology: 'Java', description: 'Inorder, preorder and postorder traversals with complexity analysis.' },
  { aim: 'Study harmony in professional relationships', subject: 'UHV', experimentNumber: '3', technology: '', description: 'Trust, respect and affection as foundational values in relationships.' },
]

const EDITABLE_SECTIONS = ['title', 'aim', 'objectives', 'theory', 'steps', 'conclusion']

function sectionToText(section, value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function sectionFromText(section, text) {
  if (['title', 'aim', 'conclusion'].includes(section)) return text
  return JSON.parse(text)
}

/* --------------------------------- helpers -------------------------------- */

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

function timeAgo(iso) {
  const t = new Date(iso ?? '').getTime()
  if (!Number.isFinite(t)) return '—'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fullDate(iso) {
  const t = new Date(iso ?? '')
  if (Number.isNaN(t.getTime())) return '—'
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function subjectStyle(subject) {
  return SUBJECT_META[subject] ?? { color: '#35413F', bg: '#EFECE3' }
}

/* --------------------------- identity + greeting -------------------------- */
// Session shape: { email, name, avatarUrl, id } — name/avatar come from the
// authenticated profile (GET /api/v1/auth/me, enriched server-side from the
// same store register/login use). Nothing is hardcoded; when the provider
// has no name, the email local-part is prettified as a last resort.

function displayNameOf(session) {
  const n = (session?.name ?? '').trim()
  if (n) return n
  const local = (session?.email ?? '').split('@')[0] ?? ''
  const words = local.split(/[._\-+]+/).filter(Boolean)
  if (words.length === 0) return session?.email ? session.email : 'Student'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function firstNameOf(session) {
  return displayNameOf(session).split(/\s+/)[0] ?? 'there'
}

function initialsOf(name, email) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1 && parts[0][0]) return parts[0][0].toUpperCase()
  const c = (email ?? '').trim().charAt(0)
  return (c || 'S').toUpperCase()
}

const loginMessages = [
  "Look who's here instead of doing their assignment on their own. 👀",
  'We hope the time you save here gets reinvested in sleep. 😴',
  'Back again? We respect the efficiency.',
  "Your practical isn't going to write itself… actually, that's why we're here.",
  "Welcome back. Let's get this practical out of the way.",
]

function pickGreeting() {
  return loginMessages[Math.floor(Math.random() * loginMessages.length)]
}

function timeOfDay() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function priorityOf(difficulty) {
  if (difficulty === 'Advanced') return { label: 'High', color: '#B3812F', glyph: '▲' }
  if (difficulty === 'Introductory') return { label: 'Low', color: '#44645B', glyph: '▼' }
  return { label: 'Medium', color: '#1A4543', glyph: '＝' }
}

/* ---------------------------------- icons --------------------------------- */

const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v4h-4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  send: (
    <>
      <path d="m21 3-9.5 9.5" />
      <path d="M21 3 14 21l-3.5-7.5L3 10Z" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M4 21h16" />
    </>
  ),
  home: (
    <>
      <path d="m4 11 8-7 8 7" />
      <path d="M6 9.5V20a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
}

function Icon({ name, className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {PATHS[name] ?? PATHS.dot}
    </svg>
  )
}

function LogoMark({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#1A4543" />
      <path d="M8 23.5v-12l7.5 7 7.5-7v12" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="8" r="2" fill="#F0BE6F" />
    </svg>
  )
}

function Avatar({ subject, className = 'h-6 w-6 text-[10px]' }) {
  const s = subjectStyle(subject)
  const initials = subject.split(/[\s/]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-bold', className)} style={{ background: s.bg, color: s.color }}>
      {initials}
    </span>
  )
}

function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('animate-spin', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="#E4DFD3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#1A4543" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* ------------------------- authenticated identity ------------------------ */

function UserAvatar({ user, className = 'h-9 w-9 text-[12px]' }) {
  // Remembers the URL that failed so a broken image falls back to initials;
  // any new URL is retried automatically (no effect needed).
  const [failedUrl, setFailedUrl] = useState('')
  const name = displayNameOf(user)
  const url = (user?.avatarUrl ?? '').trim()
  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt={`${name}'s profile photo`}
        onError={() => setFailedUrl(url)}
        className={cx('shrink-0 rounded-full bg-pine-900 object-cover', className)}
      />
    )
  }
  return (
    <span
      role="img"
      aria-label={`${name}'s profile avatar`}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-pine-900 font-bold text-white', className)}
    >
      {initialsOf(name, user?.email)}
    </span>
  )
}

function ProfileMenu({ session, onLogout, onOpenProfile, direction = 'up', compact = false }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef(null)
  const name = displayNameOf(session)

  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onPointer(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open ])

  async function doLogout() {
    if (busy) return
    setBusy(true)
    try {
      await onLogout()
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? `${name} — open profile menu` : undefined}
        title={compact ? name : undefined}
        className={cx(
          'flex items-center gap-2.5 rounded-xl text-left transition-all duration-150 hover:border-ink-300 hover:bg-rail active:bg-rail-hover cursor-pointer',
          compact ? 'rounded-full p-0.5 hover:bg-rail' : 'w-full border border-transparent px-2 py-1.5 hover:border-line',
        )}
      >
        <UserAvatar user={session} className={compact ? 'h-9 w-9 text-[12px]' : 'h-10 w-10 text-[13px]'} />
        {!compact && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold leading-tight text-ink-900">{name}</span>
            <span className="block truncate text-[11.5px] text-ink-400">{session?.email}</span>
          </span>
        )}
        {!compact && (
          <Icon name="chevron" className={cx('h-3.5 w-3.5 shrink-0 rotate-[-90deg] text-ink-300 transition-transform duration-150', open && 'rotate-90')} />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Profile menu"
          className={cx(
            'mk-pop absolute z-50 w-60 overflow-hidden rounded-xl border border-line bg-white shadow-[0_12px_32px_rgba(15,46,45,0.22)]',
            direction === 'up' ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2',
          )}
        >
          <div className="flex items-center gap-2.5 border-b border-line-soft bg-paper px-3.5 py-3">
            <UserAvatar user={session} className="h-9 w-9 text-[12px]" />
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-bold text-ink-900">{name}</p>
              <p className="truncate text-[12px] text-ink-400">{session?.email}</p>
            </div>
          </div>
          <div className="p-1.5">
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onOpenProfile?.() }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-ink-700 transition-colors duration-150 hover:bg-rail"
            >
              <Icon name="user" className="h-4 w-4 text-ink-400" />
              Profile
            </button>
            <button
              role="menuitem"
              onClick={doLogout}
              disabled={busy}
              aria-label="Log out"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-[#8F1D17] transition-colors duration-150 hover:bg-[#FDECEC] disabled:opacity-60"
            >
              {busy ? <Spinner className="h-4 w-4" /> : <Icon name="logout" className="h-4 w-4" />}
              {busy ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileModal({ session, onClose }) {
  const name = displayNameOf(session)
  return (
    <ModalShell title="Your profile" subtitle="Identity from your Markly sign-in." onClose={onClose}>
      <div className="flex items-center gap-3.5">
        <UserAvatar user={session} className="h-16 w-16 text-[20px]" />
        <div className="min-w-0">
          <p className="truncate text-[17px] font-bold tracking-tight text-ink-900">{name}</p>
          <p className="truncate text-[13px] text-ink-500">{session?.email}</p>
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-sage-100 px-2 py-0.5 text-[11px] font-bold text-sage-700 ring-1 ring-inset ring-sage-300/60">
            <span className="h-1.5 w-1.5 rounded-full bg-sage-500" />
            Signed in
          </span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-inset ring-line-soft">
          <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Name</dt>
          <dd className="mt-0.5 truncate text-[13.5px] font-semibold text-ink-900">{name}</dd>
        </div>
        <div className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-inset ring-line-soft">
          <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Email</dt>
          <dd className="mt-0.5 truncate text-[13.5px] font-semibold text-ink-900">{session?.email ?? '—'}</dd>
        </div>
        <div className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-inset ring-line-soft sm:col-span-2">
          <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">User ID</dt>
          <dd className="mt-0.5 truncate text-[12.5px] font-semibold text-ink-700">{session?.id || '—'}</dd>
        </div>
      </dl>
    </ModalShell>
  )
}

/* ------------------------------ shared bits -------------------------------- */

function SubjectTag({ subject }) {
  const s = subjectStyle(subject)
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: s.bg, color: s.color }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      <span className="truncate">{subject}</span>
    </span>
  )
}

function SectionHeading({ icon, children }) {
  return (
    <h3 className="flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-400">
      <Icon name={icon} className="h-3.5 w-3.5" />
      {children}
    </h3>
  )
}

function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line-soft bg-rail px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{(language || 'code').toLowerCase()}</span>
        <button onClick={copy} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-ink-500 transition-colors duration-150 hover:bg-line-soft">
          <Icon name="copy" className="h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-ink-900">{code}</pre>
    </div>
  )
}

/* --------------------------- assignment row/card -------------------------- */

function uiStatus(issue) {
  if (issue.stale) return 'stale'
  if (issue.status === 'inprogress') return 'generating'
  if (issue.status === 'failed') return 'failed'
  if (issue.status === 'done') return 'done'
  return 'todo'
}

function RetryLink({ onRetry, label, className }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onRetry()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation()
          onRetry()
        }
      }}
      className={cx('cursor-pointer font-bold underline underline-offset-2', className)}
    >
      {label}
    </span>
  )
}

function AssignmentRow({ issue, onOpen, onRetry }) {
  const content = issue.record?.content
  const title = content?.title ?? issue.aim
  const status = uiStatus(issue)
  const generating = issue.status === 'inprogress'
  return (
    <button
      onClick={() => onOpen(issue.key)}
      className="group w-full rounded-xl border border-line bg-white p-3.5 text-left shadow-[0_1px_2px_rgba(30,42,40,0.06)] transition-all duration-150 hover:border-sage-300 hover:shadow-[0_2px_8px_rgba(26,69,67,0.10)] sm:px-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 hidden shrink-0 rounded-lg bg-pine-50 px-2 py-1 text-[11px] font-bold tracking-wide text-pine-900 ring-1 ring-inset ring-pine-900/10 sm:inline-block">
          {issue.experimentNumber ? `EXP ${issue.experimentNumber}` : 'EXP —'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[13.5px] font-bold tracking-tight text-ink-900">
                {title}
              </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-400">
            <span className="sm:hidden text-[11px] font-bold tracking-wide text-pine-900">
              {issue.experimentNumber ? `EXP ${issue.experimentNumber} · ` : ''}
            </span>
            <SubjectTag subject={issue.subject} />
            {issue.technology && <span className="truncate">· {issue.technology}</span>}
            <span>· Updated {timeAgo(issue.updatedAt ?? issue.createdAt)}</span>
            {content?.steps?.length > 0 && (
              <span className="inline-flex items-center gap-1">
                · <Icon name="list" className="h-3 w-3" /> {content.steps.length} steps
              </span>
            )}
          </span>
          {generating && (
            <span className="mt-2 flex items-center gap-2 rounded-lg bg-pine-50 px-2.5 py-1.5 text-[12.5px] font-semibold text-pine-900">
              <Spinner className="h-3.5 w-3.5" />
              Generating assignment…
            </span>
          )}
          {issue.status === 'failed' && (
            <span className="mt-2 block rounded-lg bg-[#FDECEC] px-2.5 py-1.5 text-[12.5px] text-[#8F1D17]">
              <span className="font-bold">Generation failed. </span>
              <RetryLink onRetry={() => onRetry(issue.key)} label="Retry" className="hover:text-[#5f130e]" />
            </span>
          )}
          {issue.stale && issue.status === 'done' && (
            <span className="mt-2 block rounded-lg bg-sand-50 px-2.5 py-1.5 text-[12.5px] text-sand-700 ring-1 ring-inset ring-sand-400/40">
              <span className="font-bold">Stored copy expired. </span>
              <RetryLink onRetry={() => onRetry(issue.key)} label="Regenerate" />
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge status={status} />
          <span className="hidden items-center gap-1 text-[12px] font-semibold text-ink-300 transition-colors duration-150 group-hover:text-pine-800 sm:inline-flex">
            Open <Icon name="chevron" className="h-3.5 w-3.5" />
          </span>
        </span>
      </div>
    </button>
  )
}

/* ------------------------- generation status pill ------------------------ */
// Compact interactive status: the dominant element is the active count;
// "please wait" stays de-emphasized supporting context. Clicking opens the
// generating assignment in the right-side drawer (same slide animation).

function GenerationPill({ count, onOpen, className = '' }) {
  return (
    <button
      onClick={onOpen}
      title="Open the generating assignment"
      aria-label={`${count} assignment${count === 1 ? '' : 's'} generating — open details`}
      className={cx(
        'inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-pine-50 py-1.5 pl-3 pr-3.5 text-[12.5px] font-bold leading-5 text-pine-900 ring-1 ring-inset ring-pine-900/10 transition-colors duration-150 hover:bg-pine-100',
        className,
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pine-700 opacity-40" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-pine-800" />
      </span>
      {count} generating
      <span className="font-medium text-pine-900/50">· please wait</span>
    </button>
  )
}

/* ---------------------------------- app ------------------------------------ */

const NAV = [  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'assignments', label: 'Assignments', icon: 'file' },
  { id: 'history', label: 'History', icon: 'archive' },
  { id: 'templates', label: 'Templates', icon: 'grid' },
]

export default function App() {
  const [issues, setIssues] = useState([])
  const [bootLoading, setBootLoading] = useState(true)
  const [bootError, setBootError] = useState('')
  const [seq, setSeq] = useState(101)
  const [view, setView] = useState('dashboard')
  // Drawer mount/animation state: the panel must stay mounted while the
  // closing slide plays, so the key only clears AFTER the 240ms ease-in
  // transition finishes (mirrors .mk-drawer.mk-hide in index.css).
  const [drawerKey, setDrawerKey] = useState(null)
  const [drawerShown, setDrawerShown] = useState(false)
  const drawerTimer = useRef(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [prefill, setPrefill] = useState(null)
  const [toasts, setToasts] = useState([])
  const [serviceUp, setServiceUp] = useState(null)
  const [templates, setTemplates] = useState([])
  const [loginOpen, setLoginOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [session, setSession] = useState(null)
  // Selected once per visit (and re-picked on each fresh login) — never
  // re-rolled on re-render, so the line stays stable for the whole session.
  const [greeting, setGreeting] = useState(() => pickGreeting())
  // Assignments workspace state
  const [query, setQuery] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('All subjects')
  const [statusFilter, setStatusFilter] = useState('All statuses')
  const [sortBy, setSortBy] = useState('Recently updated')
  const toastId = useRef(0)

  function saveSession(next) {
    setSession(next)
    memoryToken = next?.token ?? ''
  }

  const pushToast = useCallback((kind, title, message) => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, kind, title, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }, [])

  const handleAuthRequired = useCallback(() => {
    setLoginOpen(true)
    pushToast('error', 'Login required', 'Please log in to continue — then retry the action.')
  }, [pushToast])

  const ensureSession = useCallback(() => {
    if (session?.token) return true
    handleAuthRequired()
    return false
  }, [handleAuthRequired, session])

  // Must match .mk-drawer.mk-hide transition-duration in index.css.
  const DRAWER_CLOSE_MS = 240

  // Open the right-side drawer with a right→left slide. When the drawer is
  // already mounted (switching assignments), content swaps without replaying
  // the entrance — only a cold open animates.
  const openDrawer = useCallback((key) => {
    if (!key) return
    if (drawerTimer.current) {
      clearTimeout(drawerTimer.current)
      drawerTimer.current = null
    }
    const cold = drawerKey === null
    setDrawerKey(key)
    if (cold) {
      // Cold open: mount off-screen first, then slide in on the next frames.
      setDrawerShown(false)
      requestAnimationFrame(() => requestAnimationFrame(() => setDrawerShown(true)))
    } else {
      setDrawerShown(true)
    }
  }, [drawerKey])

  // Close the drawer with a left→right slide + backdrop fade. The selection
  // (and unmount) only clears after the animation finishes — never instantly.
  const closeDrawer = useCallback(() => {
    setDrawerShown(false)
    if (drawerTimer.current) clearTimeout(drawerTimer.current)
    drawerTimer.current = setTimeout(() => {
      drawerTimer.current = null
      setDrawerKey(null)
    }, DRAWER_CLOSE_MS)
  }, [])

  const openCreate = useCallback((ex) => {
    setPrefill(ex ?? null)
    setCreateOpen(true)
  }, [])

  const refreshTemplates = useCallback(async () => {
    try {
      const d = await apiFetch(`${API_BASE}/api/v1/templates`, { headers: authHeaders() }).then((r) => r.json())
      setTemplates(d.templates ?? [])
    } catch {
      /* keep stale list */
    }
  }, [])

  useEffect(() => {
    let alive = true
    setBootLoading(true)
    setBootError('')
    apiFetch(`${API_BASE}/api/v1/health`)
      .then((r) => { if (alive) setServiceUp(r.ok) })
      .catch(() => { if (alive) setServiceUp(false) })
    apiFetch(`${API_BASE}/api/v1/templates`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) setTemplates(d.templates ?? []) })
      .catch(() => { if (alive) setTemplates([]) })
    apiFetch(`${API_BASE}/api/v1/assignments`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        setIssues((d.assignments ?? []).map(recordToIssue))
        setBootLoading(false)
      })
      .catch((err) => {
        if (!alive) return
        setBootError(err instanceof Error ? err.message : String(err))
        setBootLoading(false)
      })
    apiFetch(`${API_BASE}/api/v1/auth/me`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Restored cookie session: identity comes from the authenticated
        // profile (name/avatar resolved server-side), never local guesses.
        if (alive && d?.user?.email) {
          setSession({
            email: d.user.email,
            name: d.user.name ?? '',
            avatarUrl: d.user.avatarUrl ?? '',
            id: d.user.sub ?? d.user.id ?? '',
          })
        }
      })
      .catch(() => { /* logged out is a valid state */ })
    return () => { alive = false }
  }, [])

  // Single logout path reused by every profile surface: the existing
  // endpoint, existing session clearing, friendly confirmation.
  const logout = useCallback(async () => {
    try { await apiFetch(`${API_BASE}/api/v1/auth/logout`, { method: 'POST' }) } catch { /* cookie may already be gone */ }
    saveSession(null)
    pushToast('success', 'Logged out', 'Session cleared.')
  }, [pushToast])

  const startGeneration = useCallback(
    async (issue) => {
      const key = issue.key
      if (!ensureSession()) return
      const payload = {
        aim: issue.aim,
        description: issue.description || undefined,
        subject: issue.subject,
        experimentNumber: issue.experimentNumber ? Number(issue.experimentNumber) : undefined,
        technology: issue.technology || undefined,
        templateId: issue.templateId || undefined,
        difficulty: issue.difficulty || undefined,
        includeVivaTitle: issue.includeVivaTitle ?? issue.record?.options?.includeVivaTitle ?? false,
        typedConclusion: issue.typedConclusion ?? issue.record?.options?.typedConclusion ?? true,
      }
      setIssues((prev) => prev.map((it) => (it.key === key ? { ...it, status: 'inprogress', error: '', stale: false } : it)))
      let status = 0
      try {
        const res = await apiFetch(`${API_BASE}/api/v1/assignments/generate`, {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180000),
        })
        status = res.status
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error ? String(data.error) : `Request failed. Please try again.`)
        if (!data?.content) throw new Error('Service returned an empty assignment')
        setIssues((prev) => prev.map((it) => (it.key === key ? { ...recordToIssue(data), key: data.id } : it)))
        // Rekeyed onto the server record id: follow with the open drawer so
        // generation finishes in the same panel (no animation restart).
        setDrawerKey(data.id)
        setDrawerShown(true)
        pushToast('success', `${data.id} generated`, 'Assignment content is ready for review.')
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err)
        if (status === 401) {
          message = 'Please log in to continue — then retry generation.'
          handleAuthRequired()
        }
        setIssues((prev) => prev.map((it) => (it.key === key ? { ...it, status: 'failed', error: message } : it)))
        pushToast('error', `${key} failed`, message)
      }
    },
    [pushToast, ensureSession, handleAuthRequired],
  )

  const runGeneration = useCallback(
    (key) => {
      const issue = issues.find((it) => it.key === key)
      if (!issue || issue.status === 'inprogress') return
      return startGeneration(issue)
    },
    [issues, startGeneration],
  )

  const markStale = useCallback((key) => {
    setIssues((prev) => prev.map((it) => (it.key === key && !it.stale ? { ...it, stale: true } : it)))
  }, [])

  const issuesRef = useRef(issues)

  useEffect(() => {
    const withRecord = issuesRef.current.filter((it) => it.record?.id)
    if (withRecord.length === 0) return undefined
    let cancelled = false
    Promise.all(
      withRecord.map(async (it) => {
        try {
          const res = await apiFetch(`${API_BASE}/api/v1/assignments/${it.record.id}`, { signal: AbortSignal.timeout(10000) })
          return res.status === 404 ? it.key : null
        } catch {
          return null
        }
      }),
    ).then((keys) => {
      const missing = new Set(keys.filter(Boolean))
      if (!cancelled && missing.size > 0) {
        setIssues((prev) => prev.map((it) => (missing.has(it.key) && !it.stale ? { ...it, stale: true } : it)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const createIssue = useCallback(
    (form) => {
      const key = `ASG-${seq}`
      setSeq((s) => s + 1)
      const issue = {
        key,
        aim: form.aim.trim(),
        description: form.description.trim(),
        subject: form.subject,
        experimentNumber: form.experimentNumber.trim(),
        technology: form.technology.trim(),
        difficulty: form.difficulty,
        templateId: form.templateId || undefined,
        includeVivaTitle: form.includeVivaTitle,
        typedConclusion: form.typedConclusion,
        status: 'inprogress',
        error: '',
        stale: false,
        record: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      setIssues((prev) => [issue, ...prev])
      setCreateOpen(false)
      setPrefill(null)
      setView('assignments')
      openDrawer(key)
      startGeneration(issue)
    },
    [startGeneration, seq, openDrawer],
  )

  const deleteIssue = useCallback(
    async (key) => {
      const target = issues.find((it) => it.key === key)
      const recordId = target?.record?.id
      if (recordId) {
        try {
          const res = await apiFetch(`${API_BASE}/api/v1/assignments/${recordId}`, {
            method: 'DELETE',
            headers: authHeaders(),
            signal: AbortSignal.timeout(30000),
          })
          if (!res.ok && res.status !== 404) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data?.error ?? 'Delete failed. Please try again.')
          }
        } catch (err) {
          pushToast('error', `${key} not deleted`, err instanceof Error ? err.message : String(err))
          return
        }
      }
      setIssues((prev) => prev.filter((it) => it.key !== key))
      closeDrawer()
      pushToast('success', `${key} deleted`, 'The assignment was removed.')
    },
    [pushToast, issues, closeDrawer],
  )

  const importRecordToBoard = useCallback(
    async (recordId) => {
      try {
        const record = await apiFetch(`${API_BASE}/api/v1/assignments/${recordId}`, { headers: authHeaders() }).then((r) => {
          if (!r.ok) throw new Error("Couldn't load this assignment. Please try again.")
          return r.json()
        })
        setIssues((prev) => (prev.some((it) => it.key === record.id) ? prev : [recordToIssue(record), ...prev]))
        openDrawer(record.id)
        setView('assignments')
      } catch (err) {
        pushToast('error', 'Import failed', err instanceof Error ? err.message : String(err))
      }
    },
    [pushToast, openDrawer],
  )

  async function downloadHtml(issue) {
    const recordId = issue.record?.id
    if (!recordId) return
    try {
      const res = await apiFetch(`${API_BASE}/api/v1/assignments/${recordId}/html`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(180000),
      })
      if (res.status === 401) {
        handleAuthRequired()
        return
      }
      if (res.status === 404) {
        markStale(issue.key)
        pushToast('error', 'Document cleared', 'The service no longer has this record — regenerate the assignment to restore exports.')
        return
      }
      if (!res.ok) throw new Error(`Export failed. Please try again.`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${issue.key}-assignment.html`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      pushToast('success', 'Document exported', `${issue.key}-assignment.html downloaded.`)
    } catch (err) {
      pushToast('error', 'Export failed', err instanceof Error ? err.message : String(err))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = issues.filter((it) => {
      const title = (it.record?.content?.title ?? it.aim ?? '').toLowerCase()
      const matchesQ =
        !q ||
        title.includes(q) ||
        it.aim.toLowerCase().includes(q) ||
        it.subject.toLowerCase().includes(q) ||
        (it.technology ?? '').toLowerCase().includes(q) ||
        it.key.toLowerCase().includes(q)
      const matchesSubject = subjectFilter === 'All subjects' || it.subject === subjectFilter
      const st = uiStatus(it)
      const matchesStatus =
        statusFilter === 'All statuses' ||
        (statusFilter === 'Ready' && st === 'done') ||
        (statusFilter === 'Generating' && st === 'generating') ||
        (statusFilter === 'Needs attention' && st === 'failed') ||
        (statusFilter === 'Expired' && st === 'stale')
      return matchesQ && matchesSubject && matchesStatus
    })
    list = [...list].sort((a, b) => {
      if (sortBy === 'Experiment number') {
        return (Number.parseInt(a.experimentNumber || '0', 10) || 0) - (Number.parseInt(b.experimentNumber || '0', 10) || 0)
      }
      if (sortBy === 'Oldest first') {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      }
      const au = new Date(a.updatedAt ?? a.createdAt).getTime()
      const bu = new Date(b.updatedAt ?? b.createdAt).getTime()
      return bu - au
    })
    return list
  }, [issues, query, subjectFilter, statusFilter, sortBy])

  const recent = useMemo(() => [...issues].slice(0, 5), [issues])
  // The drawer renders from drawerKey (not selection intent) so it survives
  // the closing animation: the issue stays readable while sliding away.
  const selected = drawerKey ? (issues.find((it) => it.key === drawerKey) ?? null) : null
  const generatingCount = issues.filter((i) => i.status === 'inprogress').length
  const firstGeneratingKey = useMemo(
    () => issues.find((i) => i.status === 'inprogress')?.key ?? null,
    [issues],
  )

  const todayLine = useMemo(() => {
    const d = new Date()
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  }, [])

  return (
    <div className="flex min-h-screen bg-paper text-ink-900">
      {/* Sidebar — desktop */}
      <aside className="no-print sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <LogoMark className="h-8 w-8" />
          <div>
            <p className="text-[15px] font-extrabold leading-none tracking-tight">Markly</p>
            <p className="mt-1 text-[11px] font-medium text-ink-400">Assignment workspace</p>
          </div>
        </div>
        <div className="px-3">
          <Button onClick={() => openCreate(null)} className="w-full">
            <Icon name="plus" className="h-4 w-4" />
            New assignment
          </Button>
        </div>
        <nav className="mt-4 flex flex-col gap-0.5 px-3" aria-label="Primary">
          {NAV.map((n) => {
            const active = view === n.id
            const count = n.id === 'assignments' ? issues.length : null
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-semibold transition-colors duration-150',
                  active ? 'bg-pine-900 text-white shadow-[0_1px_2px_rgba(26,69,67,0.3)]' : 'text-ink-500 hover:bg-rail hover:text-ink-900',
                )}
              >
                <Icon name={n.icon} className="h-4 w-4 shrink-0" />
                {n.label}
                {count !== null && count > 0 && (
                  <span className={cx('ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-bold', active ? 'bg-white/15 text-white' : 'bg-rail text-ink-500')}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t border-line-soft p-4">
          <div className="flex items-center gap-2 rounded-lg bg-sage-50 px-3 py-2 ring-1 ring-inset ring-sage-300/40">
            <span className={cx('h-2 w-2 rounded-full', serviceUp === false ? 'bg-[#B3261E]' : serviceUp ? 'bg-sage-500' : 'bg-ink-300 animate-pulse')} />
            <p className="text-[12px] font-semibold text-ink-700">
              {serviceUp === false ? 'Service unreachable' : serviceUp ? 'Service connected' : 'Checking service…'}
            </p>
          </div>
          {session ? (
            <ProfileMenu
              session={session}
              onLogout={logout}
              onOpenProfile={() => setProfileOpen(true)}
              direction="up"
            />
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setLoginOpen(true)} className="w-full">
              <Icon name="user" className="h-4 w-4" />
              Log in
            </Button>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Top bar — mobile + tablet */}
        <header className="no-print sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
            <span className="flex items-center gap-2">
              <LogoMark className="h-7 w-7" />
              <span className="text-[15px] font-extrabold tracking-tight">Markly</span>
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" onClick={() => openCreate(null)}>
                <Icon name="plus" className="h-3.5 w-3.5" />
                New
              </Button>
              {session ? (
                <ProfileMenu
                  session={session}
                  onLogout={logout}
                  onOpenProfile={() => setProfileOpen(true)}
                  direction="down"
                  compact
                />
              ) : (
                <button
                  onClick={() => setLoginOpen(true)}
                  aria-label="Log in"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-ink-500 transition-colors hover:bg-rail"
                >
                  <Icon name="user" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2.5 sm:px-4" aria-label="Primary">
            {NAV.map((n) => {
              const active = view === n.id
              return (
                <button
                  key={n.id}
                  onClick={() => setView(n.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150',
                    active ? 'bg-pine-900 text-white' : 'text-ink-500 hover:bg-rail hover:text-ink-900',
                  )}
                >
                  <Icon name={n.icon} className="h-3.5 w-3.5" />
                  {n.label}
                </button>
              )
            })}
          </nav>
          {/* Mobile status row: date first, tappable generation pill below —
              never forced into one crowded line. */}
          <div className="flex flex-col items-start gap-1.5 border-t border-line-soft px-3 py-2 sm:px-4">
            <p className="text-[12px] font-medium text-ink-400">{todayLine}</p>
            {generatingCount > 0 && firstGeneratingKey && (
              <GenerationPill count={generatingCount} onOpen={() => openDrawer(firstGeneratingKey)} />
            )}
          </div>
        </header>

        {/* Desktop utility strip: date anchored left, generation status
            absolutely centered (stable regardless of text width), workspace
            count right. No margin hacks — pure relative + absolute layout. */}
        <div className="no-print hidden border-b border-line bg-white lg:block">
          <div className="relative mx-auto flex max-w-6xl items-center px-8 py-2">
            <p className="text-[12.5px] font-medium text-ink-400">{todayLine}</p>
            {generatingCount > 0 && firstGeneratingKey && (
              <GenerationPill
                count={generatingCount}
                onOpen={() => openDrawer(firstGeneratingKey)}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              />
            )}
            <span className="ml-auto text-[12.5px] text-ink-400">
              {issues.length === 0 ? 'No practicals yet' : `${issues.length} practical${issues.length === 1 ? '' : 's'} in workspace`}
            </span>
          </div>
        </div>

        {serviceUp === false && (
          <div className="no-print border-b border-sand-400/50 bg-sand-50 px-4 py-2 text-center text-[13px] font-medium text-sand-700 sm:px-6">
            Can&apos;t reach the Markly service. Check your connection and try again.
          </div>
        )}

        {/* Content */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-3 pb-16 pt-5 sm:px-5 sm:pt-7 lg:px-8">
          {view === 'dashboard' && (
            <DashboardView
              issues={issues}
              recent={recent}
              templates={templates}
              loading={bootLoading}
              error={bootError}
              onRetry={() => window.location.reload()}
              onCreate={openCreate}
              onOpen={openDrawer}
              onRetryGen={runGeneration}
              onViewAll={() => setView('assignments')}
              onViewTemplates={() => setView('templates')}
              onUseTemplate={(t) => { setPrefill({ templateId: t.id }); setCreateOpen(true) }}
              session={session}
              greeting={greeting}
            />
          )}

          {view === 'assignments' && (
            <AssignmentsView
              issues={filtered}
              total={issues.length}
              loading={bootLoading}
              error={bootError}
              query={query}
              onQuery={setQuery}
              subjectFilter={subjectFilter}
              onSubject={setSubjectFilter}
              statusFilter={statusFilter}
              onStatus={setStatusFilter}
              sortBy={sortBy}
              onSort={setSortBy}
              onCreate={() => openCreate(null)}
              onOpen={openDrawer}
              onRetry={runGeneration}
              onResetFilters={() => { setQuery(''); setSubjectFilter('All subjects'); setStatusFilter('All statuses') }}
            />
          )}

          {view === 'history' && (
            <HistoryView
              onImport={importRecordToBoard}
            />
          )}

          {view === 'templates' && (
            <TemplatesView
              templates={templates}
              onRefresh={refreshTemplates}
              notify={pushToast}
              onUse={(t) => { setPrefill({ templateId: t.id }); setCreateOpen(true) }}
              onAuthRequired={handleAuthRequired}
            />
          )}
        </main>
      </div>

      {selected && (
        <DetailDrawer
          key={selected.key}
          issue={selected}
          shown={drawerShown}
          onClose={closeDrawer}
          onRetry={() => runGeneration(selected.key)}
          onDelete={() => deleteIssue(selected.key)}
          onDownload={() => downloadHtml(selected)}
          onRecordUpdate={(key, record) => setIssues((prev) => prev.map((it) => (it.key === key ? { ...it, record, stale: false } : it)))}
          onMarkStale={markStale}
          onAuthRequired={handleAuthRequired}
          onOpenPreview={() => window.open(`${API_BASE}/api/v1/assignments/${selected.record.id}/html`, '_blank', 'noopener')}
          apiBase={API_BASE}
        />
      )}

      {createOpen && (
        <CreateModal
          initial={prefill}
          templates={templates}
          onClose={() => {
            setCreateOpen(false)
            setPrefill(null)
          }}
          onSubmit={createIssue}
        />
      )}

      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onLogin={async (s) => {
            // Token first (memory), then the authenticated profile for the
            // real name/avatar — the form identity is only a fallback.
            saveSession({ email: s.email, name: s.name ?? '', avatarUrl: '', id: '' })
            setLoginOpen(false)
            try {
              const me = await apiFetch(`${API_BASE}/api/v1/auth/me`, {
                headers: authHeaders(),
              }).then((r) => (r.ok ? r.json() : null))
              if (me?.user) {
                saveSession({
                  email: me.user.email ?? s.email,
                  name: me.user.name ?? s.name ?? '',
                  avatarUrl: me.user.avatarUrl ?? '',
                  id: me.user.sub ?? me.user.id ?? '',
                })
              }
            } catch { /* form-provided identity stands */ }
            setGreeting(pickGreeting())
            refreshTemplates()
            pushToast('success', `Welcome back, ${firstNameOf({ email: s.email, name: s.name ?? '' })}`, s.email)
          }}
        />
      )}

      {profileOpen && session && (
        <ProfileModal session={session} onClose={() => setProfileOpen(false)} />
      )}

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-3 z-[60] flex w-[calc(100vw-24px)] max-w-sm flex-col gap-2 sm:right-4">
        {toasts.map((t) => (
          <div key={t.id} className="mk-toast pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-white p-3 shadow-[0_8px_24px_rgba(15,46,45,0.18)]">
            <span className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', t.kind === 'success' ? 'bg-sage-100 text-pine-900' : 'bg-[#FDECEC] text-[#8F1D17]')}>
              <Icon name={t.kind === 'success' ? 'check' : 'x'} className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold">{t.title}</p>
              <p className="break-words text-[12.5px] text-ink-500">{t.message}</p>
            </div>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss" className="rounded-md p-1 text-ink-300 transition-colors hover:bg-rail hover:text-ink-700">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------- dashboard ------------------------------ */

function DashboardView({ issues, recent, templates, loading, error, onRetry, onCreate, onOpen, onRetryGen, onViewAll, onViewTemplates, onUseTemplate, session, greeting }) {
  return (
    <div className="mk-rise flex flex-col gap-5">
      {session ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-tight text-ink-900 sm:text-[24px]">
              {timeOfDay()}, {firstNameOf(session)}.
            </h1>
            <p className="mt-1 max-w-xl text-[13.5px] leading-relaxed text-ink-500">
              {greeting}
            </p>
            <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-400">
              Create and manage your practicals without the last-minute panic.
            </p>
          </div>
          <Button onClick={() => onCreate(null)} className="shrink-0">
            <Icon name="plus" className="h-4 w-4" />
            Create assignment
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Your practical workspace"
          description="Draft an aim, generate a structured department-ready document, then export it for submission. Everything you create appears below."
          actions={
            <Button onClick={() => onCreate(null)}>
              <Icon name="plus" className="h-4 w-4" />
              Create assignment
            </Button>
          }
        />
      )}

      {loading ? (
        <LoadingRows count={4} />
      ) : error ? (
        <ErrorState onRetry={onRetry} />
      ) : issues.length === 0 ? (
        <EmptyState
          icon={<LogoMark className="h-6 w-6" />}
          title="No assignments yet"
          body="Create your first practical and it will appear here."
          action={
            <Button onClick={() => onCreate(null)} size="lg">
              <Icon name="plus" className="h-4 w-4" />
              Create your first practical
            </Button>
          }
          secondary={
            <div className="mt-6 w-full border-t border-line-soft pt-4 text-left">
              <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-400">Or start from an example</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button key={ex.aim} onClick={() => onCreate(ex)} className="rounded-lg border border-line px-3 py-2 text-left text-[13px] transition-colors duration-150 hover:border-pine-700 hover:bg-pine-50">
                    <span className="font-bold text-ink-900">{ex.aim}</span>
                    <span className="block text-[12px] text-ink-500">
                      {ex.subject} · Experiment {ex.experimentNumber}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* Recent work */}
          <section className="xl:col-span-2">
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-400">Recent assignments</h2>
              <button onClick={onViewAll} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-pine-800 transition-colors hover:text-pine-950">
                View all <Icon name="chevron" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {recent.map((issue) => (
                <AssignmentRow key={issue.key} issue={issue} onOpen={onOpen} onRetry={onRetryGen} />
              ))}
            </div>
          </section>

          {/* Side stack */}
          <div className="flex flex-col gap-4">
            <section className="rounded-xl border border-sage-300/50 bg-sage-50 p-4">
              <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-pine-900">How it works</h2>
              <ol className="mt-2.5 flex flex-col gap-2.5">
                {[
                  ['Describe', 'Aim, subject, experiment number and technology.'],
                  ['Generate', 'Objectives, theory, steps and conclusion — validated, never viva questions.'],
                  ['Export', 'Department header and watermark on every page — DOCX, PDF, HTML.'],
                ].map(([h, p], i) => (
                  <li key={h} className="flex gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pine-900 text-[11px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span>
                      <span className="block text-[13px] font-bold text-ink-900">{h}</span>
                      <span className="block text-[12.5px] leading-relaxed text-ink-500">{p}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <Button variant="secondary" size="sm" onClick={() => onCreate(null)} className="mt-3.5 w-full bg-white">
                <Icon name="plus" className="h-3.5 w-3.5" />
                Start a new practical
              </Button>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-400">Templates</h2>
                <button onClick={onViewTemplates} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-pine-800 hover:text-pine-950">
                  Library <Icon name="chevron" className="h-3.5 w-3.5" />
                </button>
              </div>
              {templates.length === 0 ? (
                <p className="mt-2 text-[13px] text-ink-500">No templates yet — the default department format is used automatically.</p>
              ) : (
                <div className="mt-2.5 flex flex-col gap-1.5">
                  {templates.slice(0, 3).map((t) => (
                    <div key={`${t.id}@${t.version}`} className="flex items-center gap-2 rounded-lg border border-line-soft px-2.5 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-bold">{t.name}</span>
                        <span className="block text-[11px] font-semibold text-ink-400">v{t.version} · {t.status}</span>
                      </span>
                      <button onClick={() => onUseTemplate(t)} className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-bold text-pine-800 transition-colors hover:bg-pine-50">
                        Use
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------- assignments ----------------------------- */

function AssignmentsView({ issues, total, loading, error, query, onQuery, subjectFilter, onSubject, statusFilter, onStatus, sortBy, onSort, onCreate, onOpen, onRetry, onResetFilters }) {
  const hasFilters = query.trim() !== '' || subjectFilter !== 'All subjects' || statusFilter !== 'All statuses'
  const selectCls =
    'rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-medium text-ink-700 transition-colors duration-150 hover:border-ink-300 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15'
  return (
    <div className="mk-rise flex flex-col gap-4">
      <PageHeader
        title="Assignments"
        description="Every practical, its status and exports — in one place. Select an assignment to review, edit and export it."
        meta={
          <Badge tone="teal">{total} practical{total === 1 ? '' : 's'}</Badge>
        }
        actions={
          <Button onClick={onCreate}>
            <Icon name="plus" className="h-4 w-4" />
            Create assignment
          </Button>
        }
      />

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 sm:flex-row sm:items-center">
        <SearchBar value={query} onChange={onQuery} placeholder="Search by aim, subject, technology or ID…" className="flex-1" />
        <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0">
          <select value={subjectFilter} onChange={(e) => onSubject(e.target.value)} className={selectCls} aria-label="Filter by subject">
            {['All subjects', ...SUBJECTS].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => onStatus(e.target.value)} className={selectCls} aria-label="Filter by status">
            {['All statuses', 'Ready', 'Generating', 'Needs attention', 'Expired'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={sortBy} onChange={(e) => onSort(e.target.value)} className={selectCls} aria-label="Sort assignments">
            {['Recently updated', 'Oldest first', 'Experiment number'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <LoadingRows count={5} />
      ) : error ? (
        <ErrorState onRetry={() => window.location.reload()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<Icon name="file" className="h-5 w-5" />}
          title="No assignments yet"
          body="Create your first practical and it will appear here."
          action={
            <Button onClick={onCreate} size="lg">
              <Icon name="plus" className="h-4 w-4" />
              Create assignment
            </Button>
          }
        />
      ) : issues.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center">
          <p className="text-[14px] font-bold">No assignments match these filters</p>
          <p className="mt-1 text-[13px] text-ink-500">Try a different search term or clear the filters.</p>
          {hasFilters && (
            <Button variant="secondary" size="sm" onClick={onResetFilters} className="mt-4">
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-[12.5px] text-ink-400">
            Showing {issues.length} of {total}
          </p>
          <div className="flex flex-col gap-2">
            {issues.map((issue) => (
              <AssignmentRow key={issue.key} issue={issue} onOpen={onOpen} onRetry={onRetry} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* --------------------------------- history ------------------------------- */

function HistoryView({ onImport }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [subject, setSubject] = useState('All subjects')

  useEffect(() => {
    let alive = true
    apiFetch(`${API_BASE}/api/v1/assignments`, { headers: authHeaders(), signal: AbortSignal.timeout(30000) })
      .then((r) => r.json())
      .then((d) => { if (alive) setItems(d.assignments ?? []) })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (items ?? []).filter((a) => {
      const text = `${a.title ?? ''} ${a.aim ?? ''} ${a.id ?? ''}`.toLowerCase()
      return (!needle || text.includes(needle)) && (subject === 'All subjects' || (a.input?.subject ?? a.subject) === subject)
    })
  }, [items, q, subject])

  return (
    <div className="mk-rise flex flex-col gap-4">
      <PageHeader
        title="History"
        description="A clean academic archive of everything generated on the Markly service. Open any record to review it in the workspace."
      />
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 sm:flex-row sm:items-center">
        <SearchBar value={q} onChange={setQ} placeholder="Search archive by title, aim or ID…" className="flex-1" />
        <select
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Filter archive by subject"
          className="rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-medium text-ink-700 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15 sm:w-48"
        >
          {['All subjects', ...SUBJECTS].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      {error && <ErrorState onRetry={() => window.location.reload()} />}
      {!error && items === null && <LoadingRows count={5} />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<Icon name="archive" className="h-5 w-5" />}
          title="Archive is empty"
          body="Nothing has been stored on the service yet. Generated assignments will be archived here."
        />
      )}
      {!error && items !== null && items.length > 0 && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center">
          <p className="text-[14px] font-bold">No records match this search</p>
          <p className="mt-1 text-[13px] text-ink-500">Try a different term or filter.</p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {filtered.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-3 transition-colors duration-150 hover:border-sage-300 sm:px-4">
            <Avatar subject={a.input?.subject ?? 'DBMS'} className="hidden h-9 w-9 text-[11px] sm:inline-flex" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-bold tracking-tight">{a.title || a.aim || a.id}</p>
              <p className="mt-0.5 truncate text-[12px] text-ink-400">
                <span className="text-[11.5px] font-semibold">{a.id}</span>
                {' · '}{a.template?.id ?? 'default'} v{a.template?.version ?? 1}
                {' · '}{a.createdAt ? fullDate(a.createdAt) : '—'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await onImport(a.id)
              }}
              className="shrink-0"
            >
              Open
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------- templates ------------------------------ */

function TemplatesView({ templates, onRefresh, notify, onUse, onAuthRequired }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('All')
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (templates ?? []).filter(
      (t) =>
        (!needle || `${t.name} ${t.id}`.toLowerCase().includes(needle)) &&
        (status === 'All' || t.status === status),
    )
  }, [templates, q, status])

  async function create(e) {
    e.preventDefault()
    if (name.trim().length < 3) { setMsg('Name needs at least 3 characters.'); return }
    setBusy(true)
    setMsg('')
    try {
      const res = await apiFetch(`${API_BASE}/api/v1/templates`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: name.trim() }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) { onAuthRequired?.(); return }
      if (!res.ok) throw new Error(data?.error ?? "Couldn't create the template. Please try again.")
      setName('')
      onRefresh()
      notify('success', 'Template created', `${data.template.name} v${data.template.version} (draft).`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function importPdf(e) {
    e.preventDefault()
    if (!file) { setMsg('Choose a sample PDF first.'); return }
    setBusy(true)
    setMsg('')
    try {
      const form = new FormData()
      form.append('file', file)
      if (name.trim()) form.append('name', name.trim())
      const res = await apiFetch(`${API_BASE}/api/v1/templates/from-pdf`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal: AbortSignal.timeout(120000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) { onAuthRequired?.(); return }
      if (!res.ok) throw new Error(data?.error ?? 'Import failed. Please try again.')
      setFile(null)
      onRefresh()
      notify('success', 'Template draft saved', `${data.template.name} — detected: ${(data.analysis?.detectedHeadings ?? []).join(', ') || 'no headings'}.`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mk-rise flex flex-col gap-4">
      <PageHeader
        title="Templates"
        description="Department formats for headers, watermarks and structure. Pick one when creating an assignment — or import a sample PDF to draft a new format."
        meta={<Badge tone="sage">{templates.length} format{templates.length === 1 ? '' : 's'}</Badge>}
        actions={
          <Button variant="secondary" onClick={() => setManageOpen((v) => !v)}>
            <Icon name="plus" className="h-4 w-4" />
            {manageOpen ? 'Hide tools' : 'New / import'}
          </Button>
        }
      />

      {manageOpen && (
        <div className="mk-rise grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-[13.5px] font-bold">New blank template</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">Starts as a v1 draft you can refine later.</p>
            <form onSubmit={create} className="mt-3 flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" className={inputCls} />
              <Button type="submit" disabled={busy} className="shrink-0">
                Create
              </Button>
            </form>
          </div>
          <div className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-[13.5px] font-bold">Import from sample PDF</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">Structure is extracted into a v1 draft for review.</p>
            <form onSubmit={importPdf} className="mt-3 flex flex-col gap-2">
              <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px] text-ink-500" />
              <Button type="submit" disabled={busy} className="w-fit">
                <Icon name="upload" className="h-4 w-4" />
                {busy ? 'Analyzing…' : 'Analyze & save draft'}
              </Button>
            </form>
          </div>
          {msg && <p className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[13px] font-medium text-[#8F1D17] md:col-span-2">{msg}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 sm:flex-row sm:items-center">
        <SearchBar value={q} onChange={setQ} placeholder="Search templates by name or ID…" className="flex-1" />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter templates by status"
          className="rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-medium text-ink-700 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15 sm:w-44"
        >
          {['All', 'draft', 'active', 'archived'].map((s) => (
            <option key={s}>{s === 'All' ? 'All statuses' : s}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="grid" className="h-5 w-5" />}
          title={templates.length === 0 ? 'No templates yet' : 'No templates match this search'}
          body={templates.length === 0 ? 'The default department format is used automatically. Create or import a format to see it here.' : 'Try a different search term or filter.'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {filtered.map((t) => (
            <div key={`${t.id}@${t.version}`} className="rounded-xl border border-line bg-white p-4 transition-colors duration-150 hover:border-sage-300">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-bold tracking-tight">{t.name}</p>
                  <p className="mt-0.5 truncate text-[11.5px] font-medium text-ink-400">{t.id} · tenant {t.tenantId ?? '—'}</p>
                </div>
                <Badge tone={t.status === 'active' ? 'teal' : t.status === 'draft' ? 'sand' : 'neutral'}>
                  v{t.version} · {t.status}
                </Badge>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => onUse(t)}>
                  Use template
                </Button>
                <Button size="sm" variant="ghost" onClick={onRefresh}>
                  Refresh
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------- detail drawer ----------------------------- */

function DetailDrawer({ issue, shown, onClose, onRetry, onDelete, onDownload, onOpenPreview, onRecordUpdate, onMarkStale, onAuthRequired, apiBase }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showRawJson, setShowRawJson] = useState(false)
  const [exportBusy, setExportBusy] = useState('')
  const [exportError, setExportError] = useState('')
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [regenBusy, setRegenBusy] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [latex, setLatex] = useState(null)
  const [latexBusy, setLatexBusy] = useState(false)
  const [latexError, setLatexError] = useState('')
  const [copiedLatex, setCopiedLatex] = useState(false)
  const [optBusy, setOptBusy] = useState(false)
  const [optError, setOptError] = useState('')
  const [previewKey, setPreviewKey] = useState(0)
  const [recordGone, setRecordGone] = useState(false)
  const closeRef = useRef(null)

  // Move focus into the drawer on mount so keyboard users land on Close.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const recordId = issue.record?.id
    if (!recordId) return
    setRecordGone(false)
    apiFetch(`${apiBase}/api/v1/assignments/${recordId}`, { headers: authHeaders() })
      .then((r) => { if (r.status === 404) setRecordGone(true) })
      .catch(() => { /* offline banner covers unreachable servers */ })
  }, [issue.record?.id, apiBase])
  const content = issue.record?.content ?? null
  const prov = issue.record?.provenance
  const prio = priorityOf(issue.difficulty)
  const stale = issue.stale === true

  function failMessage(res, data) {
    if (res.status === 404) {
      onMarkStale(issue.key)
      return 'This record was cleared on the service — regenerate the assignment to restore this feature.'
    }
    return data?.error ?? `Request failed. Please try again.`
  }

  function throwIfAuth(res) {
    if (res.status === 401) {
      onAuthRequired?.()
      throw new Error('Please log in to continue — then retry.')
    }
  }

  async function exportFile(kind) {
    const recordId = issue.record?.id
    if (!recordId) return
    setExportBusy(kind)
    setExportError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/${kind}`, {
        method: kind === 'pdf' ? 'POST' : 'GET',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: kind === 'pdf' ? '{}' : undefined,
        signal: AbortSignal.timeout(180000),
      })
      throwIfAuth(res)
      if (res.status === 404) {
        onMarkStale(issue.key)
        throw new Error('This record was cleared on the service — regenerate the assignment to restore exports.')
      }
      const ctype = res.headers.get('content-type') ?? ''
      if (!res.ok || ctype.includes('application/json')) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error ?? `Export failed. Please try again.`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${issue.key}-assignment.${kind === 'docx' ? 'docx' : 'pdf'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportBusy('')
    }
  }

  async function regenSection(section) {
    const recordId = issue.record?.id
    if (!recordId) return
    setRegenBusy(section)
    setEditError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/regenerate-section`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ section }),
        signal: AbortSignal.timeout(180000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      onRecordUpdate(issue.key, data)
      setDrafts((d) => ({ ...d, [section]: undefined }))
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setRegenBusy('')
    }
  }

  async function saveAllSections() {
    const recordId = issue.record?.id
    if (!recordId) return
    setEditError('')
    let next
    try {
      next = { ...issue.record.content }
      for (const s of EDITABLE_SECTIONS) {
        if (drafts[s] !== undefined) next[s] = sectionFromText(s, drafts[s])
      }
    } catch {
      setEditError('Invalid JSON in objectives / theory / steps — fix the syntax and retry.')
      return
    }
    setSaveBusy(true)
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}`, {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ content: next }),
        signal: AbortSignal.timeout(60000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      onRecordUpdate(issue.key, data)
      setDrafts({})
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaveBusy(false)
    }
  }

  async function loadLatex() {
    const recordId = issue.record?.id
    if (!recordId) return
    setLatexBusy(true)
    setLatexError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/latex`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(60000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      setLatex(data.latex ?? '')
    } catch (err) {
      setLatexError(err instanceof Error ? err.message : String(err))
    } finally {
      setLatexBusy(false)
    }
  }

  async function saveOptions(patch) {
    const recordId = issue.record?.id
    if (!recordId) return
    setOptBusy(true)
    setOptError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/options`, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(30000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save options. Please try again.")
      onRecordUpdate(issue.key, data)
      setPreviewKey((k) => k + 1)
    } catch (err) {
      setOptError(err instanceof Error ? err.message : String(err))
    } finally {
      setOptBusy(false)
    }
  }

  async function copyLatex() {
    if (latex === null) return
    try {
      await navigator.clipboard.writeText(latex)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = latex
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopiedLatex(true)
    setTimeout(() => setCopiedLatex(false), 1500)
  }

  return (
    <>
      <div
        className={cx('mk-backdrop fixed inset-0 z-40 bg-pine-950/30', shown && 'mk-show')}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={content?.title ?? issue.aim}
        className={cx(
          'mk-drawer fixed inset-x-0 bottom-0 top-8 z-50 flex flex-col overflow-hidden rounded-t-2xl bg-paper shadow-[0_0_48px_rgba(15,46,45,0.35)]',
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:rounded-l-2xl sm:rounded-tr-none sm:w-[440px] lg:w-[560px] 2xl:w-[620px]',
          shown ? 'mk-show' : 'mk-hide',
        )}
      >
        <div className="flex items-center gap-2 border-b border-line bg-white px-3.5 py-2.5 sm:px-4">
          <span className="rounded-md bg-rail px-2 py-1 text-[11px] font-bold tracking-wide text-ink-500">{issue.key}</span>
          <StatusBadge status={uiStatus(issue)} />
          <span className="ml-auto flex items-center gap-1">
            <button title="Download document" aria-label="Download document" onClick={onDownload} disabled={!issue.record || stale} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-rail hover:text-ink-900 disabled:opacity-40">
              <Icon name="download" className="h-4 w-4" />
            </button>
            <button title="Open document" aria-label="Open document" onClick={onOpenPreview} disabled={!issue.record || stale} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-rail hover:text-ink-900 disabled:opacity-40">
              <Icon name="external" className="h-4 w-4" />
            </button>
            <button title="Delete" aria-label="Delete assignment" onClick={() => setConfirmDelete(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-[#FDECEC] hover:text-[#8F1D17]">
              <Icon name="trash" className="h-4 w-4" />
            </button>
            <button ref={closeRef} title="Close panel" aria-label="Close panel" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-rail text-ink-700 transition-colors duration-150 hover:bg-rail-hover hover:text-ink-900">
              <Icon name="x" className="h-4 w-4" />
            </button>
          </span>
        </div>

        {confirmDelete && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B3261E]/20 bg-[#FDECEC] px-4 py-2.5">
            <p className="text-[13px] font-bold text-[#8F1D17]">Delete {issue.key} permanently?</p>
            <span className="flex gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
              <Button variant="danger" size="sm" onClick={() => onDelete(issue.key)}>
                Delete
              </Button>
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <h2 className="text-[19px] font-extrabold leading-snug tracking-tight">{content?.title ?? issue.aim}</h2>
          <p className="mt-1 text-[12.5px] text-ink-400">
            {fullDate(issue.createdAt)} · Updated {timeAgo(issue.updatedAt ?? issue.createdAt)}
            {issue.experimentNumber ? ` · Experiment ${issue.experimentNumber}` : ''}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-white p-3.5 text-[13px]">
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Subject</dt>
              <dd className="mt-1">
                <SubjectTag subject={issue.subject} />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Difficulty</dt>
              <dd className="mt-1 font-bold" style={{ color: prio.color }}>
                {prio.glyph} {prio.label}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Technology</dt>
              <dd className="mt-1 font-semibold">{issue.technology || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Template</dt>
              <dd className="mt-1 text-[12.5px] font-semibold">
                {issue.record?.template?.id ?? issue.templateId ?? 'default'}{' '}
                <span className="font-medium text-ink-300">v{issue.record?.template?.version ?? 1}</span>
              </dd>
            </div>
            {prov && (
              <div className="col-span-2">
                <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Provider</dt>
                <dd className="mt-1 text-[12.5px] font-semibold">
                  {prov.provider} · {prov.model}
                </dd>
              </div>
            )}
          </dl>

          {stale && (
            <div className="mt-4 rounded-xl border border-sand-400/50 bg-sand-50 p-4">
              <p className="text-[13px] font-bold text-sand-700">Stored document was cleared</p>
              <p className="mt-1 text-[12.5px] text-sand-700/90">
                The service restarted and no longer has this record. The content below stays readable — regenerate to
                restore the document preview, exports and editing.
              </p>
              <Button onClick={() => onRetry(issue.key)} className="mt-2.5" size="sm">
                <Icon name="refresh" className="h-4 w-4" />
                Regenerate assignment
              </Button>
            </div>
          )}

          {content && (
            <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-line bg-white px-3.5 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={issue.record.options?.includeVivaTitle === true}
                  disabled={optBusy}
                  onChange={(e) => saveOptions({ includeVivaTitle: e.target.checked })}
                  className="h-4 w-4 accent-[#1A4543]"
                />
                Viva Questions heading
                <span className="text-[12px] text-ink-400">(handwritten by faculty)</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={issue.record.options?.typedConclusion !== false}
                  disabled={optBusy}
                  onChange={(e) => saveOptions({ typedConclusion: e.target.checked })}
                  className="h-4 w-4 accent-[#1A4543]"
                />
                Typed conclusion
                <span className="text-[12px] text-ink-400">(uncheck for handwriting space)</span>
              </label>
              {optError && <p className="break-words text-[12px] text-[#8F1D17]">{optError}</p>}
            </div>
          )}

          {recordGone && (
            <div className="mt-4 rounded-xl border border-sand-400/50 bg-sand-50 p-4">
              <p className="text-[13px] font-bold text-sand-700">This preview expired</p>
              <p className="mt-1 text-[12.5px] text-sand-700/90">The service restarted and no longer holds this record. Retry generation to create a fresh one.</p>
              <Button onClick={() => onRetry(issue.key)} size="sm" className="mt-2.5">
                <Icon name="refresh" className="h-4 w-4" />
                Retry generation
              </Button>
            </div>
          )}

          {issue.status === 'inprogress' && (
            <div className="mt-4 flex flex-col gap-2.5 rounded-xl border border-pine-900/15 bg-pine-50 p-4">
              <div className="flex items-center gap-2 text-[13px] font-bold text-pine-900">
                <Spinner />
                Generating assignment…
              </div>
              <p className="text-[12.5px] text-pine-900/70">This usually takes under a minute. You can keep browsing — we&apos;ll notify you when it&apos;s ready.</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-pine-900/10">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-pine-800" />
              </div>
            </div>
          )}

          {issue.status === 'failed' && (
            <div className="mt-4 rounded-xl border border-[#B3261E]/20 bg-[#FDECEC] p-4">
              <p className="text-[13px] font-bold text-[#8F1D17]">Generation needs attention</p>
              <p className="mt-1 break-words text-[12.5px] text-[#8F1D17]/90">{issue.error || 'The service could not complete this request.'}</p>
              <Button variant="danger" size="sm" onClick={() => onRetry(issue.key)} className="mt-2.5">
                <Icon name="refresh" className="h-4 w-4" />
                Retry generation
              </Button>
            </div>
          )}

          {!content && issue.status !== 'inprogress' && issue.status !== 'failed' && (
            <div className="mt-4 rounded-xl border border-line bg-white p-4 text-[13px] text-ink-700">
              <p className="font-bold text-ink-900">Aim</p>
              <p className="mt-1">{issue.aim}</p>
              {issue.description && <p className="mt-2 text-ink-500">{issue.description}</p>}
              <Button onClick={() => onRetry(issue.key)} className="mt-3">
                <Icon name="send" className="h-4 w-4" />
                Generate assignment
              </Button>
            </div>
          )}

          {content && (
            <div className="mt-5 flex flex-col gap-6 pb-2">
              <section>
                <SectionHeading icon="send">Aim</SectionHeading>
                <p className="mt-1.5 rounded-lg bg-white px-3 py-2.5 text-[13px] leading-relaxed ring-1 ring-inset ring-line-soft">{content.aim}</p>
              </section>

              <section>
                <SectionHeading icon="check">Objectives · {content.objectives.length}</SectionHeading>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {content.objectives.map((o, i) => (
                    <li key={i} className="flex items-start gap-2.5 rounded-lg bg-white px-3 py-2 text-[13px] ring-1 ring-inset ring-line-soft">
                      <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-sage-100 text-pine-900 ring-1 ring-inset ring-sage-300/60">
                        <Icon name="check" className="h-3 w-3" />
                      </span>
                      {o}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <SectionHeading icon="book">Theory</SectionHeading>
                <div className="mt-1.5 flex flex-col gap-2.5">
                  {content.theory.map((t, i) => (
                    <p key={i} className="text-[13px] leading-relaxed text-ink-700">
                      {t}
                    </p>
                  ))}
                </div>
              </section>

              <section>
                <SectionHeading icon="list">Steps · {content.steps.length}</SectionHeading>
                <ol className="mt-2 flex flex-col gap-3">
                  {content.steps.map((s) => (
                    <li key={s.number} className="overflow-hidden rounded-xl border border-line bg-white">
                      <div className="flex items-center gap-2.5 border-b border-line-soft bg-paper px-3 py-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pine-900 text-[12px] font-bold text-white">
                          {s.number}
                        </span>
                        <p className="text-[13px] font-bold">{s.title}</p>
                      </div>
                      <div className="px-3 py-2.5">
                        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-700">
                          {s.description.map((d, j) => (
                            <li key={j}>{d}</li>
                          ))}
                        </ul>
                        {s.code && (
                          <div className="mt-2.5">
                            <CodeBlock code={s.code} language={s.language} />
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <SectionHeading icon="file">Conclusion</SectionHeading>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-700">{content.conclusion}</p>
              </section>

              {(issue.record?.sources?.length > 0) && (
                <section>
                  <SectionHeading icon="external">Sources used · {issue.record.sources.length}</SectionHeading>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {issue.record.sources.map((s, i) => (
                      <li key={i} className="rounded-lg bg-white px-3 py-2 text-[13px] ring-1 ring-inset ring-line-soft">
                        <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold text-pine-800 hover:underline">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!stale && (
                <section>
                  <SectionHeading icon="download">Exports</SectionHeading>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => exportFile('docx')} disabled={exportBusy !== ''}>
                      <Icon name="download" className="h-4 w-4" />
                      {exportBusy === 'docx' ? 'Preparing…' : 'Export DOCX'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => exportFile('pdf')} disabled={exportBusy !== ''}>
                      <Icon name="download" className="h-4 w-4" />
                      {exportBusy === 'pdf' ? 'Compiling…' : 'Export PDF'}
                    </Button>
                  </div>
                  {exportError && <p className="mt-2 break-words text-[12px] text-[#8F1D17]">{exportError}</p>}
                </section>
              )}

              {!stale && (
                <section>
                  <div className="flex items-center justify-between">
                    <SectionHeading icon="check">Edit sections</SectionHeading>
                    <button onClick={() => { setEditing((v) => !v); setEditError('') }} className="text-[12.5px] font-bold text-pine-800 hover:underline">
                      {editing ? 'Done' : 'Edit'}
                    </button>
                  </div>
                {editing && (
                  <div className="mt-2 flex flex-col gap-3">
                    {EDITABLE_SECTIONS.map((s) => (
                      <div key={s}>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-[12px] font-bold capitalize text-ink-700">{s}</p>
                          <button onClick={() => regenSection(s)} disabled={regenBusy !== ''} className="text-[12px] font-bold text-pine-800 hover:underline disabled:opacity-50">
                            {regenBusy === s ? 'Regenerating…' : 'Regenerate'}
                          </button>
                        </div>
                        <textarea
                          value={drafts[s] ?? sectionToText(s, content[s])}
                          onChange={(e) => setDrafts((d) => ({ ...d, [s]: e.target.value }))}
                          rows={['title', 'aim'].includes(s) ? 2 : 6}
                          spellCheck={false}
                          className="w-full rounded-lg border border-line bg-white px-2.5 py-2 font-mono text-[12px] leading-relaxed transition-colors focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15"
                        />
                      </div>
                    ))}
                    <div>
                      <Button onClick={saveAllSections} disabled={saveBusy} size="sm">
                        {saveBusy ? 'Saving…' : 'Save all sections'}
                      </Button>
                    </div>
                    {editError && <p className="break-words text-[12px] text-[#8F1D17]">{editError}</p>}
                  </div>
                )}
                </section>
              )}

              {!stale && (
                <section>
                  <div className="flex items-center justify-between">
                    <SectionHeading icon="file">LaTeX source</SectionHeading>
                    <button onClick={loadLatex} disabled={latexBusy} className="text-[12.5px] font-bold text-pine-800 hover:underline disabled:opacity-50">
                      {latex === null ? (latexBusy ? 'Loading…' : 'Load') : 'Reload'}
                    </button>
                  </div>
                {latex !== null && (
                  <div className="mt-2 overflow-hidden rounded-lg border border-line bg-white">
                    <div className="max-h-[50vh] overflow-auto">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line-soft bg-paper px-2.5 py-1.5">
                        <span className="text-[11px] font-bold text-ink-400">latex</span>
                        <button onClick={copyLatex} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-semibold text-ink-500 transition-colors hover:bg-rail">
                          <Icon name={copiedLatex ? 'check' : 'copy'} className="h-3.5 w-3.5" />
                          {copiedLatex ? 'Copied!' : 'Copy code'}
                        </button>
                      </div>
                      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed">{latex}</pre>
                    </div>
                    <p className="border-t border-line-soft px-2.5 py-1.5 text-[12px] text-ink-400">PDF export compiles this source in an isolated container.</p>
                  </div>
                )}
                {latexError && <p className="mt-2 break-words text-[12px] text-[#8F1D17]">{latexError}</p>}
                </section>
              )}

              {!stale && (
                <section>
                  <SectionHeading icon="file">Document preview</SectionHeading>
                  <p className="mt-1 text-[12px] text-ink-400">Department header and watermark applied on every page.</p>
                  <div className="mt-2 overflow-hidden rounded-xl border border-line bg-white">
                    <iframe title={`Document preview for ${issue.key}`} key={previewKey} src={`${apiBase}/api/v1/assignments/${issue.record.id}/html`} className="h-[420px] w-full bg-white" />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={onDownload}>
                      <Icon name="download" className="h-4 w-4" />
                      Download HTML
                    </Button>
                    <Button variant="secondary" size="sm" onClick={onOpenPreview}>
                      <Icon name="external" className="h-4 w-4" />
                      Print
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowRawJson((v) => !v)}>
                      <Icon name="copy" className="h-4 w-4" />
                      {showRawJson ? 'Hide JSON' : 'View JSON'}
                    </Button>
                  </div>
                  {showRawJson && (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-pine-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                      {JSON.stringify({ provenance: issue.record.provenance, content }, null, 2)}
                    </pre>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

/* ------------------------------- login modal ------------------------------ */

function LoginModal({ onClose, onLogin }) {
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
      const res = await apiFetch(`${API_BASE}/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? { email, password, name } : { email, password }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? "Couldn't log you in. Please try again.")
      onLogin({ token: data.token, email, name: mode === 'register' ? name : '' })
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

/* ------------------------------- create modal ------------------------------ */

function FormSection({ index, title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[11px] font-bold text-sand-600">{index}</span>
        <div>
          <h3 className="text-[13.5px] font-bold tracking-tight">{title}</h3>
          {hint && <p className="mt-0.5 text-[12.5px] text-ink-500">{hint}</p>}
        </div>
      </div>
      <div className="mt-3.5 flex flex-col gap-3.5">{children}</div>
    </section>
  )
}

function CreateModal({ initial, templates = [], onClose, onSubmit }) {
  const [form, setForm] = useState({
    aim: initial?.aim ?? '',
    description: initial?.description ?? '',
    subject: initial?.subject ?? 'DBMS',
    experimentNumber: initial?.experimentNumber ?? '',
    technology: initial?.technology ?? '',
    difficulty: initial?.difficulty ?? 'Intermediate',
    templateId: initial?.templateId ?? '',
    includeVivaTitle: initial?.includeVivaTitle ?? false,
    typedConclusion: initial?.typedConclusion ?? true,
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function submit(e) {
    e.preventDefault()
    if (submitting) return
    if (form.aim.trim().length < 4) {
      setError('Please describe the aim in at least 4 characters.')
      return
    }
    if (form.experimentNumber && !/^\d{1,3}$/.test(form.experimentNumber.trim())) {
      setError('Experiment number must be between 1 and 999.')
      return
    }
    setError('')
    setSubmitting(true)
    onSubmit(form)
  }

  return (
    <ModalShell
      title="Create assignment"
      subtitle="Describe the practical — Markly drafts the full department-ready document."
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => document.getElementById('create-form')?.requestSubmit()} disabled={submitting} size="lg">
            {submitting ? <Spinner className="h-4 w-4" /> : <Icon name="send" className="h-4 w-4" />}
            {submitting ? 'Generating…' : 'Generate assignment'}
          </Button>
        </div>
      }
    >
      <form id="create-form" onSubmit={submit} className="flex flex-col gap-3">
        <FormSection index="01" title="Basic information" hint="What is this practical about? Be specific — a clear aim produces a better document.">
          <Field label="Aim" htmlFor="f-aim" hint={`${form.aim.trim().length}/2000 characters. Example: “Explore subqueries in SQL”.`}>
            <input
              id="f-aim"
              value={form.aim}
              onChange={(e) => set('aim', e.target.value)}
              placeholder="e.g. Explore subqueries in SQL"
              className={cx(inputCls, 'font-medium')}
              maxLength={2000}
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="f-desc" hint="Optional context — scope, outcomes or constraints for this experiment.">
            <textarea
              id="f-desc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder="Context, scope or outcomes for this experiment…"
              className={inputCls}
              maxLength={4000}
            />
          </Field>
        </FormSection>

        <FormSection index="02" title="Experiment details" hint="Used for headers, filing and difficulty-appropriate depth.">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="Subject" htmlFor="f-subject">
              <select id="f-subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} className={inputCls}>
                {SUBJECTS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Experiment number" htmlFor="f-exp" hint="1–999. Shown as EXP-07 on cards and headers.">
              <input
                id="f-exp"
                value={form.experimentNumber}
                onChange={(e) => set('experimentNumber', e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                placeholder="7"
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="Technology" htmlFor="f-tech" hint="Optional — e.g. SQL, Java, Python.">
              <input id="f-tech" value={form.technology} onChange={(e) => set('technology', e.target.value)} placeholder="SQL, Java…" className={inputCls} maxLength={64} />
            </Field>
            <Field label="Difficulty" htmlFor="f-diff" hint="Controls depth of theory and steps.">
              <select id="f-diff" value={form.difficulty} onChange={(e) => set('difficulty', e.target.value)} className={inputCls}>
                {DIFFICULTIES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>
        </FormSection>

        <FormSection index="03" title="Document settings" hint="Format and finishing options for the final document.">
          <Field label="Template" htmlFor="f-template" hint="Department format. The active default is used when left empty.">
            <select id="f-template" value={form.templateId} onChange={(e) => set('templateId', e.target.value)} className={inputCls}>
              <option value="">Default (active template)</option>
              {templates.map((t) => (
                <option key={`${t.id}@${t.version}`} value={t.id}>
                  {t.name} v{t.version}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-2.5 ring-1 ring-inset ring-line-soft">
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input type="checkbox" checked={form.includeVivaTitle} onChange={(e) => set('includeVivaTitle', e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1A4543]" />
              <span>
                <span className="font-bold">Include Viva Questions heading</span>
                <span className="block text-[12.5px] text-ink-500">Heading only — questions are handwritten by faculty, never generated. Off for most experiments.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input type="checkbox" checked={form.typedConclusion} onChange={(e) => set('typedConclusion', e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1A4543]" />
              <span>
                <span className="font-bold">Type the conclusion</span>
                <span className="block text-[12.5px] text-ink-500">Uncheck to leave handwriting space (the conclusion itself is compulsory).</span>
              </span>
            </label>
          </div>
        </FormSection>

        {error && <p className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[13px] font-medium text-[#8F1D17]">{error}</p>}
        {submitting && (
          <div className="flex items-center gap-2.5 rounded-xl border border-pine-900/15 bg-pine-50 px-3.5 py-3">
            <Spinner />
            <p className="text-[13px] font-semibold text-pine-900">Generating assignment…</p>
          </div>
        )}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1}>submit</button>
      </form>
    </ModalShell>
  )
}

