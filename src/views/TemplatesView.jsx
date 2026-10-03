// Templates view (moved from App.jsx in the final stage). Department formats
// for headers, watermarks, and structure; creation/import delegated via props.
import { useMemo, useState } from 'react'
import { API_BASE, apiFetch, authHeaders } from '../services/api.js'
import { Badge, Button, EmptyState, PageHeader, SearchBar, inputCls } from '../components/ui.jsx'
import { Icon } from '../components/icons.jsx'

export function TemplatesView({ templates, onRefresh, notify, onUse, onAuthRequired }) {
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
