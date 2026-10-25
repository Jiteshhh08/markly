import { isCollegeAdminOf, isPlatformAdmin } from "./roles.js";
import {
  TEMPLATE_SCOPE_COLLEGE,
  canViewTemplate,
  templateBranchId,
  templateCollegeId,
  templateScope,
} from "./templateAccess.js";

// STAGE 2: server-side catalogue scope.
//
// Until the preferences UI exists, callers may pass an explicit, validated
// college/branch scope (`collegeId`/`departmentId`, with tenantId/branchId as
// aliases). Missing scope NEVER means "return every college": ordinary users
// without a scope/preference only see published platform templates.
//
// Authorization:
//   platform_admin - any explicit scope
//   college_admin  - colleges listed in collegeAdminOf
//   ordinary user  - persisted preferences OR college membership (tenantIds)
// Anonymous callers may not request a college scope.

export class CatalogueScopeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CatalogueScopeError";
    this.status = status;
  }
}

function cleanId(value, label) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || typeof value === "object") {
    throw new CatalogueScopeError(`${label} must be a single value.`);
  }
  const id = String(value).trim();
  if (!id) return null;
  if (id.length > 128) {
    throw new CatalogueScopeError(`${label} is too long.`);
  }
  return id;
}

export function parseCatalogueScope(query = {}) {
  const collegeId = cleanId(query.collegeId ?? query.tenantId, "collegeId");
  const departmentId = cleanId(
    query.departmentId ?? query.branchId,
    "departmentId",
  );
  if (departmentId && !collegeId) {
    throw new CatalogueScopeError(
      "collegeId is required when departmentId is provided.",
    );
  }
  return { collegeId, departmentId };
}

export function canUseCatalogueScope(actor, scope) {
  if (!scope?.collegeId) return true;
  if (!actor) return false;

  if (isPlatformAdmin(actor)) return true;
  if (isCollegeAdminOf(actor, scope.collegeId)) return true;

  // College membership authorizes the whole college, including sibling
  // branches. This is deliberately broader than a branch preference: a member
  // may browse the shared catalogue for any branch in their college.
  const memberships = Array.isArray(actor.tenantIds) ? actor.tenantIds : [];
  if (memberships.includes(scope.collegeId)) return true;

  const preferences = actor.preferences;
  if (preferences?.collegeId !== scope.collegeId) return false;

  if (scope.departmentId) {
    // A branch preference is branch-specific. A college-only preference has no
    // branch restriction and may browse any branch in that college.
    return (
      !preferences.departmentId ||
      preferences.departmentId === scope.departmentId
    );
  }

  // A branch preference must not be widened into whole-college access by
  // supplying only the college id; the member path above is the explicit
  // college-wide grant.
  return !preferences.departmentId;
}

function anonymousCatalogueActor() {
  return {
    id: null,
    email: "",
    name: "",
    role: "user",
    collegeAdminOf: [],
    tenantIds: [],
    preferences: null,
  };
}

function actorForExplicitScope(actor, template, scope) {
  if (!actor) return null;
  return {
    ...actor,
    preferences: {
      ...(actor.preferences ?? {}),
      collegeId: templateCollegeId(template) ?? scope.collegeId,
      departmentId: templateBranchId(template) ?? scope.departmentId ?? null,
      preferredTemplateId: actor.preferences?.preferredTemplateId ?? null,
    },
  };
}

function matchesExplicitScope(template, scope) {
  if (!scope?.collegeId) return true;
  if (templateScope(template) !== TEMPLATE_SCOPE_COLLEGE) return true;
  if (templateCollegeId(template) !== scope.collegeId) return false;
  if (!scope.departmentId) return true;
  const branch = templateBranchId(template);
  return !branch || branch === scope.departmentId;
}

/**
 * Visibility for a catalogue read. `explicit` is true when the request supplied
 * a college/branch scope; in that case the scope itself supplies the branch
 * context (a college member may browse the college catalogue), while the
 * template's published/draft state is still enforced by canViewTemplate.
 */
export function templateVisibleInCatalogue(
  actor,
  template,
  scope = {},
  { explicit = false } = {},
) {
  const baseActor = actor ?? anonymousCatalogueActor();
  const effectiveActor = explicit
    ? actorForExplicitScope(baseActor, template, scope)
    : baseActor;
  if (!canViewTemplate(effectiveActor, template)) return false;
  return matchesExplicitScope(template, scope);
}

export function filterCatalogue(
  actor,
  templates = [],
  scope = {},
  { explicit = false } = {},
) {
  return templates.filter((template) =>
    templateVisibleInCatalogue(actor, template, scope, { explicit }),
  );
}
