import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, cx } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import { apiFetch, authHeaders } from '../../services/api.js'
import { BlockInspector } from './BlockInspector.jsx'
import { BlockOutline } from './BlockOutline.jsx'
import { BlockPreview } from './BlockPreview.jsx'
import {
  describeDocumentError,
  fetchAssignmentDocument,
  saveAssignmentDocument,
} from './documentApi.js'
import {
  canExportDocument,
  clearBlockStyle,
  cloneBlock,
  commitHistory,
  createBlock,
  createHistory,
  deleteBlock,
  documentSaveStatus,
  exportBlockedMessage,
  insertBlockAt,
  isDocumentDirty,
  moveBlock,
  moveBlockToIndex,
  newBlockId,
  redoHistory,
  replaceHistoryPresent,
  serializeBlocks,
  undoHistory,
  updateBlockContent,
  updateBlockStyle,
} from './documentEditor.js'

// STAGE 5: full-screen visual document studio.
//
// Three panels: outline (ordered blocks), page preview and formatting. The
// academic `content` snapshot is never edited here; this editor owns only the
// validated `document.blocks` body. Every save is revision-checked and awaited
// before the UI reports success. Local edits survive a failed save/409.

const STATUS_TONE = {
  success: 'bg-sage-100 text-sage-700 ring-sage-300/60',
  warning: 'bg-sand-100 text-sand-700 ring-sand-400/50',
  danger: 'bg-[#FDECEC] text-[#8F1D17] ring-[#B3261E]/20',
  neutral: 'bg-rail text-ink-500 ring-line',
}

function commitIfChanged(history, nextBlocks) {
  if (!history) return history
  if (serializeBlocks(history.present) === serializeBlocks(nextBlocks)) return history
  return commitHistory(history, nextBlocks)
}

function PanelTabs({ panel, onChange }) {
  const tabs = [
    ['outline', 'Outline', 'list'],
    ['preview', 'Preview', 'file'],
    ['format', 'Format', 'check'],
  ]
  return (
    <div className="flex gap-1 border-b border-line bg-paper px-3 py-2 lg:hidden" role="tablist" aria-label="Studio panels">
      {tabs.map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={panel === id}
          onClick={() => onChange(id)}
          className={cx(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-bold transition-colors',
            panel === id ? 'bg-pine-900 text-white' : 'bg-white text-ink-500 ring-1 ring-inset ring-line',
          )}
        >
          <Icon name={icon} className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}

export function DocumentStudio({ issue, apiBase, onClose, onAuthRequired, onSaved }) {
  const [document, setDocument] = useState(null)
  const [history, setHistory] = useState(null)
  const [savedSnapshot, setSavedSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [savePhase, setSavePhase] = useState('idle')
  const [saveError, setSaveError] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [mobilePanel, setMobilePanel] = useState('outline')
  const [confirmAction, setConfirmAction] = useState(null)
  const [exportBusy, setExportBusy] = useState('')
  const [exportError, setExportError] = useState('')
  const closeRef = useRef(null)

  const recordId = issue?.record?.id ?? null
  const title = issue?.record?.content?.title ?? issue?.aim ?? 'Assignment document'

  // Fetch the canonical document. Legacy assignments are projected into blocks
  // by the API on read; nothing is persisted until the user explicitly saves.
  useEffect(() => {
    if (!recordId) return undefined
    let alive = true
    const controller = new AbortController()
    fetchAssignmentDocument({ apiBase, recordId, signal: controller.signal })
      .then((next) => {
        if (!alive) return
        setDocument(next)
        setHistory(createHistory(next.blocks ?? []))
        setSavedSnapshot(serializeBlocks(next.blocks ?? []))
        setSelectedId(next.blocks?.[0]?.id ?? null)
        setSavePhase('idle')
        setSaveError('')
        setExportError('')
        setLastSavedAt(next.documentUpdatedAt ?? null)
        setLoading(false)
      })
      .catch((error) => {
        if (!alive) return
        if (error?.status === 401) onAuthRequired?.()
        setLoadError(describeDocumentError(error))
        setLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [apiBase, recordId, reloadTick, onAuthRequired])

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const previous = window.document.body.style.overflow
    window.document.body.style.overflow = 'hidden'
    return () => {
      window.document.body.style.overflow = previous
    }
  }, [])

  const blocks = history?.present ?? []
  const dirty = isDocumentDirty(history?.present, savedSnapshot)
  const selected = blocks.find((block) => block.id === selectedId) ?? blocks[0] ?? null
  const selectedBlockId = selected?.id ?? null
  const saving = savePhase === 'saving'
  const conflict = savePhase === 'conflict'
  const exportReady = canExportDocument({ dirty, saving, conflict })
  const status = !recordId
    ? { key: 'unavailable', label: 'Unavailable', tone: 'danger' }
    : documentSaveStatus({
        loading,
        saving,
        conflict,
        failed: savePhase === 'error' && dirty,
        dirty,
      })

  const mutateBlocks = useCallback((transform) => {
    setHistory((current) => {
      if (!current) return current
      return commitIfChanged(current, transform(current.present))
    })
  }, [])

  const handleContentChange = useCallback(
    (patch) => {
      if (!selectedBlockId) return
      mutateBlocks((current) => updateBlockContent(current, selectedBlockId, patch))
    },
    [mutateBlocks, selectedBlockId],
  )

  const handleStyleChange = useCallback(
    (patch) => {
      if (!selectedBlockId) return
      mutateBlocks((current) => updateBlockStyle(current, selectedBlockId, patch))
    },
    [mutateBlocks, selectedBlockId],
  )

  const handleClearStyle = useCallback(() => {
    if (!selectedBlockId) return
    mutateBlocks((current) => clearBlockStyle(current, selectedBlockId))
  }, [mutateBlocks, selectedBlockId])

  const handleAdd = useCallback(
    (type) => {
      const block = createBlock(type)
      setHistory((current) => {
        if (!current) return current
        const index = current.present.findIndex((item) => item.id === selectedId)
        const at = index >= 0 ? index + 1 : current.present.length
        return commitIfChanged(current, insertBlockAt(current.present, block, at))
      })
      setSelectedId(block.id)
      setMobilePanel('format')
    },
    [selectedId],
  )

  const handleDuplicate = useCallback((id) => {
    const copyId = newBlockId()
    setHistory((current) => {
      if (!current) return current
      const index = current.present.findIndex((item) => item.id === id)
      if (index < 0) return current
      const copy = cloneBlock(current.present[index], { id: copyId })
      return commitIfChanged(current, insertBlockAt(current.present, copy, index + 1))
    })
    setSelectedId(copyId)
  }, [])

  const handleDelete = useCallback(
    (id) => {
      setHistory((current) => {
        if (!current) return current
        return commitIfChanged(current, deleteBlock(current.present, id))
      })
      if (selectedId === id) {
        const currentBlocks = history?.present ?? []
        const index = currentBlocks.findIndex((block) => block.id === id)
        const remaining = deleteBlock(currentBlocks, id)
        const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
        setSelectedId(next?.id ?? null)
      }
    },
    [history, selectedId],
  )

  const handleMove = useCallback((id, direction) => {
    setHistory((current) => {
      if (!current) return current
      return commitIfChanged(current, moveBlock(current.present, id, direction))
    })
  }, [])

  const handleDropBlock = useCallback((sourceId, targetId) => {
    setHistory((current) => {
      if (!current) return current
      const targetIndex = current.present.findIndex((block) => block.id === targetId)
      if (targetIndex < 0) return current
      return commitIfChanged(current, moveBlockToIndex(current.present, sourceId, targetIndex))
    })
  }, [])

  const undo = useCallback(() => {
    setHistory((current) => undoHistory(current))
  }, [])

  const redo = useCallback(() => {
    setHistory((current) => redoHistory(current))
  }, [])

  const save = useCallback(async () => {
    if (!document || !history || saving || conflict) return false
    if (!isDocumentDirty(history.present, savedSnapshot)) return true
    const sentSnapshot = serializeBlocks(history.present)
    setSavePhase('saving')
    setSaveError('')
    setExportError('')
    try {
      const next = await saveAssignmentDocument({
        apiBase,
        recordId: document.assignmentId,
        revision: document.revision,
        schemaVersion: document.schemaVersion,
        blocks: history.present,
      })
      const nextBlocks = next.blocks ?? []
      setDocument(next)
      // Keep edits typed while the request was in flight. Only replace the
      // local body when it still matches exactly what the server accepted.
      setHistory((current) => {
        if (!current) return current
        if (serializeBlocks(current.present) !== sentSnapshot) return current
        return replaceHistoryPresent(current, nextBlocks)
      })
      setSavedSnapshot(serializeBlocks(nextBlocks))
      setSavePhase('idle')
      setLastSavedAt(next.documentUpdatedAt ?? new Date().toISOString())
      onSaved?.(next)
      return true
    } catch (error) {
      if (error?.status === 401) onAuthRequired?.()
      setSavePhase(error?.status === 409 ? 'conflict' : 'error')
      setSaveError(describeDocumentError(error))
      return false
    }
  }, [
    apiBase,
    conflict,
    document,
    history,
    onAuthRequired,
    onSaved,
    savedSnapshot,
    saving,
  ])

  const reloadLatest = useCallback(() => {
    setLoading(true)
    setLoadError('')
    setSavePhase('idle')
    setSaveError('')
    setExportError('')
    setConfirmAction(null)
    setReloadTick((tick) => tick + 1)
  }, [])

  const requestReload = useCallback(() => {
    if (saving) return
    if (dirty) {
      setConfirmAction('reload')
      return
    }
    reloadLatest()
  }, [dirty, reloadLatest, saving])

  const requestClose = useCallback(() => {
    if (saving) {
      setExportError('Wait for the current save to finish before closing.')
      return
    }
    if (dirty) {
      setConfirmAction('close')
      return
    }
    onClose()
  }, [dirty, onClose, saving])

  // Warn before a refresh/navigation can silently discard local edits.
  useEffect(() => {
    if (!dirty && !saving) return undefined
    function warnBeforeUnload(event) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty, saving])

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      const mod = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        if (confirmAction) {
          setConfirmAction(null)
          return
        }
        event.preventDefault()
        requestClose()
        return
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
        return
      }
      if (!typing && mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (!typing && mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmAction, redo, requestClose, save, undo])

  async function exportFile(kind) {
    if (!exportReady) {
      setExportError(exportBlockedMessage({ dirty, saving, conflict }))
      return
    }
    setExportBusy(kind)
    setExportError('')
    try {
      const res = await apiFetch(`${apiBase}/api/v1/assignments/${recordId}/${kind}`, {
        method: kind === 'pdf' ? 'POST' : 'GET',
        headers: authHeaders(kind === 'pdf' ? { 'content-type': 'application/json' } : {}),
        body: kind === 'pdf' ? '{}' : undefined,
        signal: AbortSignal.timeout(180000),
      })
      if (res.status === 401) {
        onAuthRequired?.()
        throw new Error('Please log in to continue — then retry the export.')
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error ?? 'Export failed. Please try again.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `${issue?.key ?? 'assignment'}-assignment.${kind}`
      window.document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      setExportBusy('')
    }
  }

  const shellHeader = (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-white px-3 py-2.5 sm:px-4">
      <button
        type="button"
        onClick={requestClose}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rail text-ink-600 transition-colors hover:bg-rail-hover hover:text-ink-900"
        aria-label="Close document studio"
        title="Close document studio"
      >
        <Icon name="arrowLeft" className="h-4 w-4" />
      </button>
      <div className="min-w-0">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-300">Document studio</p>
        <h1 className="truncate text-[15px] font-extrabold leading-tight text-ink-900">{title}</h1>
      </div>
      <span className="hidden rounded-md bg-rail px-2 py-1 text-[11px] font-bold tracking-wide text-ink-500 sm:inline-flex">
        {issue?.key}
      </span>
      <span className="hidden max-w-[220px] truncate rounded-md bg-pine-50 px-2 py-1 text-[10.5px] font-bold text-pine-800 ring-1 ring-inset ring-pine-900/15 md:inline-flex">
        {document?.template?.name ?? document?.template?.id ?? 'Template'} · v
        {document?.template?.version ?? '—'}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <span
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-bold ring-1 ring-inset',
            STATUS_TONE[status.tone] ?? STATUS_TONE.neutral,
          )}
          role="status"
          aria-live="polite"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {status.label}
        </span>
        <button
          type="button"
          onClick={undo}
          disabled={!history?.past?.length || saving}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-rail hover:text-ink-900 disabled:opacity-30"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <Icon name="undo" className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!history?.future?.length || saving}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-rail hover:text-ink-900 disabled:opacity-30"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Icon name="redo" className="h-4 w-4" />
        </button>
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || conflict}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <button
          ref={closeRef}
          type="button"
          onClick={requestClose}
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-bold text-ink-500 transition-colors hover:bg-rail hover:text-ink-900"
        >
          Close
        </button>
      </div>
    </header>
  )

  if (!recordId || loading || loadError || !document || !history) {
    const missingRecord = !recordId
    return (
      <div
        className="fixed inset-0 z-[60] flex flex-col bg-paper"
        role="dialog"
        aria-modal="true"
        aria-label="Document studio"
      >
        {shellHeader}
        <div className="flex min-h-0 flex-1 items-center justify-center p-5">
          {missingRecord ? (
            <div className="w-full max-w-lg rounded-xl border border-[#B3261E]/20 bg-[#FDECEC] p-5">
              <p className="text-[14px] font-extrabold text-[#8F1D17]">This assignment has no saved document</p>
              <p className="mt-1.5 break-words text-[13px] leading-relaxed text-[#8F1D17]/90">
                Generate or reload the assignment before opening the visual editor.
              </p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-pine-900/15 bg-white px-5 py-4 text-[13px] font-semibold text-pine-900 shadow-sm">
              <Spinner />
              Loading document…
            </div>
          ) : (
            <div className="w-full max-w-lg rounded-xl border border-[#B3261E]/20 bg-[#FDECEC] p-5">
              <p className="text-[14px] font-extrabold text-[#8F1D17]">Couldn&apos;t open this document</p>
              <p className="mt-1.5 break-words text-[13px] leading-relaxed text-[#8F1D17]/90">{loadError}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setLoading(true)
                    setLoadError('')
                    setReloadTick((tick) => tick + 1)
                  }}
                >
                  <Icon name="refresh" className="h-4 w-4" />
                  Retry
                </Button>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-paper"
      role="dialog"
      aria-modal="true"
      aria-label="Document studio"
    >
      {shellHeader}

      {document.normalization?.missingBlocks && (
        <div className="flex items-start gap-2 border-b border-sand-400/40 bg-sand-50 px-3 py-2 text-[12px] leading-relaxed text-sand-700 sm:px-4">
          <Icon name="file" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            This assignment predates the visual editor. Its academic content was converted into editable blocks for
            preview only — saving stores the new block body without rewriting the original content.
          </p>
        </div>
      )}

      {(conflict || (savePhase === 'error' && dirty)) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[#B3261E]/20 bg-[#FDECEC] px-3 py-2 text-[12.5px] font-semibold text-[#8F1D17] sm:px-4"
        >
          <Icon name="x" className="h-3.5 w-3.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{saveError}</p>
          {conflict ? (
            <Button variant="secondary" size="sm" onClick={requestReload} disabled={saving}>
              <Icon name="refresh" className="h-3.5 w-3.5" />
              Reload latest
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => void save()} disabled={saving}>
              <Icon name="refresh" className="h-3.5 w-3.5" />
              Retry save
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2 sm:px-4">
        <div className="min-w-0">
          <p className="text-[11.5px] font-semibold text-ink-500">
            Exports use the saved document — save before exporting.
          </p>
          <p className="text-[10.5px] text-ink-300">
            Visual block rendering in HTML/DOCX/LaTeX/PDF lands in Stage 6; these exports keep the current renderer.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {['html', 'docx', 'pdf'].map((kind) => (
            <Button
              key={kind}
              variant="secondary"
              size="sm"
              onClick={() => void exportFile(kind)}
              disabled={!exportReady || exportBusy !== ''}
              title={exportReady ? `Export ${kind.toUpperCase()}` : exportBlockedMessage({ dirty, saving, conflict })}
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              {exportBusy === kind ? 'Preparing…' : kind.toUpperCase()}
            </Button>
          ))}
        </div>
        {!exportReady && (
          <p className="w-full text-[11.5px] font-semibold text-sand-700">
            {exportBlockedMessage({ dirty, saving, conflict })}
          </p>
        )}
        {exportError && <p className="w-full break-words text-[12px] text-[#8F1D17]">{exportError}</p>}
        {lastSavedAt && (
          <p className="w-full text-[10.5px] text-ink-300">
            Last saved {new Date(lastSavedAt).toLocaleString()}
          </p>
        )}
      </div>

      <PanelTabs panel={mobilePanel} onChange={setMobilePanel} />

      <div className="grid min-h-0 flex-1 grid-rows-1 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <div className={cx('min-h-0', mobilePanel === 'outline' ? 'block' : 'hidden', 'lg:block')}>
          <BlockOutline
            blocks={blocks}
            selectedId={selectedBlockId}
            onSelect={setSelectedId}
            onAdd={handleAdd}
            onMove={handleMove}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onDropBlock={handleDropBlock}
          />
        </div>
        <div className={cx('min-h-0', mobilePanel === 'preview' ? 'block' : 'hidden', 'lg:block')}>
          <BlockPreview
            document={document}
            blocks={blocks}
            selectedId={selectedBlockId}
            onSelect={setSelectedId}
          />
        </div>
        <div className={cx('min-h-0', mobilePanel === 'format' ? 'block' : 'hidden', 'lg:block')}>
          <BlockInspector
            block={selected}
            onContentChange={handleContentChange}
            onStyleChange={handleStyleChange}
            onClearStyle={handleClearStyle}
          />
        </div>
      </div>

      {confirmAction && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-pine-950/45 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="studio-confirm-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-[0_24px_64px_rgba(15,46,45,0.35)]">
            <h2 id="studio-confirm-title" className="text-[16px] font-extrabold text-ink-900">
              {confirmAction === 'reload' ? 'Discard local edits and reload?' : 'Discard unsaved changes?'}
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
              {confirmAction === 'reload'
                ? 'Reloading replaces this editor with the latest saved document. Your current local edits will be lost.'
                : 'Your changes have not been saved. Closing now discards them; the saved document stays unchanged.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)} autoFocus>
                Keep editing
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  const action = confirmAction
                  setConfirmAction(null)
                  if (action === 'reload') reloadLatest()
                  else onClose()
                }}
              >
                {confirmAction === 'reload' ? 'Discard and reload' : 'Discard and close'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
