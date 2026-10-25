import mongoose from "mongoose";
import { Department, Tenant } from "../models/index.js";
import { loadActor } from "./roles.js";
import { canUseTemplate, templateScope } from "./templateAccess.js";
import {
  ensureTemplatesLoaded,
  getTemplateVersionAuthoritative,
  selectDefaultTemplateAuthoritative,
} from "./templateStore.js";

// STAGE 2: exact template identity resolution.
//
// New generations pin a stable template id + explicit version. Saved
// assignments always resolve that exact immutable version for every export
// (HTML, DOCX, LaTeX, PDF). There is deliberately no fallback to the latest
// version, to a server default, or to another college when a saved version is
// missing: callers receive an explicit error instead.

export class TemplateResolutionError extends Error {
  constructor(message, { status = 404, code = "template_unavailable" } = {}) {
    super(message);
    this.name = "TemplateResolutionError";
    this.status = status;
    this.code = code;
  }
}

export function anonymousActor() {
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

/**
 * Resolve the persisted actor for a request. When MongoDB is not connected we
 * intentionally fall back to a claim-free ordinary actor: JWT role claims are
 * never trusted, but the stable `sub` still lets a user see their own private
 * templates in local/test mode. Database failures while connected propagate so
 * routes can fail closed with an explicit 503.
 */
export async function requestActor(req) {
  if (!req?.user?.sub) return null;
  if (mongoose.connection.readyState === 1) {
    return loadActor(req);
  }
  return {
    ...anonymousActor(),
    id: String(req.user.sub),
    email: String(req.user.email ?? "").toLowerCase().trim(),
  };
}

export function templateSnapshot(template) {
  if (!template?.id) {
    throw new TemplateResolutionError("The selected template is unavailable.");
  }
  const version = Number(template.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new TemplateResolutionError("The selected template version is invalid.", {
      status: 400,
      code: "template_version_invalid",
    });
  }
  return {
    id: String(template.id),
    version,
    name: template.name ?? null,
    scope: templateScope(template),
    tenantId: template.tenantId ?? template.collegeId ?? null,
    departmentId: template.departmentId ?? template.branchId ?? null,
  };
}

function requestedVersionOf(value) {
  if (value == null) return null;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new TemplateResolutionError("The selected template version is invalid.", {
      status: 400,
      code: "template_version_invalid",
    });
  }
  return version;
}

async function resolvePreferredTemplate(actor) {
  const preferredId = actor?.preferences?.preferredTemplateId;
  if (!preferredId) return { template: null, invalid: false };

  const rawVersion = actor.preferences.preferredTemplateVersion;
  const preferredVersion = rawVersion == null ? null : Number(rawVersion);
  if (
    preferredVersion != null &&
    (!Number.isInteger(preferredVersion) || preferredVersion < 1)
  ) {
    return { template: null, invalid: true };
  }

  const template = await getTemplateVersionAuthoritative(preferredId, preferredVersion);
  if (template && canUseTemplate(actor, template)) {
    return { template, invalid: false };
  }
  // A saved preference can become stale when an administrator archives or
  // removes a version. It is skipped (not silently substituted) so resolution
  // can continue to the branch's configured default.
  return { template: null, invalid: true };
}

async function resolveBranchDefaultTemplate(actor) {
  const collegeId = actor?.preferences?.collegeId;
  const branchId = actor?.preferences?.departmentId;
  if (!collegeId || !branchId) return { template: null, reason: "missing" };

  const college = await Tenant.findOne({ id: collegeId }).lean();
  if (!college || college.status === "inactive") {
    return { template: null, reason: "branch_unavailable" };
  }
  const branch = await Department.findOne({ id: branchId, tenantId: collegeId }).lean();
  if (!branch || branch.status === "inactive") {
    return { template: null, reason: "branch_unavailable" };
  }

  const version = Number(branch.defaultTemplateVersion);
  if (!branch.defaultTemplateId || !Number.isInteger(version) || version < 1) {
    return { template: null, reason: "no_default" };
  }

  const template = await getTemplateVersionAuthoritative(
    branch.defaultTemplateId,
    version,
  );
  if (!template || !canUseTemplate(actor, template)) {
    return { template: null, reason: "default_unavailable" };
  }
  return { template, reason: null };
}

/**
 * Resolve the template for a NEW generation.
 *
 * Resolution order (STAGE 4):
 *   1. an explicit, eligible templateId (+ optional exact version)
 *   2. the user's saved preferred template, while it is still usable
 *   3. the saved branch's exact configured default id + version
 *   4. an actionable error
 *
 * An explicit id NEVER falls back: choosing another college's template, a
 * private template owned by someone else, or an archived version is an error.
 * A stale saved preference is skipped in favour of the branch default, but a
 * branch default is always resolved at its pinned version, never "latest".
 *
 * Anonymous and memory-only callers retain the pre-Stage-4 global default:
 * there is no persisted user whose college/branch could be consulted. A
 * MongoDB-backed authenticated user without saved preferences gets a clear
 * setup error instead of a silent global template.
 */
export async function resolveTemplateForGeneration({
  templateId,
  templateVersion,
  actor = null,
} = {}) {
  await ensureTemplatesLoaded();
  const effectiveActor = actor ?? anonymousActor();

  if (templateId) {
    const requestedVersion = requestedVersionOf(templateVersion);
    const template =
      requestedVersion == null
        ? await getTemplateVersionAuthoritative(templateId)
        : await getTemplateVersionAuthoritative(templateId, requestedVersion);
    if (!template || !canUseTemplate(effectiveActor, template)) {
      // Do not reveal whether a template exists in another college or belongs
      // to another user: both cases are the same safe not-found response.
      throw new TemplateResolutionError("The selected template is unavailable.", {
        status: 404,
      });
    }
    return {
      template,
      snapshot: templateSnapshot(template),
      source: "explicit",
    };
  }

  const mongoBacked = mongoose.connection.readyState === 1;
  if (!mongoBacked || !effectiveActor?.id) {
    const template = await selectDefaultTemplateAuthoritative();
    if (!template) {
      throw new TemplateResolutionError(
        "No published template is available for generation.",
        { status: 503, code: "no_default_template" },
      );
    }
    return {
      template,
      snapshot: templateSnapshot(template),
      source: "global_default",
    };
  }

  const preferred = await resolvePreferredTemplate(effectiveActor);
  if (preferred.template) {
    return {
      template: preferred.template,
      snapshot: templateSnapshot(preferred.template),
      source: "preference",
    };
  }

  const branchDefault = await resolveBranchDefaultTemplate(effectiveActor);
  if (branchDefault.template) {
    return {
      template: branchDefault.template,
      snapshot: templateSnapshot(branchDefault.template),
      source: "branch_default",
    };
  }

  const preferences = effectiveActor.preferences;
  if (!preferences?.collegeId && !preferences?.departmentId) {
    throw new TemplateResolutionError(
      "Choose your college and branch in Preferences before generating an assignment.",
      { status: 409, code: "preferences_required" },
    );
  }

  if (!preferences?.collegeId || !preferences?.departmentId) {
    if (preferred.invalid) {
      throw new TemplateResolutionError(
        "Your saved preferred template is no longer available. Choose another template in Preferences.",
        { status: 409, code: "preferred_template_unavailable" },
      );
    }
    throw new TemplateResolutionError(
      "Choose a template before generating, or complete your college and branch setup in Preferences.",
      { status: 409, code: "preferences_incomplete" },
    );
  }

  if (branchDefault.reason === "branch_unavailable") {
    throw new TemplateResolutionError(
      "Your saved college or branch is no longer available. Update your preferences before generating.",
      { status: 409, code: "branch_unavailable" },
    );
  }

  if (preferred.invalid) {
    throw new TemplateResolutionError(
      "Your saved preferred template is no longer available. Choose another template in Preferences.",
      { status: 409, code: "preferred_template_unavailable" },
    );
  }

  if (branchDefault.reason === "default_unavailable") {
    throw new TemplateResolutionError(
      "Your branch's default template is no longer available. Choose another template in Preferences.",
      { status: 409, code: "branch_default_template_unavailable" },
    );
  }

  throw new TemplateResolutionError(
    "Your branch does not have a default template yet. Choose a template or ask your college admin to set one.",
    { status: 409, code: "branch_default_template_missing" },
  );
}

/**
 * Resolve a template snapshot pinned when a background job was enqueued.
 * The version is immutable, so a later edit cannot change the job's output.
 */
export async function resolvePinnedTemplate(snapshot) {
  await ensureTemplatesLoaded();
  const id = snapshot?.id;
  const version = Number(snapshot?.version);
  if (!id || !Number.isInteger(version) || version < 1) {
    throw new TemplateResolutionError(
      "The generation template version is unavailable.",
      { status: 409, code: "generation_template_version_unavailable" },
    );
  }
  const template = await getTemplateVersionAuthoritative(id, version);
  if (!template) {
    throw new TemplateResolutionError(
      "The generation template version is unavailable.",
      { status: 409, code: "generation_template_version_unavailable" },
    );
  }
  return { template, snapshot: templateSnapshot(template) };
}

/**
 * Resolve the exact template version stored on an assignment record.
 * Missing identity/version or a deleted historical version is an explicit
 * error; exports must never silently render with a newer/default template.
 */
export async function resolveAssignmentTemplate(record) {
  await ensureTemplatesLoaded();
  const source = record?.template;
  const id = source?.id;
  const version = Number(source?.version);
  if (!id || !Number.isInteger(version) || version < 1) {
    throw new TemplateResolutionError(
      "This assignment does not record a template version, so it cannot be rendered.",
      { status: 409, code: "assignment_template_version_missing" },
    );
  }
  const template = await getTemplateVersionAuthoritative(id, version);
  if (!template) {
    throw new TemplateResolutionError(
      "The template version used by this assignment is no longer available.",
      { status: 409, code: "assignment_template_version_unavailable" },
    );
  }
  return { template, doc: { template } };
}
