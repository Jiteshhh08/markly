// Detail drawer (moved from App.jsx in the final stage). Review, edit,
// regenerate, export, and preview a single assignment; all data actions are
// delegated via props, API calls use the canonical client.
import { useEffect, useRef, useState } from 'react'
import { apiFetch, authHeaders } from '../../services/api.js'
import { Button, StatusBadge, cx } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import { CodeBlock, SectionHeading, SubjectTag } from './AssignmentUI.jsx'
import { EDITABLE_SECTIONS, fullDate, priorityOf, sectionFromText, sectionToText, timeAgo, uiStatus } from './data.js'

export function DetailDrawer({ issue, shown, onClose, onRetry, onDelete, onDownload, onOpenPreview, onOpenStudio, onRecordUpdate, onMarkStale, onAuthRequired, apiBase }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showRawJson, setShowRawJson] = useState(false)
  const [exportBusy, setExportBusy] = useState('')
  const [exportError, setExportError] = useState('')
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [regenBusy, setRegenBusy] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [latex, setLatex] = useState(null)
  const [latexBusy, setLatexBusy] = useState(false)
  const [latexError, setLatexError] = useState('')
  const [copiedLatex, setCopiedLatex] = useState(false)
  const [optBusy, setOptBusy] = useState(false)
  const [optError, setOptError] = useState('')
  const [previewKey, setPreviewKey] = useState(0)
  const [recordGone, setRecordGone] = useState(false)
  const closeRef = useRef(null)

  // Move focus into the drawer on mount so keyboard users land on Close.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const recordId = issue.record?.id
    if (!recordId) return
    setRecordGone(false)
    apiFetch(`${apiBase}/api/v1/assignments/${recordId}`, { headers: authHeaders() })
      .then((r) => { if (r.status === 404) setRecordGone(true) })
      .catch(() => { /* offline banner covers unreachable servers */ })
  }, [issue.record?.id, apiBase])
  // List summaries carry no content: fetch the full record once when opening
  // a content-less server record. Local unsaved cards (record null) and
  // in-progress/failed generations skip this. The parent re-maps the issue
  // on arrival, so cards and drawer metadata correct themselves too.
  const [loadingFull, setLoadingFull] = useState(false)
  const [fullError, setFullError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const needsFull = !!issue.record && !issue.record.content && issue.status !== 'inprogress' && issue.status !== 'failed'
  useEffect(() => {
    if (!needsFull) return undefined
    let alive = true
    setLoadingFull(true)
    setFullError('')
    apiFetch(`${apiBase}/api/v1/assignments/${issue.key}`, { headers: authHeaders(), signal: AbortSignal.timeout(30000) })
      .then(async (res) => {
        if (!alive) return
        throwIfAuth(res)
        if (res.status === 404) {
          onMarkStale(issue.key)
          return
        }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error ?? "Couldn't load this assignment. Please try again.")
        onRecordUpdate(issue.key, data)
      })
      .catch((err) => { if (alive) setFullError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (alive) setLoadingFull(false) })
    return () => { alive = false }
  }, [issue.key, reloadTick, apiBase])
  const content = issue.record?.content ?? null
  const prov = issue.record?.provenance
  const prio = priorityOf(issue.difficulty)
  const stale = issue.stale === true

  function failMessage(res, data) {
    if (res.status === 404) {
      onMarkStale(issue.key)
      return 'This record was cleared on the service — regenerate the assignment to restore this feature.'
    }
    return data?.error ?? `Request failed. Please try again.`
  }

  function throwIfAuth(res) {
    if (res.status === 401) {
      onAuthRequired?.()
      throw new Error('Please log in to continue — then retry.')
    }
  }

  async function exportFile(kind) {
    const recordId = issue.record?.id
    if (!recordId) return
    setExportBusy(kind)
    setExportError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/${kind}`, {
        method: kind === 'pdf' ? 'POST' : 'GET',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: kind === 'pdf' ? '{}' : undefined,
        signal: AbortSignal.timeout(180000),
      })
      throwIfAuth(res)
      if (res.status === 404) {
        onMarkStale(issue.key)
        throw new Error('This record was cleared on the service — regenerate the assignment to restore exports.')
      }
      const ctype = res.headers.get('content-type') ?? ''
      if (!res.ok || ctype.includes('application/json')) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error ?? `Export failed. Please try again.`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${issue.key}-assignment.${kind === 'docx' ? 'docx' : 'pdf'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportBusy('')
    }
  }

  async function regenSection(section) {
    const recordId = issue.record?.id
    if (!recordId) return
    setRegenBusy(section)
    setEditError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/regenerate-section`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ section }),
        signal: AbortSignal.timeout(180000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      onRecordUpdate(issue.key, data)
      setDrafts((d) => ({ ...d, [section]: undefined }))
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setRegenBusy('')
    }
  }

  async function saveAllSections() {
    const recordId = issue.record?.id
    if (!recordId) return
    setEditError('')
    let next
    try {
      next = { ...issue.record.content }
      for (const s of EDITABLE_SECTIONS) {
        if (drafts[s] !== undefined) next[s] = sectionFromText(s, drafts[s])
      }
    } catch {
      setEditError('Invalid JSON in objectives / theory / steps — fix the syntax and retry.')
      return
    }
    setSaveBusy(true)
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}`, {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ content: next }),
        signal: AbortSignal.timeout(60000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      onRecordUpdate(issue.key, data)
      setDrafts({})
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaveBusy(false)
    }
  }

  async function loadLatex() {
    const recordId = issue.record?.id
    if (!recordId) return
    setLatexBusy(true)
    setLatexError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/latex`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(60000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(failMessage(res, data))
      setLatex(data.latex ?? '')
    } catch (err) {
      setLatexError(err instanceof Error ? err.message : String(err))
    } finally {
      setLatexBusy(false)
    }
  }

  async function saveOptions(patch) {
    const recordId = issue.record?.id
    if (!recordId) return
    setOptBusy(true)
    setOptError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/options`, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(30000),
      })
      throwIfAuth(res)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save options. Please try again.")
      onRecordUpdate(issue.key, data)
      setPreviewKey((k) => k + 1)
    } catch (err) {
      setOptError(err instanceof Error ? err.message : String(err))
    } finally {
      setOptBusy(false)
    }
  }

  async function copyLatex() {
    if (latex === null) return
    try {
      await navigator.clipboard.writeText(latex)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = latex
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopiedLatex(true)
    setTimeout(() => setCopiedLatex(false), 1500)
  }

  return (
    <>
      <div
        className={cx('mk-backdrop fixed inset-0 z-40 bg-pine-950/30', shown && 'mk-show')}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={content?.title ?? issue.aim}
        className={cx(
          'mk-drawer fixed inset-x-0 bottom-0 top-8 z-50 flex flex-col overflow-hidden rounded-t-2xl bg-paper shadow-[0_0_48px_rgba(15,46,45,0.35)]',
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:rounded-l-2xl sm:rounded-tr-none sm:w-[440px] lg:w-[560px] 2xl:w-[620px]',
          shown ? 'mk-show' : 'mk-hide',
        )}
      >
        <div className="flex items-center gap-2 border-b border-line bg-white px-3.5 py-2.5 sm:px-4">
          <span className="rounded-md bg-rail px-2 py-1 text-[11px] font-bold tracking-wide text-ink-500">{issue.key}</span>
          <StatusBadge status={uiStatus(issue)} />
          <span className="ml-auto flex items-center gap-1">
            <button title="Visual document editor" aria-label="Visual document editor" onClick={onOpenStudio} disabled={!issue.record || stale} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-rail hover:text-ink-900 disabled:opacity-40">
              <Icon name="file" className="h-4 w-4" />
            </button>
            <button title="Download document" aria-label="Download document" onClick={onDownload} disabled={!issue.record || stale} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-rail hover:text-ink-900 disabled:opacity-40">
              <Icon name="download" className="h-4 w-4" />
            </button>
            <button title="Open document" aria-label="Open document" onClick={onOpenPreview} disabled={!issue.record || stale} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-rail hover:text-ink-900 disabled:opacity-40">
              <Icon name="external" className="h-4 w-4" />
            </button>
            <button title="Delete" aria-label="Delete assignment" onClick={() => setConfirmDelete(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-[#FDECEC] hover:text-[#8F1D17]">
              <Icon name="trash" className="h-4 w-4" />
            </button>
            <button ref={closeRef} title="Close panel" aria-label="Close panel" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-rail text-ink-700 transition-colors duration-150 hover:bg-rail-hover hover:text-ink-900">
              <Icon name="x" className="h-4 w-4" />
            </button>
          </span>
        </div>

        {confirmDelete && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B3261E]/20 bg-[#FDECEC] px-4 py-2.5">
            <p className="text-[13px] font-bold text-[#8F1D17]">Delete {issue.key} permanently?</p>
            <span className="flex gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
              <Button variant="danger" size="sm" onClick={() => onDelete(issue.key)}>
                Delete
              </Button>
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <h2 className="text-[19px] font-extrabold leading-snug tracking-tight">{content?.title ?? issue.aim}</h2>
          <p className="mt-1 text-[12.5px] text-ink-400">
            {fullDate(issue.createdAt)} · Updated {timeAgo(issue.updatedAt ?? issue.createdAt)}
            {issue.experimentNumber ? ` · Experiment ${issue.experimentNumber}` : ''}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-white p-3.5 text-[13px]">
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Subject</dt>
              <dd className="mt-1">
                <SubjectTag subject={issue.subject} />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Difficulty</dt>
              <dd className="mt-1 font-bold" style={{ color: prio.color }}>
                {prio.glyph} {prio.label}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Technology</dt>
              <dd className="mt-1 font-semibold">{issue.technology || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Template</dt>
              <dd className="mt-1 text-[12.5px] font-semibold">
                {issue.record?.template?.id ?? issue.templateId ?? 'default'}{' '}
                <span className="font-medium text-ink-300">v{issue.record?.template?.version ?? 1}</span>
              </dd>
            </div>
            {prov && (
              <div className="col-span-2">
                <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">Provider</dt>
                <dd className="mt-1 text-[12.5px] font-semibold">
                  {prov.provider} · {prov.model}
                </dd>
              </div>
            )}
          </dl>

          {stale && (
            <div className="mt-4 rounded-xl border border-sand-400/50 bg-sand-50 p-4">
              <p className="text-[13px] font-bold text-sand-700">Stored document was cleared</p>
              <p className="mt-1 text-[12.5px] text-sand-700/90">
                The service restarted and no longer has this record. The content below stays readable — regenerate to
                restore the document preview, exports and editing.
              </p>
              <Button onClick={() => onRetry(issue.key)} className="mt-2.5" size="sm">
                <Icon name="refresh" className="h-4 w-4" />
                Regenerate assignment
              </Button>
            </div>
          )}

          {content && (
            <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-line bg-white px-3.5 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={issue.record.options?.includeVivaTitle === true}
                  disabled={optBusy}
                  onChange={(e) => saveOptions({ includeVivaTitle: e.target.checked })}
                  className="h-4 w-4 accent-[#1A4543]"
                />
                Viva Questions heading
                <span className="text-[12px] text-ink-400">(handwritten by faculty)</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={issue.record.options?.typedConclusion !== false}
                  disabled={optBusy}
                  onChange={(e) => saveOptions({ typedConclusion: e.target.checked })}
                  className="h-4 w-4 accent-[#1A4543]"
                />
                Typed conclusion
                <span className="text-[12px] text-ink-400">(uncheck for handwriting space)</span>
              </label>
              {optError && <p className="break-words text-[12px] text-[#8F1D17]">{optError}</p>}
            </div>
          )}

          {recordGone && (
            <div className="mt-4 rounded-xl border border-sand-400/50 bg-sand-50 p-4">
              <p className="text-[13px] font-bold text-sand-700">This preview expired</p>
              <p className="mt-1 text-[12.5px] text-sand-700/90">The service restarted and no longer holds this record. Retry generation to create a fresh one.</p>
              <Button onClick={() => onRetry(issue.key)} size="sm" className="mt-2.5">
                <Icon name="refresh" className="h-4 w-4" />
                Retry generation
              </Button>
            </div>
          )}

          {issue.status === 'inprogress' && (
            <div className="mt-4 flex flex-col gap-2.5 rounded-xl border border-pine-900/15 bg-pine-50 p-4">
              <div className="flex items-center gap-2 text-[13px] font-bold text-pine-900">
                <Spinner />
                Generating assignment…
              </div>
              <p className="text-[12.5px] text-pine-900/70">This usually takes under a minute. You can keep browsing — we&apos;ll notify you when it&apos;s ready.</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-pine-900/10">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-pine-800" />
              </div>
            </div>
          )}

          {issue.status === 'failed' && (
            <div className="mt-4 rounded-xl border border-[#B3261E]/20 bg-[#FDECEC] p-4">
              <p className="text-[13px] font-bold text-[#8F1D17]">Generation needs attention</p>
              <p className="mt-1 break-words text-[12.5px] text-[#8F1D17]/90">{issue.error || 'The service could not complete this request.'}</p>
              <Button variant="danger" size="sm" onClick={() => onRetry(issue.key)} className="mt-2.5">
                <Icon name="refresh" className="h-4 w-4" />
                Retry generation
              </Button>
            </div>
          )}

          {!content && issue.status !== 'inprogress' && issue.status !== 'failed' && (
            loadingFull ? (
              <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-pine-900/15 bg-pine-50 p-4">
                <Spinner />
                <p className="text-[13px] font-semibold text-pine-900">Loading assignment…</p>
              </div>
            ) : fullError ? (
              <div className="mt-4 rounded-xl border border-[#B3261E]/20 bg-[#FDECEC] p-4">
                <p className="text-[13px] font-bold text-[#8F1D17]">Couldn&apos;t load this assignment</p>
                <p className="mt-1 break-words text-[12.5px] text-[#8F1D17]/90">{fullError}</p>
                <Button variant="danger" size="sm" onClick={() => setReloadTick((t) => t + 1)} className="mt-2.5">
                  <Icon name="refresh" className="h-4 w-4" />
                  Retry
                </Button>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-line bg-white p-4 text-[13px] text-ink-700">
                <p className="font-bold text-ink-900">Aim</p>
                <p className="mt-1">{issue.aim}</p>
                {issue.description && <p className="mt-2 text-ink-500">{issue.description}</p>}
                <Button onClick={() => onRetry(issue.key)} className="mt-3">
                  <Icon name="send" className="h-4 w-4" />
                  Generate assignment
                </Button>
              </div>
            )
          )}

          {content && (
            <div className="mt-5 flex flex-col gap-6 pb-2">
              <section>
                <SectionHeading icon="send">Aim</SectionHeading>
                <p className="mt-1.5 rounded-lg bg-white px-3 py-2.5 text-[13px] leading-relaxed ring-1 ring-inset ring-line-soft">{content.aim}</p>
              </section>

              <section>
                <SectionHeading icon="check">Objectives · {content.objectives.length}</SectionHeading>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {content.objectives.map((o, i) => (
                    <li key={i} className="flex items-start gap-2.5 rounded-lg bg-white px-3 py-2 text-[13px] ring-1 ring-inset ring-line-soft">
                      <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-sage-100 text-pine-900 ring-1 ring-inset ring-sage-300/60">
                        <Icon name="check" className="h-3 w-3" />
                      </span>
                      {o}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <SectionHeading icon="book">Theory</SectionHeading>
                <div className="mt-1.5 flex flex-col gap-2.5">
                  {content.theory.map((t, i) => (
                    <p key={i} className="text-[13px] leading-relaxed text-ink-700">
                      {t}
                    </p>
                  ))}
                </div>
              </section>

              <section>
                <SectionHeading icon="list">Steps · {content.steps.length}</SectionHeading>
                <ol className="mt-2 flex flex-col gap-3">
                  {content.steps.map((s) => (
                    <li key={s.number} className="overflow-hidden rounded-xl border border-line bg-white">
                      <div className="flex items-center gap-2.5 border-b border-line-soft bg-paper px-3 py-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pine-900 text-[12px] font-bold text-white">
                          {s.number}
                        </span>
                        <p className="text-[13px] font-bold">{s.title}</p>
                      </div>
                      <div className="px-3 py-2.5">
                        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-700">
                          {s.description.map((d, j) => (
                            <li key={j}>{d}</li>
                          ))}
                        </ul>
                        {s.code && (
                          <div className="mt-2.5">
                            <CodeBlock code={s.code} language={s.language} />
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <SectionHeading icon="file">Conclusion</SectionHeading>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-700">{content.conclusion}</p>
              </section>

              {(issue.record?.sources?.length > 0) && (
                <section>
                  <SectionHeading icon="external">Sources used · {issue.record.sources.length}</SectionHeading>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {issue.record.sources.map((s, i) => (
                      <li key={i} className="rounded-lg bg-white px-3 py-2 text-[13px] ring-1 ring-inset ring-line-soft">
                        <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold text-pine-800 hover:underline">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!stale && (
                <section>
                  <SectionHeading icon="download">Exports</SectionHeading>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => exportFile('docx')} disabled={exportBusy !== ''}>
                      <Icon name="download" className="h-4 w-4" />
                      {exportBusy === 'docx' ? 'Preparing…' : 'Export DOCX'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => exportFile('pdf')} disabled={exportBusy !== ''}>
                      <Icon name="download" className="h-4 w-4" />
                      {exportBusy === 'pdf' ? 'Compiling…' : 'Export PDF'}
                    </Button>
                  </div>
                  {exportError && <p className="mt-2 break-words text-[12px] text-[#8F1D17]">{exportError}</p>}
                </section>
              )}

              {!stale && (
                <section>
                  <div className="flex items-center justify-between">
                    <SectionHeading icon="check">Edit sections</SectionHeading>
                    <button onClick={() => { setEditing((v) => !v); setEditError('') }} className="text-[12.5px] font-bold text-pine-800 hover:underline">
                      {editing ? 'Done' : 'Edit'}
                    </button>
                  </div>
                {editing && (
                  <div className="mt-2 flex flex-col gap-3">
                    {EDITABLE_SECTIONS.map((s) => (
                      <div key={s}>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-[12px] font-bold capitalize text-ink-700">{s}</p>
                          <button onClick={() => regenSection(s)} disabled={regenBusy !== ''} className="text-[12px] font-bold text-pine-800 hover:underline disabled:opacity-50">
                            {regenBusy === s ? 'Regenerating…' : 'Regenerate'}
                          </button>
                        </div>
                        <textarea
                          value={drafts[s] ?? sectionToText(s, content[s])}
                          onChange={(e) => setDrafts((d) => ({ ...d, [s]: e.target.value }))}
                          rows={['title', 'aim'].includes(s) ? 2 : 6}
                          spellCheck={false}
                          className="w-full rounded-lg border border-line bg-white px-2.5 py-2 font-mono text-[12px] leading-relaxed transition-colors focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15"
                        />
                      </div>
                    ))}
                    <div>
                      <Button onClick={saveAllSections} disabled={saveBusy} size="sm">
                        {saveBusy ? 'Saving…' : 'Save all sections'}
                      </Button>
                    </div>
                    {editError && <p className="break-words text-[12px] text-[#8F1D17]">{editError}</p>}
                  </div>
                )}
                </section>
              )}

              {!stale && (
                <section>
                  <div className="flex items-center justify-between">
                    <SectionHeading icon="file">LaTeX source</SectionHeading>
                    <button onClick={loadLatex} disabled={latexBusy} className="text-[12.5px] font-bold text-pine-800 hover:underline disabled:opacity-50">
                      {latex === null ? (latexBusy ? 'Loading…' : 'Load') : 'Reload'}
                    </button>
                  </div>
                {latex !== null && (
                  <div className="mt-2 overflow-hidden rounded-lg border border-line bg-white">
                    <div className="max-h-[50vh] overflow-auto">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line-soft bg-paper px-2.5 py-1.5">
                        <span className="text-[11px] font-bold text-ink-400">latex</span>
                        <button onClick={copyLatex} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-semibold text-ink-500 transition-colors hover:bg-rail">
                          <Icon name={copiedLatex ? 'check' : 'copy'} className="h-3.5 w-3.5" />
                          {copiedLatex ? 'Copied!' : 'Copy code'}
                        </button>
                      </div>
                      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed">{latex}</pre>
                    </div>
                    <p className="border-t border-line-soft px-2.5 py-1.5 text-[12px] text-ink-400">PDF export compiles this source in an isolated container.</p>
                  </div>
                )}
                {latexError && <p className="mt-2 break-words text-[12px] text-[#8F1D17]">{latexError}</p>}
                </section>
              )}

              {!stale && (
                <section>
                  <SectionHeading icon="file">Document preview</SectionHeading>
                  <p className="mt-1 text-[12px] text-ink-400">Department header and watermark applied on every page.</p>
                  <div className="mt-2 overflow-hidden rounded-xl border border-line bg-white">
                    <iframe title={`Document preview for ${issue.key}`} key={previewKey} src={`${apiBase}/api/v1/assignments/${issue.record.id}/html`} className="h-[420px] w-full bg-white" />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={onOpenStudio}>
                      <Icon name="file" className="h-4 w-4" />
                      Visual editor
                    </Button>
                    <Button variant="secondary" size="sm" onClick={onDownload}>
                      <Icon name="download" className="h-4 w-4" />
                      Download HTML
                    </Button>
                    <Button variant="secondary" size="sm" onClick={onOpenPreview}>
                      <Icon name="external" className="h-4 w-4" />
                      Print
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowRawJson((v) => !v)}>
                      <Icon name="copy" className="h-4 w-4" />
                      {showRawJson ? 'Hide JSON' : 'View JSON'}
                    </Button>
                  </div>
                  {showRawJson && (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-pine-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                      {JSON.stringify({ provenance: issue.record.provenance, content }, null, 2)}
                    </pre>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
