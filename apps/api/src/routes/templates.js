import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { Department, Tenant } from "../models/index.js";
import {
  TemplateConflictError,
  TemplatePersistenceError,
  createTemplatePersisted,
  ensureTemplatesLoaded,
  getTemplateVersion,
  listTemplates,
  updateTemplatePersisted,
} from "../lib/templateStore.js";
import { sendError } from "../lib/errors.js";
import {
  TEMPLATE_SCOPES,
  TEMPLATE_SCOPE_COLLEGE,
  TEMPLATE_SCOPE_LEGACY,
  TEMPLATE_SCOPE_PLATFORM,
  TEMPLATE_SCOPE_PRIVATE,
  TEMPLATE_STATUSES,
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

export const templatesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Only .pdf uploads are accepted"));
    }
  },
});

const RUNTIME_FIELDS = new Set([
  "name",
  "status",
  "page",
  "pageSettings",
  "typography",
  "requiredSections",
  "studentMetadataFields",
  "assets",
  "watermark",
  "header",
  "footer",
  "headerFooter",
  "facultyTable",
  "layoutPolicy",
  "metadata",
  "description",
]);

function aiBase() {
  return (process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8001").replace(/\/$/, "");
}

function summary(t) {
  return {
    id: t.id,
    version: t.version,
    name: t.name,
    status: t.status,
    scope: templateScope(t),
    tenantId: t.tenantId,
    departmentId: t.departmentId,
  };
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
  if (Array.isArray(value) || typeof value !== "string") {
    throw new CatalogueScopeError(`${label} must be a single string value.`);
  }
  const id = value.trim();
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

function pickRuntimeFields(body) {
  const out = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (RUNTIME_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

function validateRuntimeFields(fields, res, { requireName = false } = {}) {
  if (fields.name !== undefined) {
    if (typeof fields.name !== "string" || fields.name.trim().length < 3) {
      res.status(400).json({ error: "Template name (min 3 chars) is required" });
      return false;
    }
    fields.name = fields.name.trim();
  } else if (requireName) {
    res.status(400).json({ error: "Template name (min 3 chars) is required" });
    return false;
  }

  if (fields.status !== undefined && !TEMPLATE_STATUSES.includes(fields.status)) {
    res.status(400).json({ error: `Invalid template status (one of ${TEMPLATE_STATUSES.join(", ")})` });
    return false;
  }

  for (const key of ["requiredSections", "studentMetadataFields"]) {
    if (fields[key] === undefined) continue;
    if (!Array.isArray(fields[key]) || !fields[key].every((value) => typeof value === "string")) {
      res.status(400).json({ error: `${key} must be an array of strings` });
      return false;
    }
  }

  return true;
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

// Phase 8/STAGE 2: list the latest version of each visible template.
// Visibility is evaluated server-side with the persisted actor, an optional
// explicit college/branch scope, and the Stage 1 access helpers. Drafts are
// hidden from ordinary users; private templates are owner-only; legacy
// templates are platform-admin review material.
templatesRouter.get("/", async (req, res) => {
  if (!(await ensureStore(res))) return;
  const context = await catalogueContext(req, res);
  if (!context) return;

  const templates = listTemplates()
    .filter((template) =>
      templateVisibleInCatalogue(context.actor, template, context.scope, {
        explicit: context.explicit,
      }),
    )
    .map(summary);
  return res.json({ templates });
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

  const template = getTemplateVersion(req.params.id, version);
  if (
    !template ||
    !templateVisibleInCatalogue(context.actor, template, context.scope, {
      explicit: context.explicit,
    })
  ) {
    return res.status(404).json({ error: "Template not found" });
  }
  return res.json({ template });
});

// Phase 8/STAGE 2: create (always starts at v1 draft by default). The response
// is returned only after the version is durably persisted (or after an explicit
// degraded-mode decision outside production).
templatesRouter.post("/", async (req, res) => {
  if (!(await ensureStore(res))) return;

  const body = req.body ?? {};
  const fields = pickRuntimeFields(body);
  if (!validateRuntimeFields(fields, res, { requireName: true })) return;

  const ownership = await createScope(req, res, body);
  if (!ownership) return;

  try {
    const template = await createTemplatePersisted({
      ...fields,
      ...ownership,
      createdBy: req.user?.sub ?? null,
    });
    return res.status(201).json({ template });
  } catch (err) {
    return sendTemplateError(res, err, "Couldn't create the template. Please try again.");
  }
});

// Phase 8/STAGE 2: update forks a NEW immutable version (never mutates history).
templatesRouter.put("/:id", async (req, res) => {
  if (!(await ensureStore(res))) return;

  const current = getTemplateVersion(req.params.id);
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
  }

  const patch = pickRuntimeFields(req.body ?? {});
  if (!validateRuntimeFields(patch, res)) return;

  if (patch.status !== undefined && patch.status !== current.status) {
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

  try {
    const template = await updateTemplatePersisted(req.params.id, patch);
    if (!template) return res.status(404).json({ error: "Template not found" });
    return res.json({ template });
  } catch (err) {
    return sendTemplateError(res, err, "Couldn't update the template. Please try again.");
  }
});

// Phase 8: upload a sample PDF -> structure draft -> saved as v1 draft for review.
templatesRouter.post("/from-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file uploaded (field name: file)" });
  if (!(await ensureStore(res))) return;

  const ownership = await createScope(req, res, req.body ?? {});
  if (!ownership) return undefined;

  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: "application/pdf" }), req.file.originalname);
    const response = await fetch(`${aiBase()}/v1/analyze-template`, { method: "POST", body: form });
    const draft = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[api] analyze-template failed:", response.status, JSON.stringify(draft).slice(0, 500));
      return res.status(response.status).json({ error: "Template extraction failed" });
    }

    const fields = pickRuntimeFields(req.body ?? {});
    const name = String(
      req.body?.name ?? draft.suggestedName ?? "Imported template",
    ).slice(0, 120);
    const template = await createTemplatePersisted({
      ...fields,
      name: name.trim().length >= 3 ? name : "Imported template",
      requiredSections: Array.isArray(draft.requiredSections)
        ? draft.requiredSections
        : fields.requiredSections,
      status: "draft",
      ...ownership,
      createdBy: req.user?.sub ?? null,
    });
    return res.status(201).json({ template, analysis: draft });
  } catch (err) {
    if (err instanceof TemplateConflictError || err instanceof TemplatePersistenceError) {
      return sendTemplateError(res, err, "Couldn't create the template. Please try again.");
    }
    return sendError(res, 502, "Template extraction failed", String(err).slice(0, 500));
  }
});
