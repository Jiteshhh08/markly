// Shared assignment presentation components (moved from App.jsx in the final
// stage). Pure UI — data comes from props, API/auth from feature callers.
import { useState } from 'react'
import { StatusBadge, cx } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import { subjectStyle, timeAgo, uiStatus } from './data.js'

export function Avatar({ subject, className = 'h-6 w-6 text-[10px]' }) {
  const s = subjectStyle(subject)
  const initials = subject.split(/[\s/]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-bold', className)} style={{ background: s.bg, color: s.color }}>
      {initials}
    </span>
  )
}

/* ------------------------------ shared bits -------------------------------- */

export function SubjectTag({ subject }) {
  const s = subjectStyle(subject)
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: s.bg, color: s.color }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      <span className="truncate">{subject}</span>
    </span>
  )
}

export function SectionHeading({ icon, children }) {
  return (
    <h3 className="flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-400">
      <Icon name={icon} className="h-3.5 w-3.5" />
      {children}
    </h3>
  )
}

export function CodeBlock({ code, language }) {
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

export function RetryLink({ onRetry, label, className }) {
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

export function AssignmentRow({ issue, onOpen, onRetry }) {
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

export function GenerationPill({ count, onOpen, className = '' }) {
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
