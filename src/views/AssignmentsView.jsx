// Assignments view (moved from App.jsx in the final stage). Pure presentational:
// filtering/sorting state lives in the App shell and arrives via props.
import { Badge, Button, EmptyState, ErrorState, LoadingRows, PageHeader, SearchBar } from '../components/ui.jsx'
import { Icon } from '../components/icons.jsx'
import { AssignmentRow } from '../features/assignments/AssignmentUI.jsx'
import { SUBJECTS } from '../features/assignments/data.js'

export function AssignmentsView({ issues, total, loading, error, query, onQuery, subjectFilter, onSubject, statusFilter, onStatus, sortBy, onSort, onCreate, onOpen, onRetry, onResetFilters }) {
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
