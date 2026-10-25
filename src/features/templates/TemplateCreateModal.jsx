import { useEffect, useState } from 'react'
import { Button, Field, Input, ModalShell, Select } from '../../components/ui.jsx'
import { Icon } from '../../components/icons.jsx'
import { adminRequest, describeApiError, templateRequest, templateUpload } from '../admin/adminApi.js'

// STAGE 3 create/import entry point. Shared templates are administrator-only;
// ordinary users always create private drafts. Imports are always saved as
// drafts for review and can never auto-publish, regardless of client input.

export function TemplateCreateModal({
  mode,
  colleges = [],
  collegesLoading = false,
  session,
  notify,
  onAuthRequired,
  onClose,
  onCreated,
}) {
  const isImport = mode === 'import'
  const isPlatformAdmin = session?.role === 'platform_admin'
  const canCreateCollege = colleges.length > 0
  const [name, setName] = useState('')
  const [scope, setScope] = useState('private')
  const [collegeId, setCollegeId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [branches, setBranches] = useState([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (scope !== 'college' || !collegeId) {
      setBranches([])
      setBranchId('')
      return undefined
    }
    let alive = true
    setBranchesLoading(true)
    adminRequest(`/colleges/${encodeURIComponent(collegeId)}/branches`)
      .then((data) => {
        if (alive) setBranches(data.branches ?? [])
      })
      .catch(() => {
        if (alive) setBranches([])
      })
      .finally(() => {
        if (alive) setBranchesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [scope, collegeId])

  const scopeOptions = [
    { value: 'private', label: 'Private — only me' },
    ...(canCreateCollege ? [{ value: 'college', label: 'College shared' }] : []),
    ...(isPlatformAdmin ? [{ value: 'platform', label: 'Platform catalogue' }] : []),
  ]

  async function submit(event) {
    event.preventDefault()
    setError('')
    const trimmedName = name.trim()
    if (!isImport && trimmedName.length < 3) {
      setError('Template name must be at least 3 characters.')
      return
    }
    if (trimmedName && trimmedName.length < 3) {
      setError('Template name must be at least 3 characters when provided.')
      return
    }
    if (isImport && !file) {
      setError('Choose a sample PDF first.')
      return
    }
    if (scope === 'college' && !collegeId) {
      setError('Choose a college for a shared template.')
      return
    }
    setBusy(true)
    try {
      let data
      if (isImport) {
        const form = new FormData()
        form.append('file', file)
        if (trimmedName) form.append('name', trimmedName)
        form.append('scope', scope)
        if (scope === 'college') {
          form.append('tenantId', collegeId)
          if (branchId) form.append('departmentId', branchId)
        }
        data = await templateUpload('/from-pdf', form)
      } else {
        const body = { name: trimmedName, scope }
        if (scope === 'college') {
          body.tenantId = collegeId
          if (branchId) body.departmentId = branchId
        }
        data = await templateRequest('/', { method: 'POST', body })
      }
      notify?.(
        'success',
        isImport ? 'Template draft imported' : 'Template created',
        isImport
          ? `${data.template.name} v${data.template.version} is saved as a draft for review.`
          : `${data.template.name} v${data.template.version} is saved as a draft.`,
      )
      onCreated?.(data.template, data.analysis ?? null)
    } catch (err) {
      if (err?.status === 401) {
        onAuthRequired?.()
        setError('Please log in again to continue.')
      } else {
        setError(describeApiError(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <span className="ml-auto" />
      <Button type="submit" form="template-create-form" disabled={busy}>
        <Icon name={isImport ? 'upload' : 'plus'} className="h-4 w-4" />
        {busy ? (isImport ? 'Analyzing…' : 'Creating…') : isImport ? 'Import as draft' : 'Create draft'}
      </Button>
    </div>
  )

  return (
    <ModalShell
      title={isImport ? 'Import template from PDF' : 'New blank template'}
      subtitle={
        isImport
          ? 'Structure is extracted into a draft. Review the configuration before publishing.'
          : 'Start with a private or shared draft, then refine the layout in the editor.'
      }
      onClose={onClose}
      wide
      footer={footer}
    >
      <form id="template-create-form" onSubmit={submit} className="flex flex-col gap-3">
        {error && (
          <div role="alert" className="rounded-lg border border-[#B3261E]/25 bg-[#FDECEC] px-3 py-2 text-[12.5px] text-[#8F1D17]">
            {error}
          </div>
        )}

        <Field
          label="Template name"
          hint={isImport ? 'Optional; extraction suggests a name when omitted.' : 'At least 3 characters.'}
          htmlFor="new-template-name"
        >
          <Input
            id="new-template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required={!isImport}
            placeholder="e.g. Computer Engineering Practical"
          />
        </Field>

        <Field label="Visibility" hint="Private templates never appear in another user's catalogue." htmlFor="new-template-scope">
          <Select
            id="new-template-scope"
            value={scope}
            onChange={(event) => {
              const next = event.target.value
              setScope(next)
              if (next !== 'college') {
                setCollegeId('')
                setBranchId('')
              }
            }}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </Field>

        {scope === 'college' && (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="College" htmlFor="new-template-college">
              <Select
                id="new-template-college"
                value={collegeId}
                onChange={(event) => {
                  setCollegeId(event.target.value)
                  setBranchId('')
                }}
                disabled={collegesLoading}
                required
              >
                <option value="">{collegesLoading ? 'Loading colleges…' : 'Choose a college…'}</option>
                {colleges.map((college) => (
                  <option key={college.id} value={college.id}>{college.name || college.id}</option>
                ))}
              </Select>
            </Field>
            <Field label="Branch (optional)" hint="Leave blank for a college-wide template." htmlFor="new-template-branch">
              <Select
                id="new-template-branch"
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
                disabled={!collegeId || branchesLoading}
              >
                <option value="">{branchesLoading ? 'Loading branches…' : 'All branches'}</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name || branch.id}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {scope === 'platform' && (
          <p className="rounded-lg border border-line-soft bg-paper px-3 py-2 text-[12px] text-ink-500">
            Platform templates are available across colleges when published.
          </p>
        )}

        {isImport && (
          <Field label="Sample PDF" hint="PDF only, up to 25 MB and 40 pages. Active content and malformed files are rejected." htmlFor="new-template-file">
            <input
              id="new-template-file"
              type="file"
              accept="application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-ink-600 file:mr-3 file:rounded-md file:border-0 file:bg-pine-50 file:px-2.5 file:py-1.5 file:text-[12.5px] file:font-semibold file:text-pine-900"
            />
          </Field>
        )}

        <p className="text-[11.5px] leading-relaxed text-ink-400">
          {isImport
            ? 'Imported templates are always drafts. Publishing is a separate, explicit action in the editor.'
            : 'Saving creates v1. Every later edit forks a new immutable version.'}
        </p>
      </form>
    </ModalShell>
  )
}
