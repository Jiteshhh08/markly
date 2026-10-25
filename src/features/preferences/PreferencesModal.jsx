import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, ModalShell, inputCls } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import {
  buildScopedTemplateChoices,
  isPrivateOnly,
  isUsableTemplate,
  normalizeTemplate,
  templateKey,
  templateLabel,
} from './preferences.js'
import {
  describePreferencesError,
  fetchPreferenceOptions,
  fetchPreferences,
  savePreferences,
} from './preferencesApi.js'

// STAGE 4: first-time setup and profile settings share this modal. The form
// state lives here; the parent only supplies the current snapshot and receives
// the saved response (which is also what /auth/me and the template catalogue
// refresh from). Opening this modal over CreateModal is supported by the
// `stacked` layer, so an in-progress aim/description is never lost.

function formFromPreferences(preferences, { privateOnly = false } = {}) {
  const p = preferences?.preferences ?? {}
  const savedPreferred = preferences?.preferredTemplate
  const preferredAvailable = Boolean(savedPreferred?.id) && savedPreferred.available !== false
  // Legacy preferences only stored an id. The response resolves the current
  // version for display; use it so opening and saving the form pins that exact
  // version instead of failing to match an empty version.
  const preferredVersion =
    p.preferredTemplateVersion ?? savedPreferred?.version ?? null
  const usePrivateOnly = privateOnly || isPrivateOnly(preferences)
  return {
    collegeId: usePrivateOnly ? '' : p.collegeId ?? '',
    departmentId: usePrivateOnly ? '' : p.departmentId ?? '',
    preferredTemplateId: preferredAvailable ? p.preferredTemplateId ?? '' : '',
    preferredTemplateVersion:
      preferredAvailable && preferredVersion != null ? String(preferredVersion) : '',
    privateOnly: usePrivateOnly,
  }
}

export function PreferencesModal({
  initialPreferences = null,
  templates = [],
  firstTime = false,
  stacked = false,
  onClose,
  onSaved,
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [options, setOptions] = useState(null)
  const [current, setCurrent] = useState(initialPreferences)
  const [form, setForm] = useState(() => formFromPreferences(initialPreferences))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    Promise.all([fetchPreferences(), fetchPreferenceOptions()])
      .then(([preferences, preferenceOptions]) => {
        if (!alive) return
        const colleges = preferenceOptions?.colleges ?? []
        const next = formFromPreferences(preferences, {
          privateOnly: colleges.length === 0,
        })
        setCurrent(preferences)
        setOptions(preferenceOptions)
        setForm(next)
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(describePreferencesError(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const colleges = useMemo(() => options?.colleges ?? [], [options])
  const selectedCollege = useMemo(
    () => colleges.find((college) => college.id === form.collegeId) ?? null,
    [colleges, form.collegeId],
  )
  const branchOptions = useMemo(() => selectedCollege?.branches ?? [], [selectedCollege])
  const selectedBranch = useMemo(
    () => branchOptions.find((branch) => branch.id === form.departmentId) ?? null,
    [branchOptions, form.departmentId],
  )

  const choices = useMemo(
    () =>
      buildScopedTemplateChoices({
        templates: [
          ...(options?.personalTemplates ?? []),
          ...(selectedBranch?.templates ?? []),
          ...(templates ?? []),
        ],
        preferredTemplate: current?.preferredTemplate,
        branchDefault: selectedBranch?.defaultTemplate,
        collegeId: form.privateOnly ? null : form.collegeId || null,
        departmentId: form.privateOnly ? null : form.departmentId || null,
      }),
    [
      options,
      selectedBranch,
      templates,
      current,
      form.privateOnly,
      form.collegeId,
      form.departmentId,
    ],
  )

  const selectedChoice = useMemo(
    () =>
      choices.find(
        (template) =>
          template.id === form.preferredTemplateId &&
          String(template.version) === String(form.preferredTemplateVersion),
      ) ?? null,
    [choices, form.preferredTemplateId, form.preferredTemplateVersion],
  )

  const branchDefault = normalizeTemplate(selectedBranch?.defaultTemplate)
  const branchDefaultUsable = Boolean(branchDefault && isUsableTemplate(branchDefault))

  function setPrivateOnly(checked) {
    setForm((previous) => ({
      ...previous,
      privateOnly: checked,
      collegeId: checked ? '' : previous.collegeId,
      departmentId: checked ? '' : previous.departmentId,
      preferredTemplateId: '',
      preferredTemplateVersion: '',
    }))
  }

  function chooseCollege(collegeId) {
    setForm((previous) => ({
      ...previous,
      collegeId,
      departmentId: '',
      preferredTemplateId: '',
      preferredTemplateVersion: '',
    }))
  }

  function chooseBranch(departmentId) {
    setForm((previous) => ({
      ...previous,
      departmentId,
      preferredTemplateId: '',
      preferredTemplateVersion: '',
    }))
  }

  function choosePreferred(key) {
    if (!key) {
      setForm((previous) => ({
        ...previous,
        preferredTemplateId: '',
        preferredTemplateVersion: '',
      }))
      return
    }
    const chosen = choices.find((template) => templateKey(template) === key)
    if (!chosen) return
    setForm((previous) => ({
      ...previous,
      preferredTemplateId: chosen.id,
      preferredTemplateVersion: String(chosen.version),
    }))
  }

  async function submit(event) {
    event.preventDefault()
    if (saving) return
    setError('')

    if (!form.privateOnly) {
      if (!form.collegeId) {
        setError('Select your college, or choose “My college isn’t listed”.')
        return
      }
      if (!form.departmentId) {
        setError('Select your branch.')
        return
      }
    }

    if (form.preferredTemplateId && !selectedChoice) {
      setError('That template is no longer available. Choose another one.')
      return
    }

    setSaving(true)
    try {
      const saved = await savePreferences({
        collegeId: form.privateOnly ? null : form.collegeId,
        departmentId: form.privateOnly ? null : form.departmentId,
        preferredTemplateId: selectedChoice?.id ?? null,
        preferredTemplateVersion: selectedChoice?.version ?? null,
      })
      onSaved?.(saved)
    } catch (err) {
      setError(describePreferencesError(err))
    } finally {
      setSaving(false)
    }
  }

  const title = firstTime ? 'Set up your college and branch' : 'College and branch preferences'
  const subtitle = firstTime
    ? 'Choose this once — new assignments use your branch’s exact default template.'
    : 'Update your college, branch and preferred document template.'

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      stacked={stacked}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {firstTime ? 'Not now' : 'Cancel'}
          </Button>
          <Button
            onClick={() => document.getElementById('preferences-form')?.requestSubmit()}
            disabled={saving || loading || Boolean(loadError)}
            size="lg"
          >
            {saving ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Save preferences'}
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-paper px-4 py-6 text-[13px] font-semibold text-ink-600">
          <Spinner />
          Loading colleges and templates…
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-line bg-white px-4 py-6 text-center">
          <p className="text-[13.5px] font-semibold text-ink-900">{loadError}</p>
          <Button variant="secondary" className="mt-4" onClick={() => setReloadKey((value) => value + 1)}>
            <Icon name="refresh" className="h-4 w-4" />
            Try again
          </Button>
        </div>
      ) : (
        <form id="preferences-form" onSubmit={submit} className="flex flex-col gap-4">
          {firstTime && (
            <div className="rounded-xl border border-pine-900/15 bg-pine-50 px-3.5 py-3">
              <p className="text-[13px] font-semibold text-pine-900">One-time setup</p>
              <p className="mt-0.5 text-[12.5px] text-ink-500">
                Your college and branch decide which shared templates you can use. You can change
                this later from your profile.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="College" htmlFor="pref-college">
              <select
                id="pref-college"
                value={form.collegeId}
                onChange={(event) => chooseCollege(event.target.value)}
                className={inputCls}
                disabled={form.privateOnly}
              >
                <option value="">Select your college</option>
                {colleges.map((college) => (
                  <option key={college.id} value={college.id}>
                    {college.name || college.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Branch"
              htmlFor="pref-branch"
              hint={form.collegeId ? 'Branches are filtered by the selected college.' : 'Select a college first.'}
            >
              <select
                id="pref-branch"
                value={form.departmentId}
                onChange={(event) => chooseBranch(event.target.value)}
                className={inputCls}
                disabled={form.privateOnly || !form.collegeId}
              >
                <option value="">{form.collegeId ? 'Select your branch' : 'Select a college first'}</option>
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name || branch.id}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-paper px-3.5 py-3 text-[13px]">
            <input
              type="checkbox"
              checked={form.privateOnly}
              onChange={(event) => setPrivateOnly(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#1A4543]"
            />
            <span>
              <span className="font-bold">My college isn’t listed</span>
              <span className="block text-[12.5px] text-ink-500">
                Continue with your own private templates or published platform templates. You can
                still choose a college later.
              </span>
            </span>
          </label>

          {!form.privateOnly && selectedBranch && (
            <div className="rounded-xl border border-line bg-paper px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-300">
                  Branch default
                </p>
                {branchDefault && branchDefaultUsable && <Badge tone="sage">Selected automatically</Badge>}
                {branchDefault && !branchDefaultUsable && <Badge tone="sand">Unavailable</Badge>}
              </div>
              {branchDefault ? (
                <p className="mt-1 text-[13px] font-semibold text-ink-900">
                  {branchDefault.name} v{branchDefault.version}
                </p>
              ) : (
                <p className="mt-1 text-[13px] text-ink-500">
                  Your college admin hasn’t set a default for this branch yet. Choose an eligible
                  template below.
                </p>
              )}
              {branchDefault && !branchDefaultUsable && (
                <p className="mt-1 text-[12.5px] text-[#8F1D17]">
                  The configured default is no longer published. Choose another eligible template.
                </p>
              )}
            </div>
          )}

          <Field
            label="Preferred template"
            htmlFor="pref-template"
            hint={
              form.privateOnly
                ? 'Choose a private or platform template to generate without a college default. The exact version is pinned when saved.'
                : 'Optional. New assignments use your saved preference when it is still available; otherwise your branch default is used. The exact version is pinned when saved.'
            }
          >
            <select
              id="pref-template"
              value={selectedChoice ? templateKey(selectedChoice) : ''}
              onChange={(event) => choosePreferred(event.target.value)}
              className={inputCls}
              disabled={!form.privateOnly && !selectedBranch}
            >
              <option value="">
                {branchDefault && branchDefaultUsable
                  ? `Use branch default — ${branchDefault.name} v${branchDefault.version}`
                  : 'No preferred template'}
              </option>
              {choices.map((template) => (
                <option key={templateKey(template)} value={templateKey(template)}>
                  {templateLabel(template, {
                    branchDefault: template.isBranchDefault,
                    preferred: template.isPreferred,
                  })}
                </option>
              ))}
            </select>
          </Field>

          {form.privateOnly && choices.length === 0 && (
            <p className="rounded-lg bg-sand-50 px-3 py-2 text-[12.5px] text-sand-700 ring-1 ring-inset ring-sand-400/40">
              No private or platform templates are available yet. You can save this setup now and
              create a private template from the Templates page.
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[13px] font-medium text-[#8F1D17]">
              {error}
            </p>
          )}

          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1}>
            submit
          </button>
        </form>
      )}
    </ModalShell>
  )
}
