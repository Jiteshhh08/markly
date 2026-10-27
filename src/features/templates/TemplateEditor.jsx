import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, LoadingRows, ModalShell, Select, Textarea } from '../../components/ui.jsx'
import { Icon } from '../../components/icons.jsx'
import {
  adminRequest,
  adminUpload,
  describeApiError,
  templateRequest,
} from '../admin/adminApi.js'

// STAGE 3 template editor. Every mutation goes through the existing immutable
// /api/v1/templates lifecycle: editing forks a new version, publishing never
// rewrites an old one, and archiving preserves history. This component only
// shapes the form; the API validates and authorizes every field.

const SECTION_NAMES = ['title', 'aim', 'objectives', 'theory', 'steps', 'conclusion']
const SECTION_LABELS = {
  title: 'Title',
  aim: 'Aim',
  objectives: 'Objectives',
  theory: 'Theory',
  steps: 'Steps',
  conclusion: 'Conclusion',
}
const PAGE_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']
const BORDER_STYLES = ['solid', 'double', 'dashed', 'dotted']
const LENGTH_RE = /^\d{1,3}(?:\.\d{1,2})?(?:px|mm|cm|in|pt)$/i
const ASSET_RE = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/

function statusLabel(status) {
  if (status === 'active' || status === 'published') return 'Published'
  if (status === 'archived') return 'Archived'
  if (status === 'inactive') return 'Inactive'
  return status ? status[0].toUpperCase() + status.slice(1) : 'Draft'
}

function statusTone(status) {
  if (status === 'active' || status === 'published') return 'teal'
  if (status === 'draft') return 'sand'
  return 'neutral'
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function isPublished(template) {
  return template?.status === 'active' || template?.status === 'published'
}

function normalizeBorder(value) {
  if (typeof value === 'boolean') return { enabled: value, style: 'solid', width: '1.5px', color: '#111111' }
  const border = value && typeof value === 'object' ? value : {}
  return {
    enabled: border.enabled !== false,
    style: BORDER_STYLES.includes(border.style) ? border.style : 'solid',
    width: typeof border.width === 'string' ? border.width : '1.5px',
    color: typeof border.color === 'string' ? border.color : '#111111',
  }
}

function initialForm(template = {}) {
  const page = template.page ?? {}
  const pageSettings = template.pageSettings ?? {}
  const margin = page.margin ?? {}
  const typography = template.typography ?? {}
  const header = template.header ?? {}
  const watermark = template.watermark ?? {}
  const footer = template.footer ?? {}
  return {
    name: template.name ?? '',
    description: template.description ?? '',
    pageSize: PAGE_SIZES.includes(page.size) ? page.size : 'A4',
    margins: {
      top: margin.top ?? '110px',
      right: margin.right ?? '18mm',
      bottom: margin.bottom ?? '20mm',
      left: margin.left ?? '18mm',
    },
    orientation: pageSettings.orientation === 'landscape' || page.orientation === 'landscape'
      ? 'landscape'
      : 'portrait',
    columns: String(pageSettings.columns ?? 1),
    border: normalizeBorder(pageSettings.border ?? page.border),
    fontFamily: typography.fontFamily ?? "Georgia, 'Times New Roman', serif",
    baseSize: typography.baseSize ?? '12pt',
    lineHeight: String(typography.lineHeight ?? 1.6),
    requiredSections:
      Array.isArray(template.requiredSections) && template.requiredSections.length > 0
        ? template.requiredSections.filter((section) => SECTION_NAMES.includes(section))
        : [...SECTION_NAMES],
    headerImage: header.image ?? '',
    headerAlt: header.alt ?? '',
    headerHeight: header.height ?? '72px',
    headerEveryPage: header.everyPage !== false,
    watermarkImage: watermark.image ?? '',
    watermarkAlt: watermark.alt ?? '',
    watermarkEveryPage: watermark.everyPage !== false,
    footerText: footer.text ?? '',
    footerPageNumber: footer.showPageNumber !== false,
    logo: template.assets?.logo ?? '',
  }
}

function safeAssetMap(template, logo) {
  const out = {}
  for (const [key, value] of Object.entries(template?.assets ?? {})) {
    if (key.startsWith('$') || typeof value !== 'string') continue
    out[key] = value
  }
  out.logo = String(logo ?? '').trim() || null
  return out
}

function buildPatch(form, template) {
  const margin = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const value = String(form.margins[side] ?? '').trim()
    if (value) margin[side] = value
  }
  const border = {
    enabled: Boolean(form.border.enabled),
    style: form.border.style,
    width: String(form.border.width ?? '').trim() || '1.5px',
    color: String(form.border.color ?? '').trim() || '#111111',
  }
  return {
    name: String(form.name ?? '').trim(),
    description: String(form.description ?? '').trim(),
    page: {
      size: form.pageSize,
      margin,
      border,
    },
    pageSettings: {
      orientation: form.orientation,
      columns: Number(form.columns),
      border,
    },
    typography: {
      fontFamily: String(form.fontFamily ?? '').trim(),
      baseSize: String(form.baseSize ?? '').trim(),
      lineHeight: Number(form.lineHeight),
    },
    requiredSections: form.requiredSections,
    header: {
      image: String(form.headerImage ?? '').trim() || null,
      alt: String(form.headerAlt ?? '').trim(),
      height: String(form.headerHeight ?? '').trim() || '72px',
      everyPage: Boolean(form.headerEveryPage),
    },
    watermark: {
      image: String(form.watermarkImage ?? '').trim() || null,
      alt: String(form.watermarkAlt ?? '').trim(),
      everyPage: Boolean(form.watermarkEveryPage),
    },
    footer: {
      text: String(form.footerText ?? ''),
      showPageNumber: Boolean(form.footerPageNumber),
    },
    assets: safeAssetMap(template, form.logo),
  }
}

function validateForm(form) {
  if (String(form.name ?? '').trim().length < 3) return 'Template name must be at least 3 characters.'
  if (form.requiredSections.length === 0) return 'Choose at least one required section.'
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const value = String(form.margins[side] ?? '').trim()
    if (value && !LENGTH_RE.test(value)) return `The ${side} margin must be a simple px/mm/cm/in/pt value.`
  }
  if (!LENGTH_RE.test(String(form.baseSize ?? '').trim())) return 'Base font size must be a simple pt/px/mm value.'
  const lineHeight = Number(form.lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight < 0.8 || lineHeight > 3) {
    return 'Line height must be between 0.8 and 3.'
  }
  if (!LENGTH_RE.test(String(form.border.width ?? '').trim())) return 'Page border width must be a simple px/mm value.'
  for (const [label, value] of [
    ['Header artwork', form.headerImage],
    ['Watermark artwork', form.watermarkImage],
    ['Logo', form.logo],
  ]) {
    const ref = String(value ?? '').trim()
    if (ref && !ASSET_RE.test(ref)) return `${label} must be a local /assets/ image reference.`
  }
  return ''
}

function AssetInput({ id, label, hint, value, onChange, canUpload, onError, disabled }) {
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')

  async function upload(file) {
    if (!file) return
    setBusy(true)
    setUploadError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const data = await adminUpload('/assets', formData)
      onChange(data.asset.url)
    } catch (err) {
      const message = describeApiError(err)
      setUploadError(message)
      onError?.(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex flex-col gap-1.5">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/assets/uploads/artwork.png"
          disabled={disabled}
          spellCheck={false}
        />
        {canUpload && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:bg-rail">
              <Icon name="upload" className="h-3.5 w-3.5" />
              {busy ? 'Uploading…' : 'Upload image'}
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={busy || disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  void upload(file)
                }}
              />
            </label>
            {value && (
              <button
                type="button"
                onClick={() => onChange('')}
                disabled={disabled}
                className="text-[12px] font-semibold text-ink-500 hover:text-ink-900 disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
        )}
        {uploadError && <p className="text-[11.5px] font-medium text-[#8F1D17]">{uploadError}</p>}
      </div>
    </Field>
  )
}

export function TemplateEditor({
  templateId,
  seed,
  session,
  notify,
  onAuthRequired,
  onClose,
  onSaved,
}) {
  const [template, setTemplate] = useState(seed ?? null)
  const [form, setForm] = useState(() => initialForm(seed ?? {}))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLabel, setPreviewLabel] = useState('Saved version')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [colleges, setColleges] = useState([])
  const [defaultCollegeId, setDefaultCollegeId] = useState('')
  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [branchesBusy, setBranchesBusy] = useState(false)
  const [defaultBusy, setDefaultBusy] = useState(false)

  const id = templateId ?? seed?.id ?? ''
  const isAdmin = session?.role === 'platform_admin' || session?.role === 'college_admin'
  const canUploadAssets = isAdmin
  const locked = template?.status === 'archived'
  const published = isPublished(template)
  const shared = template && template.scope !== 'private' && template.scope !== 'legacy'

  const fail = useCallback(
    (err) => {
      if (err?.status === 401) {
        onAuthRequired?.()
        setError('Your session expired. Please log in again.')
        return
      }
      setError(describeApiError(err))
    },
    [onAuthRequired],
  )

  const loadHistory = useCallback(async () => {
    if (!id) return
    setHistoryError('')
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}/versions`)
      setHistory(data.versions ?? [])
    } catch (err) {
      setHistoryError(describeApiError(err))
    }
  }, [id])

  const loadSavedPreview = useCallback(async () => {
    if (!id) return
    setPreviewBusy(true)
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}/preview`)
      setPreviewHtml(data.html ?? '')
      setPreviewLabel('Saved version')
    } catch {
      setPreviewHtml('')
    } finally {
      setPreviewBusy(false)
    }
  }, [id])

  useEffect(() => {
    let alive = true
    async function load() {
      if (!id) {
        setError('Template id is missing.')
        setLoading(false)
        return
      }
      setLoading(true)
      setError('')
      try {
        const data = await templateRequest(`/${encodeURIComponent(id)}`)
        if (!alive) return
        setTemplate(data.template)
        setForm(initialForm(data.template))
        setDefaultCollegeId(data.template?.tenantId ?? '')
        setBranchId(data.template?.departmentId ?? '')
      } catch (err) {
        if (alive) fail(err)
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [id, fail])

  useEffect(() => {
    if (!loading && template) {
      void loadHistory()
      void loadSavedPreview()
    }
  }, [loading, template, loadHistory, loadSavedPreview])

  useEffect(() => {
    if (!isAdmin) return undefined
    let alive = true
    adminRequest('/colleges')
      .then((data) => {
        if (alive) setColleges(data.colleges ?? [])
      })
      .catch(() => {
        if (alive) setColleges([])
      })
    return () => {
      alive = false
    }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin || !defaultCollegeId) {
      setBranches([])
      setBranchId('')
      return undefined
    }
    let alive = true
    setBranchesBusy(true)
    adminRequest(`/colleges/${encodeURIComponent(defaultCollegeId)}/branches`)
      .then((data) => {
        if (!alive) return
        setBranches(data.branches ?? [])
        setBranchId((current) => {
          if (current && (data.branches ?? []).some((branch) => branch.id === current)) return current
          return data.branches?.[0]?.id ?? ''
        })
      })
      .catch((err) => {
        if (!alive) return
        setBranches([])
        setBranchId('')
        if (err?.status !== 401 && err?.status !== 403) setError(describeApiError(err))
      })
      .finally(() => {
        if (alive) setBranchesBusy(false)
      })
    return () => {
      alive = false
    }
  }, [isAdmin, defaultCollegeId])

  const previewUrlHint = useMemo(() => {
    if (!previewHtml) return ''
    return previewLabel
  }, [previewHtml, previewLabel])

  function updateForm(key, value) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  function updateNested(key, childKey, value) {
    setForm((previous) => ({
      ...previous,
      [key]: { ...previous[key], [childKey]: value },
    }))
  }

  function toggleSection(section) {
    setForm((previous) => {
      const selected = new Set(previous.requiredSections)
      if (selected.has(section)) selected.delete(section)
      else selected.add(section)
      return {
        ...previous,
        requiredSections: SECTION_NAMES.filter((name) => selected.has(name)),
      }
    })
  }

  function applySavedTemplate(saved) {
    setTemplate(saved)
    setForm(initialForm(saved))
    setConfirmArchive(false)
    onSaved?.(saved)
    void loadHistory()
    void loadSavedPreview()
  }

  async function saveDraft() {
    const validation = validateForm(form)
    if (validation) {
      setError(validation)
      return
    }
    setBusy('draft')
    setError('')
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { ...buildPatch(form, template), status: 'draft' },
      })
      applySavedTemplate(data.template)
      notify?.('success', 'Draft saved', `Version ${data.template.version} is saved as a draft.`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function publish() {
    const validation = validateForm(form)
    if (validation) {
      setError(validation)
      return
    }
    setBusy('publish')
    setError('')
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: buildPatch(form, template),
      })
      applySavedTemplate(data.template)
      notify?.(
        'success',
        'New version published',
        `Version ${data.template.version} is published. Previous versions remain unchanged.`,
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function archive() {
    setBusy('archive')
    setError('')
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}/archive`, {
        method: 'POST',
        body: {},
      })
      applySavedTemplate(data.template)
      notify?.(
        'success',
        'Template archived',
        'History is preserved and any branch default pointing at this template was cleared.',
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  async function previewUnsaved() {
    const validation = validateForm(form)
    if (validation) {
      setError(validation)
      return
    }
    setPreviewBusy(true)
    setError('')
    try {
      const data = await templateRequest(`/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        body: buildPatch(form, template),
      })
      setPreviewHtml(data.html ?? '')
      setPreviewLabel('Unsaved changes')
    } catch (err) {
      fail(err)
    } finally {
      setPreviewBusy(false)
    }
  }

  async function previewVersion(version) {
    setPreviewBusy(true)
    setError('')
    try {
      const data = await templateRequest(
        `/${encodeURIComponent(id)}/preview?version=${encodeURIComponent(version)}`,
      )
      setPreviewHtml(data.html ?? '')
      setPreviewLabel(`Version ${version}`)
    } catch (err) {
      fail(err)
    } finally {
      setPreviewBusy(false)
    }
  }

  async function pinDefault() {
    if (!defaultCollegeId || !branchId || !published) return
    setDefaultBusy(true)
    setError('')
    try {
      const data = await adminRequest(
        `/colleges/${encodeURIComponent(defaultCollegeId)}/branches/${encodeURIComponent(branchId)}/default-template`,
        {
          method: 'PUT',
          body: { templateId: id, templateVersion: template.version },
        },
      )
      notify?.(
        'success',
        'Branch default pinned',
        `Version ${data.branch.defaultTemplateVersion} is now the default for this branch.`,
      )
    } catch (err) {
      fail(err)
    } finally {
      setDefaultBusy(false)
    }
  }

  const title = template?.name || seed?.name || 'Template editor'
  const subtitle = template
    ? `${template.id} · v${template.version} · ${statusLabel(template.status)} · ${template.scope ?? 'legacy'}`
    : 'Loading template configuration…'

  const footer = confirmArchive ? (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-[12.5px] font-semibold text-ink-700">
        Archive this template? Published history stays readable, branch defaults are cleared, and this cannot be undone in Stage 3.
      </p>
      <Button variant="secondary" onClick={() => setConfirmArchive(false)} disabled={busy === 'archive'}>
        Cancel
      </Button>
      <Button variant="danger" onClick={archive} disabled={busy === 'archive'}>
        {busy === 'archive' ? 'Archiving…' : 'Archive template'}
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      {!locked && (
        <Button variant="ghost" onClick={() => setConfirmArchive(true)} disabled={Boolean(busy)}>
          <Icon name="archive" className="h-4 w-4" />
          Archive
        </Button>
      )}
      <span className="ml-auto" />
      <Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>
        Close
      </Button>
      <Button variant="secondary" onClick={previewUnsaved} disabled={Boolean(busy) || previewBusy || locked}>
        {previewBusy ? 'Rendering…' : 'Preview changes'}
      </Button>
      <Button variant="secondary" onClick={saveDraft} disabled={Boolean(busy) || locked}>
        {busy === 'draft' ? 'Saving…' : 'Save draft'}
      </Button>
      <Button onClick={publish} disabled={Boolean(busy) || locked}>
        {busy === 'publish' ? 'Publishing…' : 'Publish new version'}
      </Button>
    </div>
  )

  return (
    <ModalShell title={title} subtitle={subtitle} onClose={onClose} extraWide footer={footer}>
      <div className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#B3261E]/25 bg-[#FDECEC] px-3.5 py-3 text-[13px] text-[#8F1D17]">
            <Icon name="x" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => setError('')} className="rounded p-0.5 hover:bg-white/60" aria-label="Dismiss error">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {template && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2.5">
            <Badge tone={statusTone(template.status)}>{statusLabel(template.status)}</Badge>
            <Badge tone={template.scope === 'private' ? 'sand' : 'sage'}>
              {template.scope === 'private' ? 'Private — owner only' : `${template.scope ?? 'legacy'} shared`}
            </Badge>
            <span className="text-[12px] text-ink-500">v{template.version}</span>
            <span className="text-[12px] text-ink-400">
              {template.tenantId ? `College ${template.tenantId}` : 'No college scope'}
              {template.departmentId ? ` · Branch ${template.departmentId}` : ''}
            </span>
            {locked && (
              <span className="ml-auto text-[12px] font-semibold text-ink-500">
                Archived versions are immutable. History stays available.
              </span>
            )}
          </div>
        )}

        {loading ? (
          <LoadingRows count={4} />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4 disabled:opacity-70">
              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Identity</h3>
                <div className="mt-3 flex flex-col gap-2.5">
                  <Field label="Template name" htmlFor="template-name">
                    <Input
                      id="template-name"
                      value={form.name}
                      onChange={(event) => updateForm('name', event.target.value)}
                      maxLength={120}
                      required
                    />
                  </Field>
                  <Field label="Description" hint="Optional internal note shown to template managers." htmlFor="template-description">
                    <Textarea
                      id="template-description"
                      value={form.description}
                      onChange={(event) => updateForm('description', event.target.value)}
                      maxLength={1000}
                      className="min-h-16"
                    />
                  </Field>
                </div>
              </section>

              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Page and margins</h3>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Field label="Page size" htmlFor="page-size">
                    <Select id="page-size" value={form.pageSize} onChange={(event) => updateForm('pageSize', event.target.value)}>
                      {PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Orientation" htmlFor="page-orientation">
                    <Select id="page-orientation" value={form.orientation} onChange={(event) => updateForm('orientation', event.target.value)}>
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </Select>
                  </Field>
                  <Field label="Columns" htmlFor="page-columns">
                    <Select id="page-columns" value={form.columns} onChange={(event) => updateForm('columns', event.target.value)}>
                      <option value="1">1 column</option>
                      <option value="2">2 columns</option>
                      <option value="3">3 columns</option>
                    </Select>
                  </Field>
                  {['top', 'right', 'bottom', 'left'].map((side) => (
                    <Field key={side} label={`${side[0].toUpperCase()}${side.slice(1)} margin`} htmlFor={`margin-${side}`}>
                      <Input
                        id={`margin-${side}`}
                        value={form.margins[side]}
                        onChange={(event) => updateNested('margins', side, event.target.value)}
                        placeholder="18mm"
                      />
                    </Field>
                  ))}
                  <div className="sm:col-span-2">
                    <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
                      <input
                        type="checkbox"
                        checked={form.border.enabled}
                        onChange={(event) => updateNested('border', 'enabled', event.target.checked)}
                      />
                      Show page border
                    </label>
                  </div>
                  {form.border.enabled && (
                    <>
                      <Field label="Border style" htmlFor="border-style">
                        <Select id="border-style" value={form.border.style} onChange={(event) => updateNested('border', 'style', event.target.value)}>
                          {BORDER_STYLES.map((style) => (
                            <option key={style} value={style}>{style}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Border width" htmlFor="border-width">
                        <Input id="border-width" value={form.border.width} onChange={(event) => updateNested('border', 'width', event.target.value)} placeholder="1.5px" />
                      </Field>
                      <Field label="Border colour" htmlFor="border-color">
                        <Input id="border-color" type="color" value={form.border.color} onChange={(event) => updateNested('border', 'color', event.target.value)} className="h-10 p-1" />
                      </Field>
                    </>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Typography</h3>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <Field label="Font family" htmlFor="font-family">
                    <Input id="font-family" value={form.fontFamily} onChange={(event) => updateForm('fontFamily', event.target.value)} />
                  </Field>
                  <Field label="Base size" htmlFor="base-size">
                    <Input id="base-size" value={form.baseSize} onChange={(event) => updateForm('baseSize', event.target.value)} placeholder="12pt" />
                  </Field>
                  <Field label="Line height" htmlFor="line-height">
                    <Input id="line-height" type="number" min="0.8" max="3" step="0.05" value={form.lineHeight} onChange={(event) => updateForm('lineHeight', event.target.value)} />
                  </Field>
                </div>
              </section>

              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Header, watermark and logo</h3>
                <div className="mt-3 flex flex-col gap-3">
                  <AssetInput
                    id="header-image"
                    label="Header artwork"
                    hint="Local image path. SVG files are rejected; uploads are signature-checked."
                    value={form.headerImage}
                    onChange={(value) => updateForm('headerImage', value)}
                    canUpload={canUploadAssets}
                    onError={setError}
                    disabled={locked}
                  />
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Field label="Header alt text" htmlFor="header-alt">
                      <Input id="header-alt" value={form.headerAlt} onChange={(event) => updateForm('headerAlt', event.target.value)} />
                    </Field>
                    <Field label="Header height" htmlFor="header-height">
                      <Input id="header-height" value={form.headerHeight} onChange={(event) => updateForm('headerHeight', event.target.value)} placeholder="72px" />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
                    <input
                      type="checkbox"
                      checked={form.headerEveryPage}
                      onChange={(event) => updateForm('headerEveryPage', event.target.checked)}
                    />
                    Repeat header on every page
                  </label>

                  <AssetInput
                    id="watermark-image"
                    label="Watermark artwork"
                    hint="Watermark opacity is always fixed at 50% by the renderer."
                    value={form.watermarkImage}
                    onChange={(value) => updateForm('watermarkImage', value)}
                    canUpload={canUploadAssets}
                    onError={setError}
                    disabled={locked}
                  />
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Field label="Watermark alt text" htmlFor="watermark-alt">
                      <Input id="watermark-alt" value={form.watermarkAlt} onChange={(event) => updateForm('watermarkAlt', event.target.value)} />
                    </Field>
                    <div className="flex items-end pb-2">
                      <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
                        <input
                          type="checkbox"
                          checked={form.watermarkEveryPage}
                          onChange={(event) => updateForm('watermarkEveryPage', event.target.checked)}
                        />
                        Repeat watermark
                      </label>
                    </div>
                  </div>

                  <AssetInput
                    id="logo-image"
                    label="Logo"
                    hint="Optional logo asset reference stored in template assets."
                    value={form.logo}
                    onChange={(value) => updateForm('logo', value)}
                    canUpload={canUploadAssets}
                    onError={setError}
                    disabled={locked}
                  />
                </div>
              </section>

              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Footer</h3>
                <div className="mt-3 flex flex-col gap-2.5">
                  <Field label="Footer text" htmlFor="footer-text">
                    <Textarea id="footer-text" value={form.footerText} onChange={(event) => updateForm('footerText', event.target.value)} maxLength={500} className="min-h-16" />
                  </Field>
                  <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
                    <input
                      type="checkbox"
                      checked={form.footerPageNumber}
                      onChange={(event) => updateForm('footerPageNumber', event.target.checked)}
                    />
                    Show page number
                  </label>
                </div>
              </section>

              <section className="rounded-xl border border-line bg-white p-4">
                <h3 className="text-[13.5px] font-bold">Required sections</h3>
                <p className="mt-0.5 text-[12px] text-ink-500">Sections keep the canonical document order. At least one is required.</p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {SECTION_NAMES.map((section) => (
                    <label key={section} className="flex items-center gap-2 rounded-lg border border-line-soft bg-paper px-2.5 py-2 text-[12.5px] font-semibold text-ink-700">
                      <input
                        type="checkbox"
                        checked={form.requiredSections.includes(section)}
                        onChange={() => toggleSection(section)}
                      />
                      {SECTION_LABELS[section]}
                    </label>
                  ))}
                </div>
              </section>
            </fieldset>

            <aside className="flex min-w-0 flex-col gap-3">
              <section className="rounded-xl border border-line bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[13.5px] font-bold">Preview</h3>
                  {previewUrlHint && <Badge tone="sage">{previewUrlHint}</Badge>}
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={previewUnsaved} disabled={previewBusy || locked}>
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    Refresh
                  </Button>
                </div>
                {previewBusy && !previewHtml ? (
                  <div className="mt-3"><LoadingRows count={2} /></div>
                ) : previewHtml ? (
                  <iframe
                    title="Template preview"
                    sandbox=""
                    srcDoc={previewHtml}
                    className="mt-2 h-[560px] w-full rounded-lg border border-line bg-white"
                  />
                ) : (
                  <p className="mt-3 rounded-lg border border-line-soft bg-paper px-3 py-4 text-[12.5px] text-ink-500">
                    No preview yet. Choose “Preview changes” to render the current form without saving.
                  </p>
                )}
              </section>

              {isAdmin && shared && (
                <section className="rounded-xl border border-line bg-white p-3">
                  <h3 className="text-[13.5px] font-bold">Branch default</h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-500">
                    Pin the current saved version. Publishing newer versions never repoints existing defaults.
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    <Field label="College" htmlFor="default-college">
                      <Select
                        id="default-college"
                        value={defaultCollegeId}
                        onChange={(event) => setDefaultCollegeId(event.target.value)}
                        disabled={Boolean(template?.tenantId) || branchesBusy}
                      >
                        <option value="">Choose a college…</option>
                        {colleges.map((college) => (
                          <option key={college.id} value={college.id}>{college.name || college.id}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Branch" htmlFor="default-branch">
                      <Select
                        id="default-branch"
                        value={branchId}
                        onChange={(event) => setBranchId(event.target.value)}
                        disabled={!defaultCollegeId || branchesBusy}
                      >
                        <option value="">{branchesBusy ? 'Loading branches…' : 'Choose a branch…'}</option>
                        {branches.map((branch) => (
                          <option key={branch.id} value={branch.id}>{branch.name || branch.id}</option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      size="sm"
                      onClick={pinDefault}
                      disabled={!published || !branchId || defaultBusy}
                    >
                      {defaultBusy ? 'Pinning…' : `Pin v${template?.version ?? '?'} as default`}
                    </Button>
                    {!published && (
                      <p className="text-[11.5px] text-sand-700">Publish a version before setting it as a branch default.</p>
                    )}
                  </div>
                </section>
              )}

              <section className="rounded-xl border border-line bg-white p-3">
                <button
                  type="button"
                  onClick={() => setHistoryOpen((value) => !value)}
                  className="flex w-full items-center gap-2 text-left"
                  aria-expanded={historyOpen}
                >
                  <h3 className="text-[13.5px] font-bold">Version history</h3>
                  <Badge tone="neutral">{history.length}</Badge>
                  <Icon name="chevron" className={`ml-auto h-4 w-4 transition-transform ${historyOpen ? 'rotate-90' : ''}`} />
                </button>
                {historyError && <p className="mt-2 text-[11.5px] text-[#8F1D17]">{historyError}</p>}
                {historyOpen && (
                  history.length === 0 ? (
                    <p className="mt-2 text-[12px] text-ink-500">No versions returned.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line-soft">
                      {[...history].sort((a, b) => b.version - a.version).map((entry) => (
                        <li key={`${entry.id}@${entry.version}`} className="flex flex-wrap items-center gap-2 py-2">
                          <span className="text-[12.5px] font-bold">v{entry.version}</span>
                          <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge>
                          <span className="text-[11.5px] text-ink-400">{formatDate(entry.updatedAt ?? entry.createdAt)}</span>
                          <button
                            type="button"
                            onClick={() => previewVersion(entry.version)}
                            className="ml-auto text-[12px] font-bold text-pine-800 hover:text-pine-950"
                          >
                            Preview
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </section>

              {template?.scope === 'private' && (
                <p className="rounded-xl border border-sand-400/40 bg-sand-50 px-3 py-2.5 text-[12px] leading-relaxed text-sand-700">
                  Private template: only you can view or manage it. Administrators cannot open or publish it.
                </p>
              )}
            </aside>
          </div>
        )}
      </div>
    </ModalShell>
  )
}
