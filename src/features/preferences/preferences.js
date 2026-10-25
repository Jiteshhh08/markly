// STAGE 4 pure preference/template helpers.
//
// These functions are intentionally plain JS (no JSX) so the resolution and
// preselection rules can be pinned by hermetic node:test suites. They never
// decide authorization — the API does that — they only keep the UI from
// offering a template the server would reject.

export const TEMPLATE_SCOPE_PLATFORM = 'platform'
export const TEMPLATE_SCOPE_COLLEGE = 'college'
export const TEMPLATE_SCOPE_PRIVATE = 'private'
export const TEMPLATE_SCOPE_LEGACY = 'legacy'

export function isPublishedTemplate(template) {
  return template?.status === 'active' || template?.status === 'published'
}

export function isPrivateTemplate(template) {
  return template?.scope === TEMPLATE_SCOPE_PRIVATE
}

export function isUsableTemplate(template) {
  if (!template?.id) return false
  const version = Number(template.version)
  if (!Number.isInteger(version) || version < 1) return false
  if (isPrivateTemplate(template)) return true
  if (template.scope === TEMPLATE_SCOPE_LEGACY) return false
  return isPublishedTemplate(template)
}

export function normalizeTemplate(template) {
  if (!template?.id) return null
  const version = Number(template.version)
  if (!Number.isInteger(version) || version < 1) return null
  return {
    id: String(template.id),
    version,
    name: template.name ?? 'Template',
    status: template.status ?? '',
    scope: template.scope ?? TEMPLATE_SCOPE_LEGACY,
    tenantId: template.tenantId ?? template.collegeId ?? null,
    departmentId: template.departmentId ?? template.branchId ?? null,
    ownerUserId: template.ownerUserId ?? null,
    available: template.available !== false,
  }
}

export function templateKey(template) {
  const t = normalizeTemplate(template)
  return t ? `${t.id}@${t.version}` : ''
}

export function isTemplateEligible(template, { collegeId = null, departmentId = null } = {}) {
  const t = normalizeTemplate(template)
  if (!t || !isUsableTemplate(t)) return false
  if (t.scope === TEMPLATE_SCOPE_PLATFORM || t.scope === TEMPLATE_SCOPE_PRIVATE) return true
  if (t.scope !== TEMPLATE_SCOPE_COLLEGE) return false
  if (!collegeId || t.tenantId !== collegeId) return false
  if (t.departmentId && t.departmentId !== departmentId) return false
  return true
}

export function mergeTemplates(...lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const item of list ?? []) {
      const t = normalizeTemplate(item)
      if (!t) continue
      const key = templateKey(t)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

export function filterEligibleTemplates(
  templates = [],
  { collegeId = null, departmentId = null } = {},
) {
  return mergeTemplates(templates).filter((template) =>
    isTemplateEligible(template, { collegeId, departmentId }),
  )
}

/**
 * Build the selector list for one prospective college/branch scope.
 *
 * Order matters: the saved preference is first, then the branch default, then
 * every other eligible template. An unavailable/stale preference is omitted so
 * the branch default can take its place.
 */
export function buildScopedTemplateChoices({
  templates = [],
  preferredTemplate = null,
  branchDefault = null,
  collegeId = null,
  departmentId = null,
} = {}) {
  const out = []
  const seen = new Set()

  function add(template, meta = {}) {
    const t = normalizeTemplate(template)
    if (!t || t.available === false) return
    if (!isTemplateEligible(t, { collegeId, departmentId })) return
    const key = templateKey(t)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...t, ...meta })
  }

  add(preferredTemplate, { isPreferred: true })
  add(branchDefault, { isBranchDefault: true })
  for (const template of templates) add(template)
  return out
}

export function buildTemplateChoices({ templates = [], extraTemplates = [], preferences = null } = {}) {
  const p = preferences?.preferences ?? {}
  return buildScopedTemplateChoices({
    templates: [...(templates ?? []), ...(extraTemplates ?? [])],
    preferredTemplate: preferences?.preferredTemplate,
    branchDefault: preferences?.branch?.defaultTemplate,
    collegeId: p.collegeId ?? null,
    departmentId: p.departmentId ?? null,
  })
}

export function effectiveDefaultTemplate(preferences) {
  return (
    buildTemplateChoices({ preferences })[0] ?? null
  )
}

export function initialTemplateSelection({
  templates = [],
  extraTemplates = [],
  preferences = null,
  requestedTemplateId = null,
  requestedTemplateVersion = null,
} = {}) {
  const choices = buildTemplateChoices({ templates, extraTemplates, preferences })
  if (requestedTemplateId) {
    const requestedVersion =
      requestedTemplateVersion == null || requestedTemplateVersion === ''
        ? null
        : Number(requestedTemplateVersion)
    // A requested card/prefill pins its exact version. If that exact version
    // is no longer eligible, fall through to the saved preference/default
    // instead of silently choosing a different version of the same id.
    const requested = choices.find(
      (template) =>
        template.id === String(requestedTemplateId) &&
        (requestedVersion == null || template.version === requestedVersion),
    )
    if (requested) {
      return {
        templateId: requested.id,
        templateVersion: String(requested.version),
      }
    }
  }
  const chosen =
    choices.find((template) => template.isPreferred) ??
    choices.find((template) => template.isBranchDefault) ??
    choices[0] ??
    null
  if (!chosen) return { templateId: '', templateVersion: '' }
  return { templateId: chosen.id, templateVersion: String(chosen.version) }
}

export function isSelectionAvailable(selection, choices = []) {
  if (!selection?.templateId) return false
  const version = Number(selection.templateVersion)
  return choices.some(
    (template) =>
      template.id === String(selection.templateId) &&
      (!Number.isInteger(version) || template.version === version),
  )
}

export function templateLabel(template, { branchDefault = false, preferred = false } = {}) {
  const t = normalizeTemplate(template)
  if (!t) return ''
  const tags = []
  if (branchDefault) tags.push('branch default')
  if (preferred) tags.push('your preference')
  if (t.scope === TEMPLATE_SCOPE_PLATFORM) tags.push('platform')
  else if (t.scope === TEMPLATE_SCOPE_COLLEGE) tags.push('college')
  else if (t.scope === TEMPLATE_SCOPE_PRIVATE) tags.push('private')
  return `${t.name} v${t.version}${tags.length ? ` — ${tags.join(', ')}` : ''}`
}

export function setupCompleted(preferences) {
  return preferences?.setupCompleted === true
}

export function isPrivateOnly(preferences) {
  const p = preferences?.preferences
  return Boolean(preferences?.setupCompleted && p && !p.collegeId && !p.departmentId)
}

export function describePreferencesSummary(preferences) {
  if (!preferences?.setupCompleted) return 'Not configured'
  const college = preferences.college?.name ?? ''
  const branch = preferences.branch?.name ?? ''
  if (college && branch) return `${college} · ${branch}`
  return 'Private and platform templates'
}

export function branchDefaultTemplate(preferences) {
  return normalizeTemplate(preferences?.branch?.defaultTemplate)
}
