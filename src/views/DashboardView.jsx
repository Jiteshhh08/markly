// Dashboard view (moved from App.jsx in the final stage). Pure presentational:
// all state and callbacks arrive via props from the App shell.
import { Button, EmptyState, ErrorState, LoadingRows, PageHeader } from '../components/ui.jsx'
import { Icon, LogoMark } from '../components/icons.jsx'
import { AssignmentRow } from '../features/assignments/AssignmentUI.jsx'
import { EXAMPLES, timeOfDay } from '../features/assignments/data.js'
import { firstNameOf } from '../features/auth/identity.js'

export function DashboardView({ issues, recent, templates, loading, error, onRetry, onCreate, onOpen, onRetryGen, onViewAll, onViewTemplates, onUseTemplate, session, greeting }) {
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
