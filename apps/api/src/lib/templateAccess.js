import {
  ROLE_PLATFORM_ADMIN,
  isCollegeAdminOf,
  isPlatformAdmin,
  normalizeRole,
} from "./roles.js";

// STAGE 1 template ownership and visibility rules.
//
// Three shared scopes plus an explicit legacy bucket:
//   platform  - global catalogue, published by platform admins
//   college   - shared within one college/branch, published by that college's admins
//   private   - owner only; never appears in another user's catalogue
//   legacy    - ownership unknown; platform-admin review only, never silently shared
//
// `active` is the existing published status. `published` is accepted as an
// explicit alias for new code. Archived versions remain readable to managers
// but are not selectable for new assignments.

export const TEMPLATE_SCOPE_PLATFORM = "platform";
export const TEMPLATE_SCOPE_COLLEGE = "college";
export const TEMPLATE_SCOPE_PRIVATE = "private";
export const TEMPLATE_SCOPE_LEGACY = "legacy";
export const TEMPLATE_SCOPES = Object.freeze([
  TEMPLATE_SCOPE_PLATFORM,
  TEMPLATE_SCOPE_COLLEGE,
  TEMPLATE_SCOPE_PRIVATE,
  TEMPLATE_SCOPE_LEGACY,
]);

// `active` is the existing published state; `published` is an explicit alias
// for new admin code. `draft` and `archived` complete the lifecycle.
export const TEMPLATE_STATUSES = Object.freeze(["draft", "active", "published", "archived"]);

export function templateScope(template) {
  return TEMPLATE_SCOPES.includes(template?.scope) ? template.scope : TEMPLATE_SCOPE_LEGACY;
}

export function templateCollegeId(template) {
  return template?.tenantId ?? template?.collegeId ?? null;
}

export function templateBranchId(template) {
  return template?.departmentId ?? template?.branchId ?? null;
}

export function isPublishedTemplate(template) {
  return template?.status === "active" || template?.status === "published";
}

export function isArchivedTemplate(template) {
  return template?.status === "archived";
}

export function isLegacyTemplate(template) {
  return templateScope(template) === TEMPLATE_SCOPE_LEGACY || template?.legacyUnscoped === true;
}

export function isPrivateTemplate(template) {
  return templateScope(template) === TEMPLATE_SCOPE_PRIVATE;
}

export function isTemplateOwner(actor, template) {
  return Boolean(actor?.id && template?.ownerUserId && String(actor.id) === String(template.ownerUserId));
}

function matchesActorCollege(actor, template) {
  const collegeId = templateCollegeId(template);
  if (!collegeId || actor?.preferences?.collegeId !== collegeId) return false;
  const branchId = templateBranchId(template);
  if (branchId && actor?.preferences?.departmentId !== branchId) return false;
  return true;
}

export function canViewTemplate(actor, template) {
  if (!actor || !template) return false;
  const scope = templateScope(template);

  // Private templates are never visible to administrators or other users.
  if (scope === TEMPLATE_SCOPE_PRIVATE) return isTemplateOwner(actor, template);

  // Unknown ownership is intentionally restricted until a platform admin
  // explicitly claims and scopes the template.
  if (scope === TEMPLATE_SCOPE_LEGACY) return isPlatformAdmin(actor);

  if (isPlatformAdmin(actor)) return true;

  if (scope === TEMPLATE_SCOPE_PLATFORM) {
    return isPublishedTemplate(template);
  }

  if (scope === TEMPLATE_SCOPE_COLLEGE) {
    if (isCollegeAdminOf(actor, templateCollegeId(template))) return true;
    return isPublishedTemplate(template) && matchesActorCollege(actor, template);
  }

  return false;
}

// A template may be selected for a new assignment only when it is usable by
// this actor. Private owners may use their own draft/active versions; shared
// templates must be published. Archived templates are never selectable.
export function canUseTemplate(actor, template) {
  if (!canViewTemplate(actor, template)) return false;
  if (isArchivedTemplate(template)) return false;
  if (isPrivateTemplate(template)) return isTemplateOwner(actor, template);
  return isPublishedTemplate(template);
}

export function canManageTemplate(actor, template) {
  if (!actor || !template) return false;
  const scope = templateScope(template);

  // Private content stays with its owner, even for platform admins.
  if (scope === TEMPLATE_SCOPE_PRIVATE) return isTemplateOwner(actor, template);
  if (scope === TEMPLATE_SCOPE_LEGACY) return isPlatformAdmin(actor);
  if (scope === TEMPLATE_SCOPE_PLATFORM) return isPlatformAdmin(actor);
  if (scope === TEMPLATE_SCOPE_COLLEGE) {
    return isPlatformAdmin(actor) || isCollegeAdminOf(actor, templateCollegeId(template));
  }
  return false;
}

// Publishing a SHARED template is an administrator action. Ordinary users can
// never publish platform/college templates. Private owners may save their own
// private template, but that does not make it shared or a branch default.
export function canPublishTemplate(actor, template) {
  if (!actor || !template) return false;
  const scope = templateScope(template);
  if (scope === TEMPLATE_SCOPE_PRIVATE || scope === TEMPLATE_SCOPE_LEGACY) return false;
  if (scope === TEMPLATE_SCOPE_PLATFORM) return isPlatformAdmin(actor);
  if (scope === TEMPLATE_SCOPE_COLLEGE) {
    return isPlatformAdmin(actor) || isCollegeAdminOf(actor, templateCollegeId(template));
  }
  return false;
}

// Status changes are separate from content edits: publishing a shared template
// is an administrator action, while a private owner may activate their own
// private copy. Legacy templates must be claimed/scoped first.
export function canSetTemplateStatus(actor, template, nextStatus) {
  if (!actor || !template) return false;
  const scope = templateScope(template);
  if (scope === TEMPLATE_SCOPE_PRIVATE) return isTemplateOwner(actor, template);
  if (scope === TEMPLATE_SCOPE_LEGACY) return false;
  const publishing = nextStatus === "active" || nextStatus === "published";
  return publishing ? canPublishTemplate(actor, template) : canManageTemplate(actor, template);
}

export function canCreateTemplate(actor, scope, collegeId) {
  if (!actor) return false;
  if (scope === TEMPLATE_SCOPE_PRIVATE) return true;
  if (scope === TEMPLATE_SCOPE_PLATFORM) return isPlatformAdmin(actor);
  if (scope === TEMPLATE_SCOPE_COLLEGE) {
    return isPlatformAdmin(actor) || isCollegeAdminOf(actor, collegeId);
  }
  return false;
}

export function canManageCollege(actor) {
  return isPlatformAdmin(actor);
}

export function canManageBranch(actor, collegeId) {
  return isPlatformAdmin(actor) || isCollegeAdminOf(actor, collegeId);
}

export function canAssignCollegeAdmin(actor) {
  return isPlatformAdmin(actor);
}

export function canClaimLegacyTemplate(actor) {
  return isPlatformAdmin(actor);
}

export function canSetBranchDefault(actor, template, branch) {
  if (!actor || !template || !branch) return false;
  if (!canManageBranch(actor, branch.tenantId)) return false;
  if (isPrivateTemplate(template) || isLegacyTemplate(template)) return false;
  if (!isPublishedTemplate(template)) return false;

  const scope = templateScope(template);
  if (scope === TEMPLATE_SCOPE_PLATFORM) return true;
  if (scope !== TEMPLATE_SCOPE_COLLEGE) return false;
  if (templateCollegeId(template) !== branch.tenantId) return false;

  const templateBranch = templateBranchId(template);
  return !templateBranch || templateBranch === branch.id;
}

export function canViewBranchTemplate(actor, template, branch) {
  if (!actor || !template || !branch) return false;
  if (templateScope(template) === TEMPLATE_SCOPE_PRIVATE) return isTemplateOwner(actor, template);
  if (templateScope(template) === TEMPLATE_SCOPE_LEGACY) return isPlatformAdmin(actor);
  if (isPlatformAdmin(actor)) return true;
  if (templateCollegeId(template) !== branch.tenantId) return false;
  const templateBranch = templateBranchId(template);
  if (templateBranch && templateBranch !== branch.id) return false;
  if (isCollegeAdminOf(actor, branch.tenantId)) return true;
  // Ordinary users only see published templates from their own college/branch.
  return matchesActorCollege(actor, template) && isPublishedTemplate(template);
}

export function filterVisibleTemplates(actor, templates = []) {
  return templates.filter((template) => canViewTemplate(actor, template));
}

export function roleLabel(actor) {
  return normalizeRole(actor?.role);
}

export const __testing = {
  ROLE_PLATFORM_ADMIN,
};
