import { useEffect, useRef, useState } from 'react'
import { cx, ModalShell } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import { displayNameOf } from './identity.js'
import { UserAvatar } from './UserAvatar.jsx'

export function ProfileMenu({ session, onLogout, onOpenProfile, direction = 'up', compact = false }) {
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
  }, [open])

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

export function ProfileModal({ session, onClose }) {
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
