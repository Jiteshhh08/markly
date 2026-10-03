import { useState } from 'react'
import { cx } from '../../components/ui.jsx'
import { displayNameOf, initialsOf } from './identity.js'

export function UserAvatar({ user, className = 'h-9 w-9 text-[12px]' }) {
  // Remembers the URL that failed so a broken image falls back to initials;
  // any new URL is retried automatically (no effect needed).
  const [failedUrl, setFailedUrl] = useState('')
  const name = displayNameOf(user)
  const url = (user?.avatarUrl ?? '').trim()
  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt={`${name}'s profile photo`}
        onError={() => setFailedUrl(url)}
        className={cx('shrink-0 rounded-full bg-pine-900 object-cover', className)}
      />
    )
  }
  return (
    <span
      role="img"
      aria-label={`${name}'s profile avatar`}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-pine-900 font-bold text-white', className)}
    >
      {initialsOf(name, user?.email)}
    </span>
  )
}
