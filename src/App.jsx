import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  cx,
} from './components/ui.jsx'
import { Icon, LogoMark } from './components/icons.jsx'

import { useAuth } from './contexts/AuthContext.jsx'
import { API_BASE, apiFetch, authHeaders } from './services/api.js'
import { firstNameOf } from './features/auth/identity.js'
import { LoginModal } from './features/auth/LoginModal.jsx'
import { ProfileMenu, ProfileModal } from './features/auth/ProfileMenu.jsx'

import { materializeJobCard, mergeServerIssues, pickGreeting, recordToIssue, uiStatus } from './features/assignments/data.js'
import { GenerationPill } from './features/assignments/AssignmentUI.jsx'
import { DashboardView } from './views/DashboardView.jsx'
import { AssignmentsView } from './views/AssignmentsView.jsx'
import { HistoryView } from './views/HistoryView.jsx'
import { TemplatesView } from './views/TemplatesView.jsx'
import { AdminView } from './views/AdminView.jsx'
import { DetailDrawer } from './features/assignments/DetailDrawer.jsx'
import { CreateModal } from './features/assignments/CreateModal.jsx'
import { PreferencesModal } from './features/preferences/PreferencesModal.jsx'
import { describePreferencesSummary } from './features/preferences/preferences.js'
import { fetchPreferences } from './features/preferences/preferencesApi.js'

/* ---------------------------------- app ------------------------------------ */

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'assignments', label: 'Assignments', icon: 'file' },
  { id: 'history', label: 'History', icon: 'archive' },
  { id: 'templates', label: 'Templates', icon: 'grid' },
]

export default function App() {
  const [issues, setIssues] = useState([])
  const [bootLoading, setBootLoading] = useState(true)
  const [bootError, setBootError] = useState('')
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
  // STAGE 4: the persisted college/branch snapshot drives first-time setup and
  // template preselection. It is fetched separately from /auth/me so the modal
  // can show branch defaults without a second session bootstrap.
  const [preferences, setPreferences] = useState(null)
  const [preferencesLoading, setPreferencesLoading] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferencesStacked, setPreferencesStacked] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(false)
  // Single source of truth for authentication: AuthContext owns user,
  // status, login/logout and the /me bootstrap. This component only reads.
  const auth = useAuth()
  const session = auth.user
  const isAdmin = session?.role === 'platform_admin' || session?.role === 'college_admin'
  const navItems = useMemo(
    () => (isAdmin ? [...NAV, { id: 'admin', label: 'Admin', icon: 'list' }] : NAV),
    [isAdmin],
  )
  // Selected once per visit (and re-picked on each fresh login) — never
  // re-rolled on re-render, so the line stays stable for the whole session.
  const [greeting, setGreeting] = useState(() => pickGreeting())
  // Assignments workspace state
  const [query, setQuery] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('All subjects')
  const [statusFilter, setStatusFilter] = useState('All statuses')
  const [sortBy, setSortBy] = useState('Recently updated')
  const toastId = useRef(0)

  const pushToast = useCallback((kind, title, message) => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, kind, title, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }, [])

  const handleAuthRequired = useCallback(() => {
    setLoginOpen(true)
    pushToast('error', 'Login required', 'Please log in to continue — then retry the action.')
  }, [pushToast])

  // Gate for user-initiated protected actions (Generate, exports, …).
  // Reads AuthContext status — never a token field. Loading/error states
  // refuse quietly WITHOUT opening the login modal: bootstrap is not
  // logged-out, and connectivity failures are not auth failures.
  const ensureSession = useCallback(() => {
    if (auth.status === 'authenticated') return true
    if (auth.status === 'loading') {
      pushToast('error', 'Still signing you in', 'Authentication is still loading — please try again in a moment.')
      return false
    }
    if (auth.status === 'error') {
      pushToast('error', "Couldn't reach the Markly service", 'Check your connection and try again.')
      return false
    }
    handleAuthRequired()
    return false
  }, [handleAuthRequired, pushToast, auth.status])

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

  const openPreferences = useCallback((stacked = false) => {
    setPreferencesStacked(Boolean(stacked))
    if (!stacked) setProfileOpen(false)
    setPreferencesOpen(true)
  }, [])

  const closePreferences = useCallback(() => {
    setPreferencesOpen(false)
    setPreferencesStacked(false)
    // "Not now" on the first-time setup is a dismissal for this session: it
    // must not immediately reopen just because the create modal changed.
    if (preferences?.setupCompleted === false) setSetupDismissed(true)
  }, [preferences])

  const handlePreferencesSaved = useCallback(
    async (saved) => {
      setPreferences(saved)
      setPreferencesOpen(false)
      setSetupDismissed(true)
      await Promise.all([auth.refreshSession(), refreshTemplates()])
      pushToast('success', 'Preferences saved', describePreferencesSummary(saved))
    },
    [auth, refreshTemplates, pushToast],
  )

  // Fetch the persisted preference snapshot once auth is known. A 503 in
  // memory-only mode is not an error the user should see: setup stays closed
  // and the app keeps its legacy template behaviour.
  useEffect(() => {
    if (!auth.initialized) return undefined
    if (!auth.isAuthenticated || !session?.id) {
      setPreferences(null)
      setPreferencesLoading(false)
      return undefined
    }
    let alive = true
    setPreferencesLoading(true)
    fetchPreferences()
      .then((data) => {
        if (alive) setPreferences(data)
      })
      .catch(() => {
        if (alive) setPreferences(null)
      })
      .finally(() => {
        if (alive) setPreferencesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [auth.initialized, auth.isAuthenticated, session?.id])

  // A fresh login may complete setup; dismissing it only lasts for that
  // session, and a saved setup (setupCompleted=true) never reopens.
  useEffect(() => {
    setSetupDismissed(false)
  }, [session?.id, auth.status])

  const setupRequired = Boolean(
    auth.isAuthenticated &&
      !preferencesLoading &&
      preferences &&
      preferences.setupCompleted === false,
  )

  useEffect(() => {
    if (!setupRequired || setupDismissed) return
    setPreferencesStacked((current) => current || createOpen)
    setPreferencesOpen(true)
  }, [setupRequired, setupDismissed, createOpen])

  // Service health is session-independent: always check once on mount.
  useEffect(() => {
    let alive = true
    apiFetch(`${API_BASE}/api/v1/health`)
      .then((r) => { if (alive) setServiceUp(r.ok) })
      .catch(() => { if (alive) setServiceUp(false) })
    return () => { alive = false }
  }, [])

  // Protected data fetching starts ONLY when auth state is known
  // (AuthContext initialized). Nothing fires while status is loading, so a
  // slow /me can never race into an empty board or a false logged-out view.
  // Logged-out users still load shared records in open dev mode; under
  // AUTH_REQUIRED=1 unauthenticated fetches 401 and stay empty. A 401 here
  // reconciles AuthContext centrally via the apiFetch hook (no modal storm).
  // Re-runs on every auth transition: login reloads the board as the owner,
  // logout reloads the logged-out view (logout() pre-clears above so nothing
  // stale flashes in between).
  useEffect(() => {
    if (!auth.initialized) return
    let alive = true
    setBootLoading(true)
    setBootError('')
    apiFetch(`${API_BASE}/api/v1/templates`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) setTemplates(d.templates ?? []) })
      .catch(() => { if (alive) setTemplates([]) })
    apiFetch(`${API_BASE}/api/v1/assignments`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        // Merge, never blind-replace: a replace here wipes in-flight job
        // cards resumed from /jobs whenever this fetch resolves after it.
        setIssues((prev) => mergeServerIssues(prev, d.assignments ?? []))
        setBootLoading(false)
      })
      .catch((err) => {
        if (!alive) return
        setBootError(err instanceof Error ? err.message : String(err))
        setBootLoading(false)
      })
    // Resume generations still running (e.g. after a mid-generation refresh):
    // active jobs become local generating cards; the ticker finishes them.
    // Completed jobs need no card — their assignments arrive via the list.
    apiFetch(`${API_BASE}/api/v1/jobs`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => {
        if (!alive) return
        const active = (d.jobs ?? []).filter((j) => j && j.status !== 'completed' && j.status !== 'failed')
        if (active.length === 0) return
        setIssues((prev) => {
          const known = new Set(prev.map((it) => it.jobId).filter(Boolean))
          const resumed = []
          for (const j of active) {
            if (!j?.id || known.has(j.id)) continue
            const input = j.input ?? {}
            resumed.push({
              key: `job_${j.id}`,
              jobId: j.id,
              aim: input.aim ?? 'Generating assignment',
              description: input.description ?? '',
              subject: input.subject ?? 'DBMS',
              experimentNumber: input.experimentNumber != null ? String(input.experimentNumber) : '',
              technology: input.technology ?? '',
              difficulty: input.difficulty ?? 'Intermediate',
              templateId: input.templateId ?? '',
              templateVersion: input.templateVersion != null ? String(input.templateVersion) : '',
              includeVivaTitle: input.includeVivaTitle ?? false,
              typedConclusion: input.typedConclusion ?? true,
              status: 'inprogress',
              error: '',
              stale: false,
              record: null,
              createdAt: j.createdAt ?? new Date().toISOString(),
              updatedAt: j.updatedAt ?? new Date().toISOString(),
            })
          }
          return resumed.length > 0 ? [...resumed, ...prev] : prev
        })
      })
      .catch(() => { /* board stands on its own */ })
    return () => { alive = false }
  }, [auth.initialized, auth.status])

  // A role downgrade (or logout) must not leave an administrator-only view
  // mounted. The API still rejects every request, but returning to the
  // dashboard avoids showing stale admin data.
  useEffect(() => {
    if (view === 'admin' && !isAdmin) setView('dashboard')
  }, [view, isAdmin])

  // Single logout path reused by every profile surface: AuthContext clears
  // the server cookie and local state; the board is cleared immediately so no
  // stale records flash, and the gated fetch below reloads the logged-out
  // view (empty under AUTH_REQUIRED=1, shared records in open dev mode).
  const logout = useCallback(async () => {
    await auth.logout()
    closeDrawer()
    setIssues([])
    setTemplates([])
    setPreferences(null)
    setPreferencesOpen(false)
    setSetupDismissed(false)
    pushToast('success', 'Logged out', 'Session cleared.')
  }, [auth, closeDrawer, pushToast])

  // Normalizes board fields into a POST /jobs generate input. Shared by
  // fresh creation and retries so both commit through the same job path.
  function toJobInput(source) {
    return {
      aim: (source.aim ?? '').trim(),
      description: (source.description ?? '').trim() || undefined,
      subject: source.subject,
      experimentNumber: source.experimentNumber ? Number(source.experimentNumber) : undefined,
      technology: (source.technology ?? '').trim() || undefined,
      templateId: source.templateId || undefined,
      templateVersion: source.templateVersion ? Number(source.templateVersion) : undefined,
      difficulty: source.difficulty || undefined,
      includeVivaTitle: source.includeVivaTitle ?? source.record?.options?.includeVivaTitle ?? false,
      typedConclusion: source.typedConclusion ?? source.record?.options?.typedConclusion ?? true,
    }
  }

  // Single-flight + once-only completion toasts across overlapping poll ticks.
  const pollingRef = useRef(new Set())
  const notifiedRef = useRef(new Set())
  function notifyOnce(key, kind, title, message) {
    if (notifiedRef.current.has(key)) return
    notifiedRef.current.add(key)
    pushToast(kind, title, message)
  }

  // Polls one tracked job to completion. Transient failures (network, 5xx,
  // mid-flight 401s) are ignored — the next tick retries and the central
  // 401 hook owns auth state. Only terminal transitions touch the board.
  const pollJob = useCallback(
    async (issue) => {
      const key = issue.key
      if (!issue.jobId || pollingRef.current.has(key)) return
      pollingRef.current.add(key)
      try {
        let res
        try {
          res = await apiFetch(`${API_BASE}/api/v1/jobs/${issue.jobId}`, {
            headers: authHeaders(),
            signal: AbortSignal.timeout(15000),
          })
        } catch {
          return // transient: next tick
        }
        if (res.status === 404) {
          // API restarted and forgot the job: fail loudly with a retry path.
          setIssues((prev) => prev.map((it) => (it.key === key && it.status === 'inprogress'
            ? { ...it, status: 'failed', error: 'The service restarted and lost track of this generation. Retry to start a fresh one.' }
            : it)))
          notifyOnce(`gone-${key}`, 'error', `${key} failed`, 'The service restarted and lost track of this generation.')
          return
        }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) return // transient: next tick
        const job = data.job
        if (!job) return
        if (job.status === 'completed' && job.assignmentId) {
          let rec
          try {
            rec = await apiFetch(`${API_BASE}/api/v1/assignments/${job.assignmentId}`, {
              headers: authHeaders(),
              signal: AbortSignal.timeout(30000),
            })
          } catch {
            return // transient: next tick
          }
          if (rec.status === 401 || rec.status === 404) {
            if (rec.status === 404) {
              setIssues((prev) => prev.map((it) => (it.key === key && it.status === 'inprogress'
                ? { ...it, status: 'failed', error: 'The generated assignment is no longer on the service. Retry to start a fresh one.' }
                : it)))
              notifyOnce(`lost-${key}`, 'error', `${key} failed`, 'The generated assignment is no longer on the service.')
            }
            return
          }
          const record = await rec.json().catch(() => ({}))
          if (!rec.ok || !record?.content) return // transient: next tick
          setIssues((prev) => materializeJobCard(prev, key, record))
          // Follow with the open drawer so generation finishes in the same
          // panel (no animation restart) — mirrors the old direct flow.
          if (drawerKey === key) {
            setDrawerKey(record.id)
            setDrawerShown(true)
          }
          notifyOnce(`done-${key}`, 'success', `${record.id} generated`, 'Assignment content is ready for review.')
        } else if (job.status === 'failed') {
          setIssues((prev) => prev.map((it) => (it.key === key && it.status === 'inprogress'
            ? { ...it, status: 'failed', error: (job.error ?? 'Generation failed. Please try again.') }
            : it)))
          notifyOnce(`failed-${key}`, 'error', `${key} failed`, (job.error ?? 'Generation failed. Please try again.'))
        }
        // else still running: next tick
      } finally {
        pollingRef.current.delete(key)
      }
    },
    [pushToast, drawerKey],
  )

  // One ticker for every tracked in-flight generation (created here or
  // resumed after refresh). Stops by itself when nothing is in flight.
  useEffect(() => {
    if (auth.status === 'loading') return undefined
    const active = issues.filter((it) => it.jobId && it.status === 'inprogress')
    if (active.length === 0) return undefined
    const timer = setInterval(() => {
      active.forEach((it) => {
        pollJob(it)
      })
    }, 2500)
    return () => clearInterval(timer)
  }, [issues, auth.status, pollJob])

  const runGeneration = useCallback(
    async (key) => {
      const issue = issues.find((it) => it.key === key)
      if (!issue || issue.status === 'inprogress') return
      if (!ensureSession()) return
      let job
      try {
        const res = await apiFetch(`${API_BASE}/api/v1/jobs`, {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ type: 'generate', input: toJobInput(issue) }),
          signal: AbortSignal.timeout(30000),
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          handleAuthRequired()
          return
        }
        if (!res.ok || !data?.job?.id) throw new Error(data?.error ? String(data.error) : `Request failed. Please try again.`)
        job = data.job
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setIssues((prev) => prev.map((it) => (it.key === key ? { ...it, status: 'failed', error: message } : it)))
        pushToast('error', `${key} failed`, message)
        return
      }
      setIssues((prev) => prev.map((it) => (it.key === key
        ? { ...it, jobId: job.id, status: 'inprogress', error: '', stale: false, updatedAt: new Date().toISOString() }
        : it)))
    },
    [issues, pushToast, ensureSession, handleAuthRequired],
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
    async (form) => {
      if (!ensureSession()) return
      const draft = {
        aim: form.aim.trim(),
        description: form.description.trim(),
        subject: form.subject,
        experimentNumber: form.experimentNumber.trim(),
        technology: form.technology.trim(),
        difficulty: form.difficulty,
        templateId: form.templateId || undefined,
        templateVersion: form.templateVersion ? Number(form.templateVersion) : undefined,
        includeVivaTitle: form.includeVivaTitle,
        typedConclusion: form.typedConclusion,
        record: null,
      }
      // Commit through the jobs API (not a direct generate POST): the job is
      // the server-side handle, so a refresh mid-generation loses nothing —
      // boot re-lists active jobs and the ticker resumes polling.
      let job
      try {
        const res = await apiFetch(`${API_BASE}/api/v1/jobs`, {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ type: 'generate', input: toJobInput(draft) }),
          signal: AbortSignal.timeout(30000),
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          handleAuthRequired()
          return
        }
        if (!res.ok || !data?.job?.id) throw new Error(data?.error ? String(data.error) : `Request failed. Please try again.`)
        job = data.job
      } catch (err) {
        pushToast('error', 'Generation failed', err instanceof Error ? err.message : String(err))
        return
      }
      const now = new Date().toISOString()
      const key = `job_${job.id}`
      const issue = {
        ...draft,
        key,
        jobId: job.id,
        status: 'inprogress',
        error: '',
        stale: false,
        createdAt: now,
        updatedAt: now,
      }
      setIssues((prev) => [issue, ...prev])
      setCreateOpen(false)
      setPrefill(null)
      setView('assignments')
      openDrawer(key)
    },
    [ensureSession, handleAuthRequired, pushToast, openDrawer],
  )

  const deleteIssue = useCallback(
    async (key) => {
      const target = issues.find((it) => it.key === key)
      const recordId = target?.record?.id
      // Cards still generating have no record yet: dropping the local card
      // only. The server job keeps running and boot resume will surface it
      // again while active; once completed it is a normal deletable record.
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
          {navItems.map((n) => {
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
              onOpenPreferences={() => openPreferences(false)}
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
                  onOpenPreferences={() => openPreferences(false)}
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
            {navItems.map((n) => {
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
              onUseTemplate={(t) => { setPrefill({ templateId: t.id, templateVersion: t.version }); setCreateOpen(true) }}
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
            // Keyed by auth status: logging out (or in) while viewing the
            // archive remounts it, so it refetches instead of showing the
            // previous user's rows.
            <HistoryView
              key={auth.status}
              onImport={importRecordToBoard}
            />
          )}

          {view === 'templates' && (
            <TemplatesView
              templates={templates}
              onRefresh={refreshTemplates}
              notify={pushToast}
              onUse={(t) => { setPrefill({ templateId: t.id, templateVersion: t.version }); setCreateOpen(true) }}
              onAuthRequired={handleAuthRequired}
              session={session}
            />
          )}

          {view === 'admin' && isAdmin && (
            <AdminView
              session={session}
              notify={pushToast}
              onAuthRequired={handleAuthRequired}
              onOpenTemplates={() => setView('templates')}
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
          onRecordUpdate={(key, record) => setIssues((prev) => prev.map((it) => (it.key === key ? { ...recordToIssue(record), key: it.key } : it)))}
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
          preferences={preferences}
          onOpenPreferences={() => openPreferences(true)}
          onClose={() => {
            setCreateOpen(false)
            setPrefill(null)
          }}
          onSubmit={createIssue}
        />
      )}

      {preferencesOpen && (
        <PreferencesModal
          initialPreferences={preferences}
          templates={templates}
          firstTime={Boolean(preferences && preferences.setupCompleted === false)}
          stacked={preferencesStacked}
          onClose={closePreferences}
          onSaved={handlePreferencesSaved}
        />
      )}

      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={(user) => {
            // AuthContext already holds the authenticated profile (name/avatar
            // resolved server-side via /me). UI follow-ups only.
            setLoginOpen(false)
            setGreeting(pickGreeting())
            refreshTemplates()
            pushToast('success', `Welcome back, ${firstNameOf(user)}`, user.email)
          }}
        />
      )}

      {profileOpen && session && (
        <ProfileModal
          session={session}
          preferences={preferences}
          onOpenPreferences={() => openPreferences(false)}
          onClose={() => setProfileOpen(false)}
        />
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



