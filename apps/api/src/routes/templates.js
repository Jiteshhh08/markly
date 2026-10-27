import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { Department, Tenant } from "../models/index.js";
import {
  TemplateConflictError,
  TemplatePersistenceError,
  createTemplatePersisted,
  ensureTemplatesLoaded,
  getTemplateVersionAuthoritative,
  listTemplateRecordsAuthoritative,
  listTemplateVersionsAuthoritative,
  updateTemplatePersisted,
} from "../lib/templateStore.js";
import { sendError } from "../lib/errors.js";
import {
  TEMPLATE_SCOPES,
  TEMPLATE_SCOPE_COLLEGE,
  TEMPLATE_SCOPE_LEGACY,
  TEMPLATE_SCOPE_PLATFORM,
  TEMPLATE_SCOPE_PRIVATE,
  canCreateTemplate,
  canManageTemplate,
  canSetTemplateStatus,
  templateScope,
} from "../lib/templateAccess.js";
import {
  CatalogueScopeError,
  canUseCatalogueScope,
  parseCatalogueScope,
  templateVisibleInCatalogue,
} from "../lib/templateCatalogue.js";
import { requestActor } from "../lib/templateResolution.js";
import {
  isBootstrapEligibleActor,
  loadBootstrapDefault,
} from "../lib/bootstrapDefault.js";
import {
  TemplateValidationError,
  assertTemplateStatusTransition,
  pickTemplateRuntimeFields,
  safeTemplateName,
  validateTemplateFields,
} from "../lib/templateValidation.js";
import { recordAudit, safeAuditMetadata } from "../lib/audit.js";
import { MAX_PDF_BYTES, UploadValidationError, validatePdfUpload } from "../lib/uploadSafety.js";
import { renderHtml } from "../render/html.js";

export const templatesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
});

const TEMPLATE_AUDIT_FIELDS = [
  "id",
  "version",
  "name",
  "status",
  "scope",
  "tenantId",
  "departmentId",
];

function aiBase() {
  return (process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8001").replace(/\/$/, "");
}

function summary(t, updatedAt = null) {
  return {
    id: t.id,
    version: t.version,
    name: t.name,
    status: t.status,
    scope: templateScope(t),
    tenantId: t.tenantId ?? null,
    departmentId: t.departmentId ?? null,
    ownerUserId: t.ownerUserId ?? null,
    updatedAt: updatedAt ?? t.updatedAt ?? null,
  };
}

function bootstrapSummary(found) {
  return {
    id: found.template.id,
    version: found.template.version,
    name: found.template.name ?? "",
    collegeId: found.college.id,
    collegeName: found.college.name ?? "",
    branchId: found.branch.id,
    branchName: found.branch.name ?? "",
  };
}

function auditTemplate(t) {
  const out = {};
  for (const field of TEMPLATE_AUDIT_FIELDS) out[field] = t?.[field] ?? null;
  return out;
}

function isPrivateOwner(req, t) {
  return Boolean(req.user?.sub && t?.ownerUserId && String(req.user.sub) === String(t.ownerUserId));
}

async function ensureStore(res) {
  try {
    await ensureTemplatesLoaded();
    return true;
  } catch (err) {
    sendError(res, 503, "Template storage is unavailable. Please try again.", err);
    return false;
  }
}

async function persistedActor(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Authorization is temporarily unavailable" });
    return null;
  }
  try {
    const actor = await requestActor(req);
    if (!actor) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return actor;
  } catch (err) {
    console.error("[templates] failed to load persisted actor:", String(err).slice(0, 300));
    res.status(503).json({ error: "Authorization is temporarily unavailable" });
    return null;
  }
}

async function catalogueContext(req, res) {
  let actor;
  try {
    actor = await requestActor(req);
  } catch (err) {
    sendError(res, 503, "Authorization is temporarily unavailable", err);
    return null;
  }

  let scope;
  try {
    scope = parseCatalogueScope(req.query ?? {});
  } catch (err) {
    if (err instanceof CatalogueScopeError) {
      sendError(res, err.status, err.message);
      return null;
    }
    sendError(res, 400, "Invalid catalogue scope", err);
    return null;
  }

  const explicit = Boolean(scope.collegeId);
  if (explicit && !canUseCatalogueScope(actor, scope)) {
    res.status(403).json({ error: "You do not have permission to view this catalogue scope" });
    return null;
  }
  // Authorization always precedes existence validation, so an unauthorized
  // caller cannot probe which colleges/departments exist.
  if (
    explicit &&
    !(await validateScopeFields(
      { tenantId: scope.collegeId, departmentId: scope.departmentId },
      res,
    ))
  ) {
    return null;
  }
  return { actor, scope, explicit };
}

function cleanScopeId(value, label) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || typeof value === "object") {
    throw new CatalogueScopeError(`${label} must be a single string value.`);
  }
  const id = String(value).trim();
  if (!id) return null;
  if (id.length > 128) throw new CatalogueScopeError(`${label} is too long.`);
  return id;
}

// Shape validation for explicit college/branch scope. This deliberately does
// NOT touch the database: authorization must run first so an ordinary user
// always receives 403, never a 400 that leaks whether a college exists.
function parseScopeFields(res, body) {
  let tenantId;
  let departmentId;
  try {
    tenantId = cleanScopeId(body?.tenantId ?? body?.collegeId, "tenantId");
    departmentId = cleanScopeId(body?.departmentId ?? body?.branchId, "departmentId");
  } catch (err) {
    sendError(res, err.status ?? 400, err.message);
    return null;
  }

  if (departmentId && !tenantId) {
    sendError(res, 400, "tenantId is required when departmentId is provided.");
    return null;
  }

  return { tenantId, departmentId };
}

// Existence validation runs only AFTER the caller has been authorized. When
// MongoDB is connected the referenced college/department must exist and the
// department must belong to that college.
async function validateScopeFields(scopeFields, res) {
  if (mongoose.connection.readyState !== 1 || !scopeFields?.tenantId) return true;
  try {
    const tenant = await Tenant.findOne({ id: scopeFields.tenantId }).lean();
    if (!tenant) {
      sendError(res, 400, "Unknown college for this template scope.");
      return false;
    }
    if (scopeFields.departmentId) {
      const department = await Department.findOne({ id: scopeFields.departmentId }).lean();
      if (!department) {
        sendError(res, 400, "Unknown department for this template scope.");
        return false;
      }
      if (String(department.tenantId) !== scopeFields.tenantId) {
        sendError(res, 400, "The department does not belong to the selected college.");
        return false;
      }
    }
  } catch (err) {
    sendError(res, 503, "Template scope validation is unavailable. Please try again.", err);
    return false;
  }
  return true;
}

// Resolve the ownership for a newly created template. Shared/platform creation
// is an administrator action backed by the persisted user; unauthenticated
// open-dev creations stay in the explicit legacy bucket. The default for a
// signed-in ordinary user is a private template owned by that user.
async function createScope(req, res, body) {
  const requested = body?.scope;
  if (requested !== undefined && !TEMPLATE_SCOPES.includes(requested)) {
    res.status(400).json({ error: `Invalid template scope (one of ${TEMPLATE_SCOPES.join(", ")})` });
    return null;
  }
  if (requested === TEMPLATE_SCOPE_LEGACY) {
    res.status(403).json({ error: "Legacy templates are created only by migration review" });
    return null;
  }

  const scopeFields = parseScopeFields(res, body);
  if (!scopeFields) return null;

  if (requested === TEMPLATE_SCOPE_PLATFORM) {
    if (scopeFields.tenantId || scopeFields.departmentId) {
      res.status(400).json({ error: "Platform templates cannot be scoped to a college or department" });
      return null;
    }
    const actor = await persistedActor(req, res);
    if (!actor) return null;
    if (!canCreateTemplate(actor, TEMPLATE_SCOPE_PLATFORM)) {
      res.status(403).json({ error: "You do not have permission to create this template" });
      return null;
    }
    if (!(await validateScopeFields(scopeFields, res))) return null;
    return {
      scope: TEMPLATE_SCOPE_PLATFORM,
      ownerUserId: actor.id,
      tenantId: null,
      departmentId: null,
    };
  }

  if (requested === TEMPLATE_SCOPE_COLLEGE) {
    if (!scopeFields.tenantId) {
      res.status(400).json({ error: "tenantId is required for college templates" });
      return null;
    }
    const actor = await persistedActor(req, res);
    if (!actor) return null;
    if (!canCreateTemplate(actor, TEMPLATE_SCOPE_COLLEGE, scopeFields.tenantId)) {
      res.status(403).json({ error: "You do not have permission to create this template" });
      return null;
    }
    if (!(await validateScopeFields(scopeFields, res))) return null;
    return {
      scope: TEMPLATE_SCOPE_COLLEGE,
      ownerUserId: actor.id,
      ...scopeFields,
    };
  }

  if (requested === TEMPLATE_SCOPE_PRIVATE) {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    if (!(await validateScopeFields(scopeFields, res))) return null;
    return {
      scope: TEMPLATE_SCOPE_PRIVATE,
      ownerUserId: req.user.sub,
      ...scopeFields,
    };
  }

  if (req.user) {
    if (!(await validateScopeFields(scopeFields, res))) return null;
    return {
      scope: TEMPLATE_SCOPE_PRIVATE,
      ownerUserId: req.user.sub,
      ...scopeFields,
    };
  }
  if (!(await validateScopeFields(scopeFields, res))) return null;
  return {
    scope: TEMPLATE_SCOPE_LEGACY,
    ownerUserId: null,
    ...scopeFields,
  };
}

function validateRuntimeFields(fields, res, { requireName = false } = {}) {
  try {
    return validateTemplateFields(fields, { requireName });
  } catch (err) {
    if (err instanceof TemplateValidationError) {
      res.status(400).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

function sendTemplateError(res, err, fallback) {
  if (err instanceof TemplateConflictError || err?.status === 409) {
    return res.status(409).json({ error: err.message });
  }
  if (err instanceof TemplatePersistenceError || err?.status === 503) {
    return sendError(res, 503, "Template storage is unavailable. Please try again.", err);
  }
  return sendError(res, 500, fallback, err);
}

async function auditTemplateAction(req, res, action, template, before = null) {
  try {
    await recordAudit({
      actor: req.actor ?? {
        id: req.user?.sub,
        email: req.user?.email ?? "",
      },
      action,
      entityType: "template",
      entityId: template.id,
      collegeId: template.tenantId ?? null,
      metadata: before
        ? { before: safeAuditMetadata(before), after: safeAuditMetadata(auditTemplate(template)) }
        : { after: safeAuditMetadata(auditTemplate(template)) },
    });
    return true;
  } catch (err) {
    console.error("[templates] audit persistence failed:", String(err).slice(0, 500));
    res.status(500).json({
      error:
        "The change was saved, but its audit record could not be written. Please contact an administrator.",
    });
    return false;
  }
}

async function clearArchivedDefaults(template, req) {
  const branches = await Department.find({ defaultTemplateId: template.id }).lean();
  for (const branch of branches) {
    await Department.updateOne(
      { id: branch.id },
      { $set: { defaultTemplateId: null, defaultTemplateVersion: null } },
    );
    await recordAudit({
      actor: req.actor ?? { id: req.user?.sub, email: req.user?.email ?? "" },
      action: "branch.default_template.clear",
      entityType: "branch",
      entityId: branch.id,
      collegeId: branch.tenantId,
      metadata: {
        reason: "template archived",
        before: {
          defaultTemplateId: branch.defaultTemplateId,
          defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
        },
        after: { defaultTemplateId: null, defaultTemplateVersion: null },
      },
    });
  }
}

function sampleContent() {
  return {
    title: "Template Preview",
    experimentNumber: 1,
    aim: "Preview the selected template without generating an assignment.",
    objectives: ["Review the page frame, header, typography and required sections."],
    theory: ["This is representative body text. The real document uses generated assignment content."],
    steps: [
      {
        number: 1,
        title: "Review the format",
        description: ["Check the header, footer, watermark, margins and page border."],
        code: "SELECT * FROM students;",
        language: "sql",
      },
    ],
    conclusion: "Save a draft, preview again, then publish a new immutable version when ready.",
    metadata: {},
  };
}

async function loadManagedTemplate(req, res, { requirePublisher = false } = {}) {
  const actor = await persistedActor(req, res);
  if (!actor) return null;
  const template = await getTemplateVersionAuthoritative(req.params.id);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return null;
  }
  if (requirePublisher) {
    if (!canSetTemplateStatus(actor, template, "published")) {
      res.status(403).json({ error: "You do not have permission to publish this template" });
      return null;
    }
  } else if (!canManageTemplate(actor, template)) {
    res.status(403).json({ error: "You do not have permission to manage this template" });
    return null;
  }
  return { actor, template };
}

// Phase 8/STAGE 2: list the latest version of each visible template.
// STAGE 3 adds explicit status/scope filters for the admin catalogue. All
// reads use authoritative MongoDB records so another API instance's newly
// published version is visible immediately.
templatesRouter.get("/", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const context = await catalogueContext(req, res);
  if (!context) return;

  const statusFilter = req.query.status;
  if (
    statusFilter !== undefined &&
    !["draft", "active", "published", "archived"].includes(String(statusFilter))
  ) {
    return res.status(400).json({ error: "Invalid template status filter" });
  }
  const scopeFilter = req.query.scope;
  if (scopeFilter !== undefined && !TEMPLATE_SCOPES.includes(String(scopeFilter))) {
    return res.status(400).json({ error: "Invalid template scope filter" });
  }

  try {
    const records = await listTemplateRecordsAuthoritative();
    const templates = records
      .filter(({ template }) =>
        templateVisibleInCatalogue(context.actor, template, context.scope, {
          explicit: context.explicit,
        }),
      )
      .filter(({ template }) => {
        if (scopeFilter !== undefined && templateScope(template) !== scopeFilter) return false;
        if (statusFilter === undefined) return true;
        if (statusFilter === "published") {
          return template.status === "active" || template.status === "published";
        }
        if (statusFilter === "active") {
          return template.status === "active" || template.status === "published";
        }
        return template.status === statusFilter;
      })
      .map(({ template, updatedAt, createdAt }) => summary(template, updatedAt ?? createdAt));

    // Onboarding fallback: an ordinary user with no college/branch preference
    // and no college membership gets the seeded TCET Computer Engineering
    // template marked as the current default. Explicit scopes and configured
    // users keep normal college/branch isolation.
    let bootstrapDefault = null;
    if (!context.explicit && isBootstrapEligibleActor(context.actor)) {
      const found = await loadBootstrapDefault();
      if (found) {
        bootstrapDefault = bootstrapSummary(found);
        const key = `${found.template.id}@${found.template.version}`;
        const existing = templates.find((template) => `${template.id}@${template.version}` === key);
        if (existing) {
          existing.isBootstrapDefault = true;
        } else if (
          (scopeFilter === undefined || scopeFilter === "college") &&
          (statusFilter === undefined || statusFilter === "published" || statusFilter === "active")
        ) {
          templates.unshift({ ...summary(found.template), isBootstrapDefault: true });
        }
      }
    }

    return res.json({ templates, bootstrapDefault });
  } catch (err) {
    return sendError(res, 503, "Templates are temporarily unavailable. Please try again.", err);
  }
});

// Version history is a management view: private history is owner-only, shared
// history follows the same college/platform management boundary as editing.
templatesRouter.get("/:id/versions", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const actor = await persistedActor(req, res);
  if (!actor) return undefined;
  try {
    const latest = await getTemplateVersionAuthoritative(req.params.id);
    if (!latest) return res.status(404).json({ error: "Template not found" });
    if (!canManageTemplate(actor, latest)) {
      return res.status(403).json({ error: "You do not have permission to view this template's history" });
    }
    const records = await listTemplateVersionsAuthoritative(req.params.id);
    return res.json({
      versions: records.map(({ template, createdAt, updatedAt }) => ({
        id: template.id,
        version: template.version,
        name: template.name,
        status: template.status,
        scope: templateScope(template),
        createdBy: template.createdBy ?? null,
        publishedAt: template.publishedAt ?? null,
        archivedAt: template.archivedAt ?? null,
        createdAt,
        updatedAt,
      })),
    });
  } catch (err) {
    return sendError(res, 503, "Template history is temporarily unavailable. Please try again.", err);
  }
});

function renderPreview(template) {
  return renderHtml(sampleContent(), { template }, { includeVivaTitle: true, typedConclusion: true });
}

templatesRouter.get("/:id/preview", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const managed = await loadManagedTemplate(req, res);
  if (!managed) return undefined;
  let version = null;
  if (req.query.version !== undefined) {
    version = Number(req.query.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ error: "version must be a positive integer" });
    }
  }
  try {
    const template = version == null
      ? managed.template
      : await getTemplateVersionAuthoritative(req.params.id, version);
    if (!template) return res.status(404).json({ error: "Template version not found" });
    return res.json({ html: renderPreview(template) });
  } catch (err) {
    return sendError(res, 503, "Template preview is temporarily unavailable. Please try again.", err);
  }
});

// Unsaved preview: validates the same configuration rules as save/publish and
// never writes a version. This is what the editor calls before committing.
templatesRouter.post("/:id/preview", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const managed = await loadManagedTemplate(req, res);
  if (!managed) return undefined;
  const patch = validateRuntimeFields(pickTemplateRuntimeFields(req.body ?? {}), res);
  if (patch === null) return undefined;
  try {
    const merged = { ...managed.template, ...patch, id: managed.template.id, version: managed.template.version };
    const template = validateRuntimeFields(merged, res);
    if (template === null) return undefined;
    return res.json({ html: renderPreview({ ...managed.template, ...template }) });
  } catch (err) {
    return sendError(res, 503, "Template preview is temporarily unavailable. Please try again.", err);
  }
});

// Phase 8: get a version (?version=N, default latest). Old versions stay readable forever.
templatesRouter.get("/:id", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const context = await catalogueContext(req, res);
  if (!context) return;

  let version = null;
  if (req.query.version !== undefined) {
    version = Number(req.query.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ error: "version must be a positive integer" });
    }
  }

  try {
    const template = await getTemplateVersionAuthoritative(req.params.id, version);
    if (
      !template ||
      !templateVisibleInCatalogue(context.actor, template, context.scope, {
        explicit: context.explicit,
      })
    ) {
      return res.status(404).json({ error: "Template not found" });
    }
    return res.json({ template });
  } catch (err) {
    return sendError(res, 503, "Template storage is unavailable. Please try again.", err);
  }
});

// Phase 8/STAGE 2: create (always starts at v1 draft by default). The response
// is returned only after the version is durably persisted (or after an explicit
// degraded-mode decision outside production).
templatesRouter.post("/", async (req, res) => {
  if (!(await ensureStore(res))) return;

  const body = req.body ?? {};
  const fields = validateRuntimeFields(pickTemplateRuntimeFields(body), res, { requireName: true });
  if (fields === null) return undefined;

  const ownership = await createScope(req, res, body);
  if (!ownership) return;

  try {
    const template = await createTemplatePersisted({
      ...fields,
      ...ownership,
      createdBy: req.user?.sub ?? null,
    });
    if (!(await auditTemplateAction(req, res, "template.create", template))) return undefined;
    return res.status(201).json({ template });
  } catch (err) {
    return sendTemplateError(res, err, "Couldn't create the template. Please try again.");
  }
});

async function updateTemplateFromRequest(req, res, { forceStatus = null, action = null } = {}) {
  if (!(await ensureStore(res))) return undefined;

  let current;
  try {
    current = await getTemplateVersionAuthoritative(req.params.id);
  } catch (err) {
    return sendError(res, 503, "Template storage is unavailable. Please try again.", err);
  }
  if (!current) return res.status(404).json({ error: "Template not found" });

  const scope = templateScope(current);
  let actor = null;
  if (scope === TEMPLATE_SCOPE_PRIVATE) {
    if (!isPrivateOwner(req, current)) {
      return res.status(403).json({ error: "You do not have permission to edit this template" });
    }
  } else {
    actor = await persistedActor(req, res);
    if (!actor) return undefined;
    if (!canManageTemplate(actor, current)) {
      return res.status(403).json({ error: "You do not have permission to edit this template" });
    }
    req.actor = actor;
  }

  const rawPatch = pickTemplateRuntimeFields(req.body ?? {});
  const patch = validateRuntimeFields(rawPatch, res);
  if (patch === null) return undefined;
  if (forceStatus) patch.status = forceStatus;

  if (patch.status !== undefined && patch.status !== current.status) {
    try {
      assertTemplateStatusTransition(current.status, patch.status);
    } catch (err) {
      if (err instanceof TemplateValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const statusActor =
      scope === TEMPLATE_SCOPE_PRIVATE
        ? {
            id: req.user?.sub,
            role: "user",
            collegeAdminOf: [],
            tenantIds: [],
            preferences: null,
          }
        : actor;
    if (!statusActor || !canSetTemplateStatus(statusActor, current, patch.status)) {
      return res.status(403).json({ error: "You do not have permission to change this template's status" });
    }
  }

  if (patch.status === "active" || patch.status === "published") patch.publishedAt = new Date();
  if (patch.status === "archived") patch.archivedAt = new Date();
  if (patch.status === "draft") {
    patch.publishedAt = null;
    patch.archivedAt = null;
  }

  try {
    const template = await updateTemplatePersisted(req.params.id, patch);
    if (!template) return res.status(404).json({ error: "Template not found" });
    const auditAction =
      action ??
      (patch.status === "archived"
        ? "template.archive"
        : patch.status === "active" || patch.status === "published"
          ? "template.publish"
          : "template.update");
    if (!(await auditTemplateAction(req, res, auditAction, template, auditTemplate(current)))) {
      return undefined;
    }
    if (template.status === "archived") {
      try {
        await clearArchivedDefaults(template, req);
      } catch (err) {
        console.error("[templates] failed to clear branch defaults:", String(err).slice(0, 500));
        return res.status(500).json({
          error:
            "The template was archived, but dependent branch defaults could not be cleared. Please review branch settings.",
        });
      }
    }
    return res.json({ template });
  } catch (err) {
    return sendTemplateError(res, err, "Couldn't update the template. Please try again.");
  }
}

// Phase 8/STAGE 2: update forks a NEW immutable version (never mutates history).
templatesRouter.put("/:id", async (req, res) => updateTemplateFromRequest(req, res));

templatesRouter.post("/:id/publish", async (req, res) =>
  updateTemplateFromRequest(req, res, { forceStatus: "published", action: "template.publish" }),
);

templatesRouter.post("/:id/archive", async (req, res) =>
  updateTemplateFromRequest(req, res, { forceStatus: "archived", action: "template.archive" }),
);

// Phase 8: upload a sample PDF -> structure draft -> saved as v1 draft for review.
// STAGE 3: the upload is signature-checked and bounded; extraction never
// publishes, and the request is audited only after the draft is durable.
templatesRouter.post("/from-pdf", upload.single("file"), async (req, res) => {
  try {
    validatePdfUpload(req.file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  if (!(await ensureStore(res))) return undefined;

  const ownership = await createScope(req, res, req.body ?? {});
  if (!ownership) return undefined;

  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: "application/pdf" }), req.file.originalname);
    const response = await fetch(`${aiBase()}/v1/analyze-template`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const draft = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[api] analyze-template failed:", response.status, JSON.stringify(draft).slice(0, 500));
      return res.status(response.status).json({ error: "Template extraction failed" });
    }

    const rawFields = pickTemplateRuntimeFields(req.body ?? {});
    // Import is a draft workflow. A caller can never skip review by supplying
    // status=active/published in the multipart form.
    rawFields.status = "draft";
    const fields = validateRuntimeFields(rawFields, res);
    if (fields === null) return undefined;
    const name = safeTemplateName(req.body?.name ?? draft.suggestedName, "Imported template");
    const candidateSections = Array.isArray(draft.requiredSections)
      ? draft.requiredSections
      : fields.requiredSections;
    let requiredSections = fields.requiredSections;
    if (candidateSections !== undefined) {
      try {
        requiredSections = validateTemplateFields(
          { requiredSections: candidateSections },
          {},
        ).requiredSections;
      } catch {
        // Extraction is advisory. An invalid suggestion falls back to the
        // validated form value/default rather than blocking the draft.
        requiredSections = fields.requiredSections;
      }
    }

    const template = await createTemplatePersisted({
      ...fields,
      name,
      ...(requiredSections !== undefined ? { requiredSections } : {}),
      status: "draft",
      ...ownership,
      createdBy: req.user?.sub ?? null,
    });
    if (!(await auditTemplateAction(req, res, "template.import", template))) return undefined;
    return res.status(201).json({
      template,
      analysis: {
        suggestedName: draft.suggestedName ?? null,
        detectedHeadings: Array.isArray(draft.detectedHeadings) ? draft.detectedHeadings.slice(0, 20) : [],
        requiredSections: requiredSections ?? [],
        chars: Number(draft.chars ?? 0),
      },
    });
  } catch (err) {
    if (err instanceof TemplateConflictError || err instanceof TemplatePersistenceError) {
      return sendTemplateError(res, err, "Couldn't create the template. Please try again.");
    }
    return sendError(res, 502, "Template extraction failed", String(err).slice(0, 500));
  }
});

// Multer errors (oversized/malformed multipart) are client errors, not 500s.
templatesRouter.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: "The uploaded file is too large or malformed" });
  }
  if (err instanceof UploadValidationError) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});
