import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  SearchBar,
  Select,
} from '../components/ui.jsx'
import { Icon } from '../components/icons.jsx'
import { adminRequest, describeApiError, templateRequest } from '../features/admin/adminApi.js'
import { TemplateCreateModal } from '../features/templates/TemplateCreateModal.jsx'
import { TemplateEditor } from '../features/templates/TemplateEditor.jsx'

// STAGE 3 template catalogue and management entry point. All authorization is
// enforced by the API; this view only hides actions the current persisted role
// would not be allowed to perform. Private templates stay visually distinct
// and are never mixed into shared college/platform groups.

function isPublished(template) {
  return template?.status === 'active' || template?.status === 'published'
}

function statusLabel(status) {
  if (status === 'active' || status === 'published') return 'Published'
  if (status === 'draft') return 'Draft'
  if (status === 'archived') return 'Archived'
  return status ? status[0].toUpperCase() + status.slice(1) : 'Unknown'
}

function statusTone(status) {
  if (isPublished({ status })) return 'teal'
  if (status === 'draft') return 'sand'
  return 'neutral'
}

function scopeLabel(scope) {
  if (scope === 'private') return 'Private'
  if (scope === 'platform') return 'Platform'
  if (scope === 'college') return 'College'
  if (scope === 'legacy') return 'Legacy'
  return scope ?? 'Legacy'
}

function scopeTone(scope) {
  if (scope === 'private') return 'sand'
  if (scope === 'platform' || scope === 'college') return 'sage'
  return 'neutral'
}

function canManageTemplate(session, template) {
  if (!session || !template) return false
  if (template.scope === 'private') return String(template.ownerUserId ?? '') === String(session.id ?? '')
  if (template.scope === 'platform' || template.scope === 'legacy') return session.role === 'platform_admin'
  if (template.scope === 'college') {
    return session.role === 'platform_admin' ||
      (session.role === 'college_admin' && (session.collegeAdminOf ?? []).includes(template.tenantId))
  }
  return false
}

function canUseTemplate(session, template) {
  if (!template || template.status === 'archived') return false
  if (template.scope === 'private') return String(template.ownerUserId ?? '') === String(session?.id ?? '')
  return isPublished(template)
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function templateKey(template) {
  return `${template.id}@${template.version}`
}

export function TemplatesView({ templates, onRefresh, notify, onUse, onAuthRequired, session }) {
  const [items, setItems] = useState(templates ?? [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [collegeFilter, setCollegeFilter] = useState('all')
  const [branchFilter, setBranchFilter] = useState('all')
  const [createMode, setCreateMode] = useState(null)
  const [editor, setEditor] = useState(null)
  const [colleges, setColleges] = useState([])
  const [collegesLoading, setCollegesLoading] = useState(false)
  const [branches, setBranches] = useState([])

  const isAdmin = session?.role === 'platform_admin' || session?.role === 'college_admin'

  const catalogueQueries = useMemo(() => {
    if (isAdmin) return ['']
    const preferences = session?.preferences
    const queries = []
    if (preferences?.collegeId) {
      const params = new URLSearchParams({ collegeId: preferences.collegeId })
      if (preferences.departmentId) params.set('departmentId', preferences.departmentId)
      queries.push(`?${params.toString()}`)
    }
    const memberships = Array.isArray(session?.tenantIds) ? session.tenantIds : []
    for (const collegeId of memberships) {
      if (preferences?.collegeId === collegeId) continue
      queries.push(`?collegeId=${encodeURIComponent(collegeId)}`)
    }
    return queries.length > 0 ? queries : ['']
  }, [isAdmin, session])

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const results = await Promise.allSettled(
        catalogueQueries.map((suffix) => templateRequest(`/${suffix}`)),
      )
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      if (fulfilled.length === 0) {
        throw results.find((result) => result.status === 'rejected')?.reason ?? new Error('Templates are unavailable.')
      }
      const merged = new Map()
      for (const result of fulfilled) {
        for (const template of result.value.templates ?? []) {
          merged.set(templateKey(template), template)
        }
      }
      const next = [...merged.values()].sort((a, b) => {
        const dateA = new Date(a.updatedAt ?? 0).getTime() || 0
        const dateB = new Date(b.updatedAt ?? 0).getTime() || 0
        return dateB - dateA || String(a.name ?? '').localeCompare(String(b.name ?? ''))
      })
      setItems(next)
    } catch (err) {
      if (err?.status === 401) {
        onAuthRequired?.()
        setError('Please log in to view templates.')
      } else {
        setError(describeApiError(err))
      }
    } finally {
      setLoading(false)
    }
  }, [catalogueQueries, onAuthRequired])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  useEffect(() => {
    if (!isAdmin) {
      setColleges([])
      return undefined
    }
    let alive = true
    setCollegesLoading(true)
    adminRequest('/colleges')
      .then((data) => {
        if (alive) setColleges(data.colleges ?? [])
      })
      .catch(() => {
        if (alive) setColleges([])
      })
      .finally(() => {
        if (alive) setCollegesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin || collegeFilter === 'all') {
      setBranches([])
      return undefined
    }
    let alive = true
    adminRequest(`/colleges/${encodeURIComponent(collegeFilter)}/branches`)
      .then((data) => {
        if (alive) setBranches(data.branches ?? [])
      })
      .catch(() => {
        if (alive) setBranches([])
      })
    return () => {
      alive = false
    }
  }, [isAdmin, collegeFilter])

  const collegeNames = useMemo(() => {
    const map = new Map()
    for (const college of colleges) map.set(college.id, college.name || college.id)
    for (const template of items) {
      if (template.tenantId && !map.has(template.tenantId)) map.set(template.tenantId, template.tenantId)
    }
    return map
  }, [colleges, items])

  const branchNames = useMemo(() => {
    const map = new Map()
    for (const branch of branches) map.set(branch.id, branch.name || branch.id)
    for (const template of items) {
      if (template.departmentId && !map.has(template.departmentId)) {
        map.set(template.departmentId, template.departmentId)
      }
    }
    return map
  }, [branches, items])

  const collegeOptions = useMemo(() => [...collegeNames.entries()], [collegeNames])
  const branchOptions = useMemo(() => {
    const entries = [...branchNames.entries()]
    if (collegeFilter === 'all') return entries
    return entries.filter(([id]) => items.some((template) => template.departmentId === id && template.tenantId === collegeFilter))
  }, [branchNames, collegeFilter, items])

  const scopes = useMemo(() => {
    const values = new Set(items.map((template) => template.scope).filter(Boolean))
    return [...values].sort()
  }, [items])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((template) => {
      const haystack = `${template.name ?? ''} ${template.id ?? ''} ${template.tenantId ?? ''} ${template.departmentId ?? ''}`.toLowerCase()
      if (needle && !haystack.includes(needle)) return false
      if (statusFilter === 'published' && !isPublished(template)) return false
      if (statusFilter === 'draft' && template.status !== 'draft') return false
      if (statusFilter === 'archived' && template.status !== 'archived') return false
      if (scopeFilter !== 'all' && template.scope !== scopeFilter) return false
      if (collegeFilter !== 'all' && template.tenantId !== collegeFilter) return false
      if (branchFilter !== 'all' && template.departmentId !== branchFilter) return false
      return true
    })
  }, [items, query, statusFilter, scopeFilter, collegeFilter, branchFilter])

  const privateCount = items.filter((template) => template.scope === 'private').length
  const sharedCount = items.length - privateCount

  const resetFilters = useCallback(() => {
    setQuery('')
    setStatusFilter('all')
    setScopeFilter('all')
    setCollegeFilter('all')
    setBranchFilter('all')
  }, [])

  const handleCreated = useCallback(
    (template) => {
      setCreateMode(null)
      setEditor(template)
      void loadTemplates()
      onRefresh?.()
    },
    [loadTemplates, onRefresh],
  )

  const handleSaved = useCallback(() => {
    void loadTemplates()
    onRefresh?.()
  }, [loadTemplates, onRefresh])

  return (
    <div className="mk-rise flex flex-col gap-4">
      <PageHeader
        title="Templates"
        description="Browse shared formats, manage your private drafts, or create a new versioned template. Private templates stay visible only to their owner."
        meta={
          <>
            <Badge tone="sage">{sharedCount} shared</Badge>
            {privateCount > 0 && <Badge tone="sand">{privateCount} private</Badge>}
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={loadTemplates} disabled={loading}>
              <Icon name="refresh" className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => setCreateMode('import')}>
              <Icon name="upload" className="h-4 w-4" />
              Import PDF
            </Button>
            <Button onClick={() => setCreateMode('blank')}>
              <Icon name="plus" className="h-4 w-4" />
              New template
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-2 rounded-xl border border-line bg-white p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_10rem_11rem_11rem]">
        <SearchBar value={query} onChange={setQuery} placeholder="Search by name, id, college or branch…" />
        <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="draft">Drafts</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
        <Select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)} aria-label="Filter by scope">
          <option value="all">All scopes</option>
          {scopes.map((scope) => (
            <option key={scope} value={scope}>{scopeLabel(scope)}</option>
          ))}
        </Select>
        <Select
          value={collegeFilter}
          onChange={(event) => {
            setCollegeFilter(event.target.value)
            setBranchFilter('all')
          }}
          aria-label="Filter by college"
        >
          <option value="all">All colleges</option>
          {collegeOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </Select>
        <Select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} aria-label="Filter by branch">
          <option value="all">All branches</option>
          {branchOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </Select>
      </div>

      {loading ? (
        <LoadingRows count={4} />
      ) : error ? (
        <ErrorState title="Templates are unavailable" body={error} onRetry={loadTemplates} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon name="grid" className="h-5 w-5" />}
          title="No templates in your scope"
          body={
            isAdmin
              ? 'Create a blank template or import a PDF sample. Shared templates can be scoped to a college and branch.'
              : 'Create a private template or import a sample PDF. Shared college and platform templates appear here when published.'
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setCreateMode('blank')}>
                <Icon name="plus" className="h-4 w-4" />
                New template
              </Button>
              <Button variant="secondary" onClick={() => setCreateMode('import')}>
                <Icon name="upload" className="h-4 w-4" />
                Import PDF
              </Button>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="grid" className="h-5 w-5" />}
          title="No templates match these filters"
          body="Try a different search term or reset the status, scope, college or branch filters."
          action={<Button variant="secondary" onClick={resetFilters}>Reset filters</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          {filtered.map((template) => {
            const privateTemplate = template.scope === 'private'
            const manageable = canManageTemplate(session, template)
            const usable = canUseTemplate(session, template)
            return (
              <article
                key={templateKey(template)}
                className={`flex flex-col rounded-xl border p-4 transition-colors ${
                  privateTemplate
                    ? 'border-sand-400/60 bg-sand-50/45'
                    : 'border-line bg-white hover:border-sage-300'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="min-w-0 truncate text-[14px] font-bold tracking-tight">{template.name}</p>
                      <Badge tone={scopeTone(template.scope)}>{scopeLabel(template.scope)}</Badge>
                    </div>
                    <p className="mt-1 truncate text-[11.5px] font-medium text-ink-400">
                      {template.id} · v{template.version}
                      {template.tenantId ? ` · ${collegeNames.get(template.tenantId) ?? template.tenantId}` : ''}
                      {template.departmentId ? ` / ${branchNames.get(template.departmentId) ?? template.departmentId}` : ''}
                    </p>
                  </div>
                  <Badge tone={statusTone(template.status)}>{statusLabel(template.status)}</Badge>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-400">
                  {privateTemplate ? (
                    <span className="font-semibold text-sand-700">Private — only you can view this</span>
                  ) : (
                    <span>{template.scope === 'platform' ? 'Available across colleges' : 'Shared within its college scope'}</span>
                  )}
                  {template.updatedAt && <span>· Updated {formatDate(template.updatedAt)}</span>}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => onUse(template)}
                    disabled={!usable}
                    title={!usable ? 'Only published shared templates and your own unarchived private templates can be used.' : undefined}
                  >
                    Use template
                  </Button>
                  {manageable && (
                    <Button size="sm" variant="secondary" onClick={() => setEditor(template)}>
                      {template.status === 'archived' ? 'View history' : 'Manage / edit'}
                    </Button>
                  )}
                  {!manageable && template.status !== 'archived' && (
                    <span className="self-center text-[11.5px] text-ink-400">
                      {privateTemplate ? 'Owner-only' : 'Managed by an administrator'}
                    </span>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {createMode && (
        <TemplateCreateModal
          mode={createMode}
          colleges={colleges}
          collegesLoading={collegesLoading}
          session={session}
          notify={notify}
          onAuthRequired={onAuthRequired}
          onClose={() => setCreateMode(null)}
          onCreated={handleCreated}
        />
      )}

      {editor && (
        <TemplateEditor
          templateId={editor.id}
          seed={editor}
          session={session}
          notify={notify}
          onAuthRequired={onAuthRequired}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
