import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import {
  createTemplate,
  getTemplateVersion,
  listTemplates,
  updateTemplate,
} from "../lib/templateStore.js";
import { sendError } from "../lib/errors.js";
import { isPlatformAdmin, loadActor } from "../lib/roles.js";
import {
  TEMPLATE_SCOPES,
  TEMPLATE_SCOPE_LEGACY,
  TEMPLATE_SCOPE_PRIVATE,
  TEMPLATE_STATUSES,
  canCreateTemplate,
  canManageTemplate,
  canSetTemplateStatus,
  isLegacyTemplate,
  templateScope,
} from "../lib/templateAccess.js";

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

// Catalogue visibility for reads. Private templates are owner-only. Legacy
// templates (unknown ownership) are platform-admin review material and must
// never leak into an ordinary user's catalogue. Shared/college catalogue
// filtering needs the Stage 2 preferences UI (college/branch selection), so it
// remains helper-tested in templateAccess.js rather than partially enforced
// here. Anonymous callers therefore see shared templates only, never legacy.
async function catalogueActor(req) {
  if (!req.user?.sub) return null;
  if (mongoose.connection.readyState !== 1) return null;
  try {
    return await loadActor(req);
  } catch (err) {
    console.error("[templates] failed to load catalogue actor:", String(err).slice(0, 300));
    return null;
  }
}

function canSeeTemplate(req, actor, t) {
  if (templateScope(t) === TEMPLATE_SCOPE_PRIVATE) return isPrivateOwner(req, t);
  if (isLegacyTemplate(t)) return isPlatformAdmin(actor);
  return true;
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
    const actor = await loadActor(req);
    if (!actor) {
      res.status(403).json({ error: "You do not have permission to do that" });
      return null;
    }
    return actor;
  } catch (err) {
    console.error("[templates] failed to load persisted actor:", String(err).slice(0, 300));
    res.status(503).json({ error: "Authorization is temporarily unavailable" });
    return null;
  }
}

// Resolve the scope for a newly created template. Shared/platform creation is
// an administrator action backed by the persisted user; unauthenticated
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

  if (requested === TEMPLATE_SCOPE_PRIVATE) {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return { scope: TEMPLATE_SCOPE_PRIVATE, ownerUserId: req.user.sub };
  }

  if (requested === "platform" || requested === "college") {
    const actor = await persistedActor(req, res);
    if (!actor) return null;
    if (!canCreateTemplate(actor, requested, body?.tenantId)) {
      res.status(403).json({ error: "You do not have permission to create this template" });
      return null;
    }
    return { scope: requested, ownerUserId: actor.id };
  }

  if (req.user) return { scope: TEMPLATE_SCOPE_PRIVATE, ownerUserId: req.user.sub };
  return { scope: TEMPLATE_SCOPE_LEGACY, ownerUserId: null };
}

// Phase 8: list latest version of each template. Private templates are scoped
// to their owner and legacy templates are platform-admin-only.
templatesRouter.get("/", async (req, res) => {
  const actor = await catalogueActor(req);
  res.json({
    templates: listTemplates()
      .filter((t) => canSeeTemplate(req, actor, t))
      .map(summary),
  });
});

// Phase 8: get a version (?version=N, default latest). Old versions stay readable forever.
templatesRouter.get("/:id", async (req, res) => {
  const t = getTemplateVersion(req.params.id, req.query.version ?? null);
  if (!t) return res.status(404).json({ error: "Template not found" });
  const actor = await catalogueActor(req);
  if (!canSeeTemplate(req, actor, t)) return res.status(404).json({ error: "Template not found" });
  return res.json({ template: t });
});

// Phase 8: create (always starts at v1 draft).
templatesRouter.post("/", async (req, res) => {
  const { name, tenantId, departmentId, header, watermark, footer, page, requiredSections } = req.body ?? {};
  if (!name || typeof name !== "string" || name.trim().length < 3) {
    return res.status(400).json({ error: "Template name (min 3 chars) is required" });
  }
  const ownership = await createScope(req, res, req.body ?? {});
  if (!ownership) return undefined;
  try {
    const t = createTemplate({
      name,
      tenantId,
      departmentId,
      header,
      watermark,
      footer,
      page,
      requiredSections,
      scope: ownership.scope,
      ownerUserId: ownership.ownerUserId,
      createdBy: req.user?.sub ?? null,
    });
    await tryPersist(t);
    return res.status(201).json({ template: t });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // Known product copy passes through; anything unexpected stays server-side.
    if (msg.includes("already exists")) return res.status(409).json({ error: msg });
    return sendError(res, 500, "Couldn't create the template. Please try again.", msg);
  }
});

// Phase 8: update forks a NEW immutable version (never mutates history).
templatesRouter.put("/:id", async (req, res) => {
  const current = getTemplateVersion(req.params.id);
  if (!current) return res.status(404).json({ error: "Template not found" });

  const scope = templateScope(current);
  if (scope === TEMPLATE_SCOPE_PRIVATE) {
    if (!isPrivateOwner(req, current)) {
      return res.status(403).json({ error: "You do not have permission to edit this template" });
    }
  } else {
    const actor = await persistedActor(req, res);
    if (!actor) return undefined;
    if (!canManageTemplate(actor, current)) {
      return res.status(403).json({ error: "You do not have permission to edit this template" });
    }
  }

  const allowed = ["name", "status", "header", "watermark", "footer", "page", "typography", "requiredSections", "studentMetadataFields"];
  const patch = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));

  if (patch.status !== undefined && !TEMPLATE_STATUSES.includes(patch.status)) {
    return res.status(400).json({ error: `Invalid template status (one of ${TEMPLATE_STATUSES.join(", ")})` });
  }

  if (patch.status !== undefined && patch.status !== current.status) {
    const actor =
      scope === TEMPLATE_SCOPE_PRIVATE
        ? { id: req.user?.sub, role: "user", collegeAdminOf: [] }
        : await persistedActor(req, res);
    if (!actor) return undefined;
    if (!canSetTemplateStatus(actor, current, patch.status)) {
      return res.status(403).json({ error: "You do not have permission to change this template's status" });
    }
  }

  const t = updateTemplate(req.params.id, patch);
  if (!t) return res.status(404).json({ error: "Template not found" });
  await tryPersist(t);
  return res.json({ template: t });
});

// Phase 8: upload a sample PDF -> structure draft -> saved as v1 draft for review.
templatesRouter.post("/from-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file uploaded (field name: file)" });
  const ownership = await createScope(req, res, req.body ?? {});
  if (!ownership) return undefined;
  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: "application/pdf" }), req.file.originalname);
    const r = await fetch(`${aiBase()}/v1/analyze-template`, { method: "POST", body: form });
    const draft = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[api] analyze-template failed:", r.status, JSON.stringify(draft).slice(0, 500));
      return res.status(r.status).json({ error: "Template extraction failed" });
    }
    const t = createTemplate({
      name: `${String(req.body?.name ?? draft.suggestedName ?? "Imported template").slice(0, 120)}`,
      tenantId: req.body?.tenantId,
      departmentId: req.body?.departmentId,
      requiredSections: draft.requiredSections,
      status: "draft",
      scope: ownership.scope,
      ownerUserId: ownership.ownerUserId,
      createdBy: req.user?.sub ?? null,
    });
    await tryPersist(t);
    return res.status(201).json({ template: t, analysis: draft });
  } catch (err) {
    return sendError(res, 502, "Template extraction failed", String(err).slice(0, 500));
  }
});

async function tryPersist(t) {
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return;
    const { Template } = await import("../models/index.js");
    await Template.updateOne(
      { id: t.id, version: t.version },
      { $set: { ...t, tenantId: t.tenantId ?? null, departmentId: t.departmentId ?? null } },
      { upsert: true },
    );
  } catch {
    // Non-fatal in local mode.
  }
}
