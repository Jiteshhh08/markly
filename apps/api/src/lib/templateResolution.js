import mongoose from "mongoose";
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

/**
 * Resolve the template for a NEW generation.
 *
 * - No templateId: the server selects a published shared default. This is the
 *   only place a default is allowed; an explicit id never falls back.
 * - Explicit templateId (+ optional version): resolve that exact version (or
 *   the latest version of that id), then enforce canUseTemplate for the actor.
 */
export async function resolveTemplateForGeneration({
  templateId,
  templateVersion,
  actor = null,
} = {}) {
  await ensureTemplatesLoaded();
  const effectiveActor = actor ?? anonymousActor();

  if (templateId) {
    const requestedVersion =
      templateVersion == null ? null : Number(templateVersion);
    if (
      requestedVersion != null &&
      (!Number.isInteger(requestedVersion) || requestedVersion < 1)
    ) {
      throw new TemplateResolutionError("The selected template version is invalid.", {
        status: 400,
        code: "template_version_invalid",
      });
    }

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
    return { template, snapshot: templateSnapshot(template) };
  }

  const template = await selectDefaultTemplateAuthoritative();
  if (!template) {
    throw new TemplateResolutionError(
      "No published template is available for generation.",
      { status: 503, code: "no_default_template" },
    );
  }
  return { template, snapshot: templateSnapshot(template) };
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
