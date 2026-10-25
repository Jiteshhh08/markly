import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  LoadingRows,
  PageHeader,
  Select,
  inputCls,
} from '../components/ui.jsx'
import { Icon } from '../components/icons.jsx'
import { adminRequest, describeApiError } from '../features/admin/adminApi.js'

// STAGE 3 administration surface. All data comes from /api/v1/admin, which
// authenticates the persisted user on every request and scopes college admins
// to their assigned colleges. This view never decides access on its own: it
// only hides affordances that the API would reject anyway.

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'colleges', label: 'Colleges & branches' },
  { id: 'audit', label: 'Admin actions' },
]

const ROLE_LABEL = {
  platform_admin: 'Platform administrator',
  college_admin: 'College administrator',
  user: 'User',
}

function statusTone(status) {
  if (status === 'active' || status === 'published') return 'teal'
  if (status === 'draft') return 'sand'
  if (status === 'archived' || status === 'inactive') return 'neutral'
  return 'neutral'
}

function statusLabel(status, kind = 'entity') {
  if (status === 'active') return kind === 'template' ? 'Published' : 'Active'
  if (status === 'inactive') return 'Inactive'
  return status ? status[0].toUpperCase() + status.slice(1) : 'Unknown'
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function parseMetadata(text) {
  const value = String(text ?? '').trim()
  if (!value) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Metadata must be a JSON object.')
  }
  return parsed
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-700">
      <span>{label}</span>
      {children}
      {hint && <span className="text-[11.5px] font-normal text-ink-400">{hint}</span>}
    </label>
  )
}

function StatCard({ label, value, tone = 'plain', hint }) {
  return (
    <div className="rounded-xl border border-line bg-white p-3.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-400">{label}</p>
      <p className={`mt-1 text-[24px] font-extrabold leading-none ${tone === 'sand' ? 'text-sand-700' : tone === 'sage' ? 'text-sage-700' : 'text-ink-900'}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[11.5px] text-ink-400">{hint}</p>}
    </div>
  )
}

export function AdminView({ session, notify, onAuthRequired, onOpenTemplates }) {
  const [tab, setTab] = useState('overview')
  const [dashboard, setDashboard] = useState(null)
  const [colleges, setColleges] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [selectedCollegeId, setSelectedCollegeId] = useState('')
  const [detail, setDetail] = useState(null)
  const [admins, setAdmins] = useState([])
  const [audit, setAudit] = useState([])
  const [branchTemplates, setBranchTemplates] = useState({})
  const [defaultChoice, setDefaultChoice] = useState({})

  const isPlatformAdmin = session?.role === 'platform_admin'
  const canManageCollege = isPlatformAdmin

  const [newCollege, setNewCollege] = useState({ open: false, name: '', slug: '', status: 'active', metadata: '{}' })
  const [editCollege, setEditCollege] = useState(null)
  const [newBranch, setNewBranch] = useState({ name: '', slug: '', status: 'active', metadata: '{}' })
  const [editBranch, setEditBranch] = useState(null)
  const [adminEmail, setAdminEmail] = useState('')

  const fail = useCallback(
    (err) => {
      if (err?.status === 401) {
        onAuthRequired?.()
        return
      }
      setError(describeApiError(err))
    },
    [onAuthRequired],
  )

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [dashboardData, collegeData] = await Promise.all([
        adminRequest('/dashboard'),
        adminRequest('/colleges'),
      ])
      setDashboard(dashboardData)
      setColleges(collegeData.colleges ?? [])
    } catch (err) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }, [fail])

  const loadAudit = useCallback(async () => {
    try {
      const data = await adminRequest('/audit?limit=50')
      setAudit(data.actions ?? [])
    } catch (err) {
      fail(err)
    }
  }, [fail])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    if (tab === 'audit') loadAudit()
  }, [tab, loadAudit])

  const selectedCollege = useMemo(
    () => colleges.find((college) => college.id === selectedCollegeId) ?? detail?.college ?? null,
    [colleges, selectedCollegeId, detail],
  )

  const loadCollege = useCallback(
    async (collegeId) => {
      if (!collegeId) {
        setDetail(null)
        setAdmins([])
        return
      }
      setBusy(`college:${collegeId}`)
      try {
        const [detailData, adminData] = await Promise.all([
          adminRequest(`/colleges/${encodeURIComponent(collegeId)}`),
          adminRequest(`/colleges/${encodeURIComponent(collegeId)}/admins`),
        ])
        setDetail(detailData)
        setAdmins(adminData.admins ?? [])
      } catch (err) {
        fail(err)
      } finally {
        setBusy('')
      }
    },
    [fail],
  )

  useEffect(() => {
    if (!selectedCollegeId) return
    loadCollege(selectedCollegeId)
  }, [selectedCollegeId, loadCollege])

  async function afterMutation(message, { reloadAudit = false } = {}) {
    notify('success', message.title, message.body)
    setError('')
    await loadAll()
    if (selectedCollegeId) await loadCollege(selectedCollegeId)
    if (reloadAudit || tab === 'audit') await loadAudit()
  }

  async function createCollege(e) {
    e.preventDefault()
    setError('')
    let metadata
    try {
      metadata = parseMetadata(newCollege.metadata)
    } catch (err) {
      setError(err.message)
      return
    }
    setBusy('college:create')
    try {
      const data = await adminRequest('/colleges', {
        method: 'POST',
        body: {
          name: newCollege.name.trim(),
          slug: newCollege.slug.trim() || undefined,
          status: newCollege.status,
          metadata,
        },
      })
      setNewCollege({ open: false, name: '', slug: '', status: 'active', metadata: '{}' })
      setSelectedCollegeId(data.college.id)
      await afterMutation(
        { title: 'College created', body: `${data.college.name} is ready for branches and templates.` },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function saveCollege(e) {
    e.preventDefault()
    if (!editCollege) return
    setError('')
    let metadata
    try {
      metadata = parseMetadata(editCollege.metadata)
    } catch (err) {
      setError(err.message)
      return
    }
    setBusy(`college:${editCollege.id}`)
    try {
      await adminRequest(`/colleges/${encodeURIComponent(editCollege.id)}`, {
        method: 'PATCH',
        body: {
          name: editCollege.name.trim(),
          slug: editCollege.slug.trim(),
          status: editCollege.status,
          metadata,
        },
      })
      setEditCollege(null)
      await afterMutation(
        { title: 'College updated', body: 'The college details were saved.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function toggleCollegeStatus(college) {
    const next = college.status === 'active' ? 'inactive' : 'active'
    setError('')
    setBusy(`college:${college.id}`)
    try {
      await adminRequest(`/colleges/${encodeURIComponent(college.id)}`, {
        method: 'PATCH',
        body: { status: next },
      })
      await afterMutation(
        {
          title: next === 'active' ? 'College activated' : 'College deactivated',
          body:
            next === 'active'
              ? `${college.name} can be used again.`
              : `${college.name} is inactive; existing data is preserved.`,
        },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function addAdmin(e) {
    e.preventDefault()
    if (!selectedCollege) return
    setError('')
    setBusy('admin:add')
    try {
      await adminRequest(`/colleges/${encodeURIComponent(selectedCollege.id)}/admins`, {
        method: 'POST',
        body: { email: adminEmail.trim() },
      })
      setAdminEmail('')
      await afterMutation(
        { title: 'College administrator assigned', body: 'The account now manages this college.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function removeAdmin(admin) {
    if (!selectedCollege) return
    setError('')
    setBusy(`admin:${admin.id}`)
    try {
      await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/admins/${encodeURIComponent(admin.id)}`,
        { method: 'DELETE' },
      )
      await afterMutation(
        { title: 'College administrator removed', body: 'Their access to this college was revoked.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function createBranch(e) {
    e.preventDefault()
    if (!selectedCollege) return
    setError('')
    let metadata
    try {
      metadata = parseMetadata(newBranch.metadata)
    } catch (err) {
      setError(err.message)
      return
    }
    setBusy('branch:create')
    try {
      await adminRequest(`/colleges/${encodeURIComponent(selectedCollege.id)}/branches`, {
        method: 'POST',
        body: {
          name: newBranch.name.trim(),
          slug: newBranch.slug.trim() || undefined,
          status: newBranch.status,
          metadata,
        },
      })
      setNewBranch({ name: '', slug: '', status: 'active', metadata: '{}' })
      await afterMutation(
        { title: 'Branch created', body: `The branch was added to ${selectedCollege.name}.` },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function saveBranch(e) {
    e.preventDefault()
    if (!editBranch || !selectedCollege) return
    setError('')
    let metadata
    try {
      metadata = parseMetadata(editBranch.metadata)
    } catch (err) {
      setError(err.message)
      return
    }
    setBusy(`branch:${editBranch.id}`)
    try {
      await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/branches/${encodeURIComponent(editBranch.id)}`,
        {
          method: 'PATCH',
          body: {
            name: editBranch.name.trim(),
            slug: editBranch.slug.trim(),
            status: editBranch.status,
            metadata,
          },
        },
      )
      setEditBranch(null)
      await afterMutation(
        { title: 'Branch updated', body: 'The branch details were saved.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function toggleBranchStatus(branch) {
    if (!selectedCollege) return
    const next = branch.status === 'active' ? 'inactive' : 'active'
    setError('')
    setBusy(`branch:${branch.id}`)
    try {
      await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/branches/${encodeURIComponent(branch.id)}`,
        { method: 'PATCH', body: { status: next } },
      )
      await afterMutation(
        {
          title: next === 'active' ? 'Branch activated' : 'Branch deactivated',
          body:
            next === 'active'
              ? `${branch.name} is available again.`
              : `${branch.name} is inactive; its templates and history are preserved.`,
        },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function loadBranchTemplates(branch) {
    if (!selectedCollege) return
    setBusy(`templates:${branch.id}`)
    setError('')
    try {
      const data = await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/branches/${encodeURIComponent(branch.id)}/templates`,
      )
      setBranchTemplates((prev) => ({ ...prev, [branch.id]: data.templates ?? [] }))
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function setBranchDefault(branch) {
    if (!selectedCollege) return
    const choice = defaultChoice[branch.id]
    if (!choice) {
      setError('Choose a published template version first.')
      return
    }
    const [templateId, version] = choice.split('@')
    setBusy(`default:${branch.id}`)
    setError('')
    try {
      await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/branches/${encodeURIComponent(branch.id)}/default-template`,
        { method: 'PUT', body: { templateId, templateVersion: Number(version) } },
      )
      await afterMutation(
        { title: 'Branch default updated', body: 'New generations in this branch use the pinned version.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function clearBranchDefault(branch) {
    if (!selectedCollege) return
    setBusy(`default:${branch.id}`)
    setError('')
    try {
      await adminRequest(
        `/colleges/${encodeURIComponent(selectedCollege.id)}/branches/${encodeURIComponent(branch.id)}/default-template`,
        { method: 'PUT', body: { templateId: null } },
      )
      await afterMutation(
        { title: 'Branch default cleared', body: 'No default template is pinned for this branch.' },
        { reloadAudit: true },
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  const recentTemplates = dashboard?.recentTemplates ?? []
  const recentActions = dashboard?.recentActions ?? []
  const stats = dashboard?.stats ?? {}

  return (
    <div className="mk-rise flex flex-col gap-4">
      <PageHeader
        title="Administration"
        description="Manage colleges, branches, shared templates and the audit trail. Private templates remain visible only to their owners."
        meta={<Badge tone={isPlatformAdmin ? 'teal' : 'sand'}>{ROLE_LABEL[session?.role] ?? 'Administrator'}</Badge>}
        actions={
          <Button variant="secondary" onClick={onOpenTemplates}>
            <Icon name="grid" className="h-4 w-4" />
            Template management
          </Button>
        }
      />

      <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1" role="tablist" aria-label="Administration sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${
              tab === item.id ? 'bg-pine-900 text-white' : 'text-ink-500 hover:bg-rail hover:text-ink-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#B3261E]/25 bg-[#FDECEC] px-3.5 py-3 text-[13px] text-[#8F1D17]">
          <Icon name="x" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError('')} className="rounded p-0.5 hover:bg-white/60" aria-label="Dismiss error">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <LoadingRows count={4} />
      ) : tab === 'overview' ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Colleges" value={stats.colleges ?? 0} />
            <StatCard label="Branches" value={stats.branches ?? 0} />
            <StatCard label="Templates" value={stats.templates ?? 0} />
            <StatCard label="Drafts" value={stats.draft ?? 0} tone="sand" />
            <StatCard label="Published" value={stats.published ?? 0} tone="sage" />
            <StatCard label="Archived" value={stats.archived ?? 0} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[13.5px] font-bold">Recent templates</h2>
                <button onClick={onOpenTemplates} className="text-[12.5px] font-bold text-pine-800 hover:text-pine-950">
                  Manage
                </button>
              </div>
              {recentTemplates.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-500">No shared templates are visible in your scope yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line-soft">
                  {recentTemplates.map((template) => (
                    <li key={`${template.id}@${template.version}`} className="flex items-center gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-bold">{template.name}</p>
                        <p className="truncate text-[11.5px] text-ink-400">
                          v{template.version} · {template.scope} · {template.tenantId ?? 'global'}
                        </p>
                      </div>
                      <Badge tone={statusTone(template.status)}>{statusLabel(template.status, 'template')}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[13.5px] font-bold">Recent admin actions</h2>
                <button onClick={() => setTab('audit')} className="text-[12.5px] font-bold text-pine-800 hover:text-pine-950">
                  View all
                </button>
              </div>
              {recentActions.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-500">No administrative actions recorded in your scope yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line-soft">
                  {recentActions.slice(0, 6).map((entry) => (
                    <li key={entry.id} className="py-2">
                      <p className="text-[12.5px] font-semibold text-ink-700">{entry.action}</p>
                      <p className="truncate text-[11.5px] text-ink-400">
                        {entry.actorEmail || entry.actorId} · {formatDate(entry.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <button
              onClick={() => setTab('colleges')}
              className="rounded-xl border border-line bg-white p-4 text-left transition-colors hover:border-sage-300"
            >
              <Icon name="grid" className="h-5 w-5 text-pine-800" />
              <p className="mt-2 text-[13.5px] font-bold">Colleges & branches</p>
              <p className="mt-0.5 text-[12.5px] text-ink-500">Create, edit, activate and assign administrators.</p>
            </button>
            <button
              onClick={onOpenTemplates}
              className="rounded-xl border border-line bg-white p-4 text-left transition-colors hover:border-sage-300"
            >
              <Icon name="file" className="h-5 w-5 text-pine-800" />
              <p className="mt-2 text-[13.5px] font-bold">Template management</p>
              <p className="mt-0.5 text-[12.5px] text-ink-500">Draft, preview, publish and pin branch defaults.</p>
            </button>
            <button
              onClick={() => setTab('audit')}
              className="rounded-xl border border-line bg-white p-4 text-left transition-colors hover:border-sage-300"
            >
              <Icon name="list" className="h-5 w-5 text-pine-800" />
              <p className="mt-2 text-[13.5px] font-bold">Audit trail</p>
              <p className="mt-0.5 text-[12.5px] text-ink-500">Inspect administrative changes within your scope.</p>
            </button>
          </div>
        </div>
      ) : tab === 'colleges' ? (
        <div className="flex flex-col gap-4">
          {canManageCollege && (
            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-[13.5px] font-bold">Colleges</h2>
                  <p className="mt-0.5 text-[12.5px] text-ink-500">Deactivate a college instead of deleting it; all history is preserved.</p>
                </div>
                <Button size="sm" variant={newCollege.open ? 'secondary' : 'primary'} onClick={() => setNewCollege((v) => ({ ...v, open: !v.open }))}>
                  <Icon name={newCollege.open ? 'x' : 'plus'} className="h-4 w-4" />
                  {newCollege.open ? 'Cancel' : 'New college'}
                </Button>
              </div>
              {newCollege.open && (
                <form onSubmit={createCollege} className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Field label="Name">
                    <input required minLength={2} maxLength={120} value={newCollege.name} onChange={(e) => setNewCollege((v) => ({ ...v, name: e.target.value }))} className={inputCls} />
                  </Field>
                  <Field label="Slug" hint="Lowercase letters, numbers and hyphens. Defaults from the name.">
                    <input value={newCollege.slug} onChange={(e) => setNewCollege((v) => ({ ...v, slug: e.target.value }))} className={inputCls} placeholder="e.g. north-campus" />
                  </Field>
                  <Field label="Status">
                    <Select value={newCollege.status} onChange={(e) => setNewCollege((v) => ({ ...v, status: e.target.value }))}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </Field>
                  <Field label="Metadata (JSON object)" hint="Optional. Stored as safe college metadata.">
                    <textarea value={newCollege.metadata} onChange={(e) => setNewCollege((v) => ({ ...v, metadata: e.target.value }))} className={`${inputCls} min-h-20 font-mono text-[12px]`} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Button type="submit" disabled={busy === 'college:create'}>
                      {busy === 'college:create' ? 'Creating…' : 'Create college'}
                    </Button>
                  </div>
                </form>
              )}
            </section>
          )}

          {colleges.length === 0 ? (
            <EmptyState
              icon={<Icon name="grid" className="h-5 w-5" />}
              title="No colleges in your scope"
              body={isPlatformAdmin ? 'Create the first college to start adding branches and shared templates.' : 'You are not assigned to any colleges yet. Ask a platform administrator for access.'}
            />
          ) : (
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              {colleges.map((college) => (
                <article key={college.id} className={`rounded-xl border bg-white p-4 ${selectedCollegeId === college.id ? 'border-pine-800 ring-1 ring-pine-900/15' : 'border-line'}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-bold">{college.name}</p>
                      <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
                        {college.slug || college.id} · {college.branchCount ?? 0} branches · {college.templateCount ?? 0} templates
                      </p>
                    </div>
                    <Badge tone={statusTone(college.status)}>{statusLabel(college.status)}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant={selectedCollegeId === college.id ? 'primary' : 'secondary'} onClick={() => setSelectedCollegeId(college.id)}>
                      {selectedCollegeId === college.id ? 'Managing' : 'Manage branches'}
                    </Button>
                    {canManageCollege && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setEditCollege({
                              id: college.id,
                              name: college.name ?? '',
                              slug: college.slug ?? '',
                              status: college.status ?? 'active',
                              metadata: JSON.stringify(college.metadata ?? {}, null, 2),
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggleCollegeStatus(college)} disabled={busy === `college:${college.id}`}>
                          {college.status === 'active' ? 'Deactivate' : 'Activate'}
                        </Button>
                      </>
                    )}
                  </div>
                  {editCollege?.id === college.id && (
                    <form onSubmit={saveCollege} className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-line-soft bg-paper p-3 sm:grid-cols-2">
                      <Field label="Name">
                        <input required minLength={2} maxLength={120} value={editCollege.name} onChange={(e) => setEditCollege((v) => ({ ...v, name: e.target.value }))} className={inputCls} />
                      </Field>
                      <Field label="Slug">
                        <input required value={editCollege.slug} onChange={(e) => setEditCollege((v) => ({ ...v, slug: e.target.value }))} className={inputCls} />
                      </Field>
                      <Field label="Status">
                        <Select value={editCollege.status} onChange={(e) => setEditCollege((v) => ({ ...v, status: e.target.value }))}>
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </Select>
                      </Field>
                      <Field label="Metadata (JSON object)">
                        <textarea value={editCollege.metadata} onChange={(e) => setEditCollege((v) => ({ ...v, metadata: e.target.value }))} className={`${inputCls} min-h-20 font-mono text-[12px]`} />
                      </Field>
                      <div className="flex gap-2 sm:col-span-2">
                        <Button type="submit" size="sm" disabled={busy === `college:${college.id}`}>Save college</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditCollege(null)}>Cancel</Button>
                      </div>
                    </form>
                  )}
                </article>
              ))}
            </div>
          )}

          {selectedCollege && (
            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-[14px] font-bold">{selectedCollege.name} · branches</h2>
                  <p className="mt-0.5 text-[12.5px] text-ink-500">Branches belong to this college and cannot be moved between colleges.</p>
                </div>
                {busy === `college:${selectedCollege.id}` && <span className="text-[12px] text-ink-400">Loading…</span>}
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_20rem]">
                <div className="flex flex-col gap-2">
                  {(detail?.branches ?? []).length === 0 ? (
                    <p className="rounded-lg border border-line-soft bg-paper px-3 py-3 text-[13px] text-ink-500">No branches yet. Add the first branch below.</p>
                  ) : (
                    (detail?.branches ?? []).map((branch) => {
                      const templates = branchTemplates[branch.id] ?? []
                      const published = templates.filter((t) => t.status === 'active' || t.status === 'published')
                      return (
                        <article key={branch.id} className="rounded-lg border border-line-soft p-3">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-bold">{branch.name}</p>
                              <p className="truncate text-[11.5px] text-ink-400">{branch.slug || branch.id}</p>
                            </div>
                            <Badge tone={statusTone(branch.status)}>{statusLabel(branch.status)}</Badge>
                          </div>
                          <p className="mt-1.5 text-[11.5px] text-ink-500">
                            Default: {branch.defaultTemplateId ? `${branch.defaultTemplateId} v${branch.defaultTemplateVersion ?? '?'}` : 'none pinned'}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setEditBranch({ id: branch.id, name: branch.name ?? '', slug: branch.slug ?? '', status: branch.status ?? 'active', metadata: JSON.stringify(branch.metadata ?? {}, null, 2) })}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => toggleBranchStatus(branch)} disabled={busy === `branch:${branch.id}`}>
                              {branch.status === 'active' ? 'Deactivate' : 'Activate'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => loadBranchTemplates(branch)} disabled={busy === `templates:${branch.id}`}>
                              {busy === `templates:${branch.id}` ? 'Loading…' : 'View templates'}
                            </Button>
                          </div>

                          {editBranch?.id === branch.id && (
                            <form onSubmit={saveBranch} className="mt-2 grid grid-cols-1 gap-2 rounded-lg bg-paper p-2.5 sm:grid-cols-2">
                              <Field label="Name">
                                <input required minLength={2} maxLength={120} value={editBranch.name} onChange={(e) => setEditBranch((v) => ({ ...v, name: e.target.value }))} className={inputCls} />
                              </Field>
                              <Field label="Slug">
                                <input required value={editBranch.slug} onChange={(e) => setEditBranch((v) => ({ ...v, slug: e.target.value }))} className={inputCls} />
                              </Field>
                              <Field label="Status">
                                <Select value={editBranch.status} onChange={(e) => setEditBranch((v) => ({ ...v, status: e.target.value }))}>
                                  <option value="active">Active</option>
                                  <option value="inactive">Inactive</option>
                                </Select>
                              </Field>
                              <Field label="Metadata (JSON object)">
                                <textarea value={editBranch.metadata} onChange={(e) => setEditBranch((v) => ({ ...v, metadata: e.target.value }))} className={`${inputCls} min-h-16 font-mono text-[12px]`} />
                              </Field>
                              <div className="flex gap-2 sm:col-span-2">
                                <Button type="submit" size="sm" disabled={busy === `branch:${branch.id}`}>Save branch</Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setEditBranch(null)}>Cancel</Button>
                              </div>
                            </form>
                          )}

                          {templates.length > 0 && (
                            <div className="mt-2 rounded-lg border border-line-soft bg-paper p-2.5">
                              <p className="text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-400">Templates</p>
                              <ul className="mt-1 divide-y divide-line-soft">
                                {templates.map((template) => (
                                  <li key={`${template.id}@${template.version}`} className="flex items-center gap-2 py-1.5">
                                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{template.name}</span>
                                    <Badge tone={statusTone(template.status)}>{statusLabel(template.status, 'template')}</Badge>
                                  </li>
                                ))}
                              </ul>
                              <div className="mt-2 flex flex-wrap items-end gap-2">
                                <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] font-semibold text-ink-600">
                                  Published default
                                  <Select
                                    value={defaultChoice[branch.id] ?? ''}
                                    onChange={(e) => setDefaultChoice((prev) => ({ ...prev, [branch.id]: e.target.value }))}
                                  >
                                    <option value="">Choose a published version…</option>
                                    {published.map((template) => (
                                      <option key={`${template.id}@${template.version}`} value={`${template.id}@${template.version}`}>
                                        {template.name} · v{template.version}
                                      </option>
                                    ))}
                                  </Select>
                                </label>
                                <Button size="sm" onClick={() => setBranchDefault(branch)} disabled={busy === `default:${branch.id}`}>
                                  Pin default
                                </Button>
                                {branch.defaultTemplateId && (
                                  <Button size="sm" variant="ghost" onClick={() => clearBranchDefault(branch)} disabled={busy === `default:${branch.id}`}>
                                    Clear
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}
                        </article>
                      )
                    })
                  )}

                  <form onSubmit={createBranch} className="mt-1 grid grid-cols-1 gap-2 rounded-lg border border-line-soft bg-paper p-3 sm:grid-cols-2">
                    <h3 className="text-[12.5px] font-bold sm:col-span-2">Add a branch to {selectedCollege.name}</h3>
                    <Field label="Name">
                      <input required minLength={2} maxLength={120} value={newBranch.name} onChange={(e) => setNewBranch((v) => ({ ...v, name: e.target.value }))} className={inputCls} />
                    </Field>
                    <Field label="Slug" hint="Optional; defaults from the name.">
                      <input value={newBranch.slug} onChange={(e) => setNewBranch((v) => ({ ...v, slug: e.target.value }))} className={inputCls} />
                    </Field>
                    <Field label="Status">
                      <Select value={newBranch.status} onChange={(e) => setNewBranch((v) => ({ ...v, status: e.target.value }))}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </Select>
                    </Field>
                    <Field label="Metadata (JSON object)">
                      <textarea value={newBranch.metadata} onChange={(e) => setNewBranch((v) => ({ ...v, metadata: e.target.value }))} className={`${inputCls} min-h-16 font-mono text-[12px]`} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Button type="submit" size="sm" disabled={busy === 'branch:create'}>Create branch</Button>
                    </div>
                  </form>
                </div>

                <aside className="rounded-lg border border-line-soft bg-paper p-3">
                  <h3 className="text-[12.5px] font-bold">College administrators</h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-500">Only a platform administrator can grant or revoke this scope.</p>
                  {admins.length === 0 ? (
                    <p className="mt-2 text-[12px] text-ink-500">No college administrators assigned.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line-soft">
                      {admins.map((admin) => (
                        <li key={admin.id} className="flex items-center gap-2 py-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12px]">{admin.email}</span>
                          {isPlatformAdmin && (
                            <button
                              type="button"
                              onClick={() => removeAdmin(admin)}
                              disabled={busy === `admin:${admin.id}`}
                              className="rounded px-1.5 py-0.5 text-[11.5px] font-bold text-[#8F1D17] hover:bg-white disabled:opacity-50"
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {isPlatformAdmin && (
                    <form onSubmit={addAdmin} className="mt-2 flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-semibold text-ink-600" htmlFor="admin-email">Assign by account email</label>
                      <input id="admin-email" type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className={inputCls} placeholder="admin@example.com" />
                      <Button type="submit" size="sm" disabled={busy === 'admin:add'}>Assign administrator</Button>
                    </form>
                  )}
                </aside>
              </div>
            </section>
          )}
        </div>
      ) : (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-[13.5px] font-bold">Administrative actions</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">Only actions within your authorized college scope are shown. Secrets are never recorded.</p>
          {audit.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-500">No admin actions recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line-soft">
              {audit.map((entry) => (
                <li key={entry.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="sage">{entry.action}</Badge>
                    <span className="text-[12.5px] font-semibold">{entry.entityType} · {entry.entityId}</span>
                    <span className="ml-auto text-[11.5px] text-ink-400">{formatDate(entry.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink-500">
                    {entry.actorEmail || entry.actorId} · college {entry.collegeId ?? '—'}
                  </p>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11.5px] font-semibold text-pine-800">Safe metadata</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-paper p-2 text-[11px] text-ink-500">{JSON.stringify(entry.metadata, null, 2)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
