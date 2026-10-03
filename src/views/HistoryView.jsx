// History view (moved from App.jsx in the final stage). Owns its archive fetch;
// importing a record into the workspace board is delegated via onImport.
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, apiFetch, authHeaders } from '../services/api.js'
import { Button, EmptyState, ErrorState, LoadingRows, PageHeader, SearchBar } from '../components/ui.jsx'
import { Icon } from '../components/icons.jsx'
import { Avatar } from '../features/assignments/AssignmentUI.jsx'
import { SUBJECTS, fullDate } from '../features/assignments/data.js'

export function HistoryView({ onImport }) {
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
