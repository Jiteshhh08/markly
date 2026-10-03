// Markly design system — Deep Teal #1A4543 / Sand #F0BE6F / Sage #B2D0C6.
// Neutrals carry 60-70% of the UI. Accents are sparing and intentional.

export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------- Buttons -------------------------------- */

const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 select-none'

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}) {
  const sizes = {
    sm: 'px-2.5 py-1.5 text-[12.5px]',
    md: 'px-3.5 py-2 text-[13px]',
    lg: 'px-4 py-2.5 text-[14px]',
  }
  const styles = {
    // Primary CTA — Deep Teal, always the obvious action
    primary:
      'bg-pine-900 text-white shadow-[0_1px_2px_rgba(26,69,67,0.25)] hover:bg-pine-950 active:bg-pine-950',
    // Quiet secondary
    secondary:
      'border border-line bg-white text-ink-700 hover:border-ink-300 hover:bg-rail active:bg-rail-hover',
    // Subtle tertiary
    ghost: 'text-ink-500 hover:bg-rail hover:text-ink-900 active:bg-rail-hover',
    // Destructive
    danger: 'bg-[#B3261E] text-white hover:bg-[#8F1D17]',
    // Warm accent — used sparingly (e.g. retry emphasis secondary)
    sand: 'bg-sand-400 text-pine-950 hover:bg-sand-500 active:bg-sand-500',
  }
  return (
    <button
      className={cx(buttonBase, sizes[size] ?? sizes.md, styles[variant] ?? styles.primary, className)}
      {...props}
    />
  )
}

/* -------------------------------- Inputs -------------------------------- */

export const inputCls =
  'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 placeholder:text-ink-300 transition-colors duration-150 hover:border-ink-300 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15'

export const labelCls = 'mb-1.5 block text-[12.5px] font-semibold text-ink-700'

export function Field({ label, hint, htmlFor, children, className = '' }) {
  return (
    <div className={cx('text-left', className)}>
      {label && (
        <label htmlFor={htmlFor} className={labelCls}>
          {label}
        </label>
      )}
      {children}
      {hint && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{hint}</p>}
    </div>
  )
}

export function Input(props) {
  return <input className={cx(inputCls, props.className)} {...props} />
}

export function Textarea(props) {
  return <textarea className={cx(inputCls, 'resize-y leading-relaxed', props.className)} {...props} />
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={cx(inputCls, 'pr-8', className)} {...props}>
      {children}
    </select>
  )
}

/* ------------------------------ Page header ----------------------------- */

export function PageHeader({ title, description, actions, meta }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[20px] font-bold tracking-tight text-ink-900 sm:text-[22px]">
            {title}
          </h1>
          {meta}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-ink-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------- SearchBar ------------------------------ */

export function SearchBar({ value, onChange, placeholder = 'Search…', className = '' }) {
  return (
    <div className={cx('relative', className)}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-white py-2 pl-9 pr-8 text-[13.5px] text-ink-900 placeholder:text-ink-300 transition-colors duration-150 hover:border-ink-300 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-300 transition-colors hover:bg-rail hover:text-ink-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3.5 w-3.5">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  )
}

/* --------------------------- Badges & status ---------------------------- */

export function Badge({ children, tone = 'neutral', className = '' }) {
  const tones = {
    neutral: 'bg-rail text-ink-500',
    teal: 'bg-pine-50 text-pine-900 ring-1 ring-inset ring-pine-900/15',
    sage: 'bg-sage-100 text-sage-700 ring-1 ring-inset ring-sage-300/50',
    sand: 'bg-sand-100 text-sand-700 ring-1 ring-inset ring-sand-400/50',
  }
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-wide',
        tones[tone] ?? tones.neutral,
        className,
      )}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ status }) {
  const map = {
    generating: {
      label: 'Generating',
      cls: 'bg-pine-50 text-pine-900 ring-pine-900/20',
      dot: 'bg-pine-800 animate-pulse',
    },
    done: {
      label: 'Ready',
      cls: 'bg-sage-100 text-sage-700 ring-sage-300/60',
      dot: 'bg-sage-500',
    },
    failed: {
      label: 'Needs attention',
      cls: 'bg-[#FDECEC] text-[#8F1D17] ring-[#B3261E]/20',
      dot: 'bg-[#B3261E]',
    },
    stale: {
      label: 'Expired',
      cls: 'bg-sand-100 text-sand-700 ring-sand-400/50',
      dot: 'bg-sand-600',
    },
    todo: {
      label: 'Draft',
      cls: 'bg-rail text-ink-500 ring-line',
      dot: 'bg-ink-300',
    },
  }
  const s = map[status] ?? map.todo
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
        s.cls,
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

// Back-compat for legacy pages/
export function ErrorText({ error }) {
  if (!error) return null
  return <p className="mt-2 text-[13px] text-[#8F1D17]">{String(error.message ?? error)}</p>
}

export function Card({ className = '', ...props }) {
  return (
    <div
      className={cx('rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(30,42,40,0.06)]', className)}
      {...props}
    />
  )
}

/* ------------------------- Empty / Loading / Error ---------------------- */

export function EmptyState({
  icon,
  title,
  body,
  action,
  secondary,
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center rounded-xl border border-line bg-white px-6 py-10 text-center shadow-[0_1px_2px_rgba(30,42,40,0.06)] sm:px-10">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sage-100 text-pine-900">
        {icon}
      </span>
      <h2 className="mt-4 text-[16px] font-bold tracking-tight text-ink-900">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-ink-500">{body}</p>
      {action && <div className="mt-5">{action}</div>}
      {secondary && <div className="mt-3">{secondary}</div>}
    </div>
  )
}

export function LoadingRows({ count = 4 }) {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-line bg-white p-4">
          <div className="mk-skeleton h-3.5 w-2/5 rounded" />
          <div className="mk-skeleton mt-2 h-3 w-4/5 rounded" />
          <div className="mt-3 flex gap-2">
            <div className="mk-skeleton h-5 w-16 rounded-md" />
            <div className="mk-skeleton h-5 w-20 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ErrorState({ title = 'Unable to connect', body = "We couldn't reach the Markly service.", onRetry }) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center rounded-xl border border-line bg-white px-6 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#FDECEC] text-[#8F1D17]">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="h-5 w-5">
          <path d="M12 8v5" />
          <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
          <path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </span>
      <h2 className="mt-4 text-[16px] font-bold text-ink-900">{title}</h2>
      <p className="mt-1.5 text-[13.5px] text-ink-500">{body}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="secondary" className="mt-5">
          Retry
        </Button>
      )}
    </div>
  )
}

/* --------------------------------- Modal -------------------------------- */

export function ModalShell({ title, subtitle, onClose, wide, children, footer }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="mk-fade absolute inset-0 bg-pine-950/45" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'mk-pop relative flex max-h-[94vh] w-full flex-col overflow-hidden bg-white shadow-[0_20px_60px_rgba(15,46,45,0.35)]',
          'rounded-t-2xl sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold tracking-tight text-ink-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-lg p-1.5 text-ink-400 transition-colors duration-150 hover:bg-rail hover:text-ink-900"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-4 w-4">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line-soft bg-paper px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}
