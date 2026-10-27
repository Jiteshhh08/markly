import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { AuditLog, Department, Tenant, User } from "../models/index.js";
import { sendError } from "../lib/errors.js";
import { recordAudit, safeAuditMetadata } from "../lib/audit.js";
import {
  ROLE_COLLEGE_ADMIN,
  ROLE_PLATFORM_ADMIN,
  canAccessCollege,
  isPlatformAdmin,
  requireRole,
} from "../lib/roles.js";
import {
  canSetBranchDefault,
  canViewBranchTemplate,
  canViewTemplate,
  templateBranchId,
  templateCollegeId,
  templateScope,
} from "../lib/templateAccess.js";
import {
  getTemplateVersionAuthoritative,
  listTemplateRecordsAuthoritative,
} from "../lib/templateStore.js";
import { validateTemplateFields } from "../lib/templateValidation.js";
import {
  UploadValidationError,
  validateImageUpload,
} from "../lib/uploadSafety.js";
import { ensureDirs, safeUploadFilename, uploadsDir } from "../lib/storage.js";

export const adminRouter = Router();

// Every route below is authenticated and authorized even when AUTH_REQUIRED=0.
// index.js mounts requirePersistedActor first, so req.actor is the CURRENT
// MongoDB user, never a JWT role claim or request-body role.
adminRouter.use(requireRole(ROLE_PLATFORM_ADMIN, ROLE_COLLEGE_ADMIN));

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function platformOnly(req, res) {
  if (isPlatformAdmin(req.actor)) return true;
  res.status(403).json({ error: "Only a platform administrator may perform this action" });
  return false;
}

function slugify(value, fallback = "item") {
  const slug = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function cleanId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const id = value.trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new Error(`${label} must use lowercase letters, numbers and hyphens (max 64 chars)`);
  }
  return id;
}

function cleanName(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const name = value.trim();
  if (name.length < 2 || name.length > 120) throw new Error(`${label} must be 2-120 characters`);
  return name;
}

function cleanSlug(value, fallback) {
  const slug = slugify(value ?? fallback, "");
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error("Slug must use lowercase letters, numbers and hyphens (max 64 chars)");
  }
  return slug;
}

function cleanStatus(value, fallback = "active") {
  if (value === undefined) return fallback;
  if (value !== "active" && value !== "inactive") {
    throw new Error("Status must be active or inactive");
  }
  return value;
}

function cleanMetadata(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Metadata must be an object");
  }
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6) throw new Error("Metadata is nested too deeply");
    if (Array.isArray(node)) {
      if (node.length > 100) throw new Error("Metadata contains too many entries");
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || key.includes(".") || key === "__proto__" || key === "constructor") {
        throw new Error("Metadata contains an unsupported key");
      }
      seen.add(key);
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  const json = JSON.stringify(value);
  if (json.length > 20_000) throw new Error("Metadata is too large");
  return JSON.parse(json);
}

function isDuplicateKey(err) {
  return err?.code === 11000 || err?.code === 11001 || String(err?.message ?? "").includes("E11000");
}

function validationError(res, err) {
  return sendError(res, 400, err instanceof Error ? err.message : "Invalid input");
}

async function findCollege(req, res, collegeId) {
  const id = String(collegeId ?? "").trim();
  if (!canAccessCollege(req.actor, id)) {
    res.status(403).json({ error: "You do not have permission to manage this college" });
    return null;
  }
  const college = await Tenant.findOne({ id }).lean();
  if (!college) {
    res.status(404).json({ error: "College not found" });
    return null;
  }
  return college;
}

async function findBranch(req, res, collegeId, branchId) {
  const college = await findCollege(req, res, collegeId);
  if (!college) return null;
  const branch = await Department.findOne({ id: String(branchId ?? ""), tenantId: college.id }).lean();
  if (!branch) {
    res.status(404).json({ error: "Branch not found" });
    return null;
  }
  return { college, branch };
}

function summaryTemplate(template, updatedAt = null) {
  return {
    id: template.id,
    version: template.version,
    name: template.name,
    status: template.status,
    scope: templateScope(template),
    tenantId: template.tenantId ?? null,
    departmentId: template.departmentId ?? null,
    ownerUserId: template.ownerUserId ?? null,
    updatedAt: updatedAt ?? template.updatedAt ?? null,
  };
}

function collegeScopeFor(req) {
  return isPlatformAdmin(req.actor) ? null : new Set(req.actor.collegeAdminOf ?? []);
}

function inCollegeScope(req, collegeId) {
  const scope = collegeScopeFor(req);
  if (!scope) return true;
  return Boolean(collegeId && scope.has(String(collegeId)));
}

async function audit(req, res, action, entityType, entityId, collegeId, metadata) {
  try {
    await recordAudit({
      actor: req.actor,
      action,
      entityType,
      entityId,
      collegeId,
      metadata,
    });
    return true;
  } catch (err) {
    console.error("[admin] audit persistence failed:", String(err).slice(0, 500));
    res.status(500).json({
      error:
        "The change was saved, but its audit record could not be written. Please contact an administrator.",
    });
    return false;
  }
}

/* ------------------------------- dashboard ------------------------------- */

adminRouter.get("/dashboard", async (req, res) => {
  try {
    const scope = collegeScopeFor(req);
    const collegeFilter = scope ? { id: { $in: [...scope] } } : {};
    const colleges = await Tenant.find(collegeFilter).lean();
    const collegeIds = colleges.map((college) => college.id);
    const branches = await Department.find(scope ? { tenantId: { $in: collegeIds } } : {}).lean();
    const records = await listTemplateRecordsAuthoritative();

    const visible = records.filter(({ template }) => {
      if (!canViewTemplate(req.actor, template)) return false;
      if (scope) return inCollegeScope(req, templateCollegeId(template));
      return true;
    });

    const counts = { draft: 0, published: 0, archived: 0 };
    for (const { template } of visible) {
      if (template.status === "archived") counts.archived += 1;
      else if (template.status === "active" || template.status === "published") counts.published += 1;
      else counts.draft += 1;
    }

    const recentTemplates = visible
      .map(({ template, updatedAt, createdAt }) => ({
        ...summaryTemplate(template, updatedAt ?? createdAt),
        _sort: new Date(updatedAt ?? createdAt ?? 0).getTime() || 0,
      }))
      .sort((a, b) => b._sort - a._sort || String(a.name).localeCompare(String(b.name)))
      .slice(0, 8)
      .map(({ _sort, ...template }) => template);

    const actionFilter = scope ? { collegeId: { $in: collegeIds } } : {};
    const recentActions = await AuditLog.find(actionFilter)
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    return res.json({
      stats: {
        colleges: colleges.length,
        branches: branches.length,
        templates: visible.length,
        draft: counts.draft,
        published: counts.published,
        archived: counts.archived,
      },
      recentTemplates,
      recentActions: recentActions.map((entry) => ({
        id: String(entry._id),
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        collegeId: entry.collegeId ?? null,
        metadata: entry.metadata ?? {},
        createdAt: entry.createdAt,
      })),
    });
  } catch (err) {
    return sendError(res, 503, "The admin dashboard is temporarily unavailable. Please try again.", err);
  }
});

/* -------------------------------- colleges ------------------------------- */

adminRouter.get("/colleges", async (req, res) => {
  try {
    const scope = collegeScopeFor(req);
    const colleges = await Tenant.find(scope ? { id: { $in: [...scope] } } : {}).sort({ name: 1 }).lean();
    const collegeIds = colleges.map((college) => college.id);
    const branchRows = await Department.aggregate([
      { $match: { tenantId: { $in: collegeIds } } },
      { $group: { _id: "$tenantId", count: { $sum: 1 } } },
    ]);
    const branchCounts = new Map(branchRows.map((row) => [row._id, row.count]));
    const records = await listTemplateRecordsAuthoritative();
    const templateCounts = new Map();
    for (const { template } of records) {
      if (!canViewTemplate(req.actor, template)) continue;
      const collegeId = templateCollegeId(template);
      if (!collegeId || !collegeIds.includes(collegeId)) continue;
      templateCounts.set(collegeId, (templateCounts.get(collegeId) ?? 0) + 1);
    }
    return res.json({
      colleges: colleges.map((college) => ({
        id: college.id,
        name: college.name ?? "",
        slug: college.slug ?? "",
        status: college.status ?? "active",
        metadata: college.metadata ?? {},
        createdAt: college.createdAt,
        updatedAt: college.updatedAt,
        branchCount: branchCounts.get(college.id) ?? 0,
        templateCount: templateCounts.get(college.id) ?? 0,
      })),
    });
  } catch (err) {
    return sendError(res, 503, "Colleges are temporarily unavailable. Please try again.", err);
  }
});

adminRouter.get("/colleges/:collegeId", async (req, res) => {
  try {
    const college = await findCollege(req, res, req.params.collegeId);
    if (!college) return undefined;
    const branches = await Department.find({ tenantId: college.id }).sort({ name: 1 }).lean();
    return res.json({
      college: {
        id: college.id,
        name: college.name ?? "",
        slug: college.slug ?? "",
        status: college.status ?? "active",
        metadata: college.metadata ?? {},
        createdAt: college.createdAt,
        updatedAt: college.updatedAt,
      },
      branches: branches.map((branch) => ({
        id: branch.id,
        tenantId: branch.tenantId,
        name: branch.name ?? "",
        slug: branch.slug ?? "",
        status: branch.status ?? "active",
        defaultTemplateId: branch.defaultTemplateId ?? null,
        defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
        metadata: branch.metadata ?? {},
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      })),
    });
  } catch (err) {
    return sendError(res, 503, "The college is temporarily unavailable. Please try again.", err);
  }
});

adminRouter.post("/colleges", async (req, res) => {
  if (!platformOnly(req, res)) return undefined;
  try {
    const body = req.body ?? {};
    const name = cleanName(body.name, "College name");
    const slug = cleanSlug(body.slug ?? name, "college");
    const id = cleanId(body.id, "College id") ?? slug;
    const status = cleanStatus(body.status);
    const metadata = cleanMetadata(body.metadata) ?? {};

    const existing = await Tenant.findOne({ $or: [{ id }, { slug }] }).lean();
    if (existing) {
      return res.status(409).json({ error: "A college with that id or slug already exists" });
    }
    const college = await Tenant.create({ id, name, slug, status, metadata });
    if (!(await audit(req, res, "college.create", "college", id, id, {
      name,
      slug,
      status,
    }))) return undefined;
    return res.status(201).json({
      college: {
        id: college.id,
        name: college.name,
        slug: college.slug,
        status: college.status,
        metadata: college.metadata ?? {},
      },
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: "A college with that id or slug already exists" });
    }
    return validationError(res, err);
  }
});

adminRouter.patch("/colleges/:collegeId", async (req, res) => {
  if (!platformOnly(req, res)) return undefined;
  try {
    const college = await Tenant.findOne({ id: String(req.params.collegeId) }).lean();
    if (!college) return res.status(404).json({ error: "College not found" });

    const body = req.body ?? {};
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name, "College name");
    if (body.slug !== undefined) patch.slug = cleanSlug(body.slug);
    if (body.status !== undefined) patch.status = cleanStatus(body.status);
    if (body.metadata !== undefined) patch.metadata = cleanMetadata(body.metadata);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No supported college fields to update" });
    }
    if (patch.slug && patch.slug !== college.slug) {
      const conflict = await Tenant.findOne({ slug: patch.slug, id: { $ne: college.id } }).lean();
      if (conflict) return res.status(409).json({ error: "That college slug is already in use" });
    }

    const updated = await Tenant.findOneAndUpdate(
      { id: college.id },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    const before = {};
    for (const key of Object.keys(patch)) before[key] = college[key] ?? null;
    if (!(await audit(req, res, "college.update", "college", college.id, college.id, {
      before,
      after: safeAuditMetadata(patch),
    }))) return undefined;
    return res.json({
      college: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        status: updated.status,
        metadata: updated.metadata ?? {},
      },
    });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: "That college slug is already in use" });
    return validationError(res, err);
  }
});

adminRouter.get("/colleges/:collegeId/admins", async (req, res) => {
  try {
    const college = await findCollege(req, res, req.params.collegeId);
    if (!college) return undefined;
    if (!isPlatformAdmin(req.actor) && !req.actor.collegeAdminOf.includes(college.id)) {
      return res.status(403).json({ error: "You do not have permission to view these administrators" });
    }
    const users = await User.find({ collegeAdminOf: college.id })
      .select({ id: 1, email: 1, name: 1, role: 1, collegeAdminOf: 1, _id: 0 })
      .lean();
    return res.json({
      admins: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name ?? "",
        role: user.role ?? "user",
        collegeAdminOf: user.collegeAdminOf ?? [],
      })),
    });
  } catch (err) {
    return sendError(res, 503, "College administrators are temporarily unavailable.", err);
  }
});

adminRouter.post("/colleges/:collegeId/admins", async (req, res) => {
  if (!platformOnly(req, res)) return undefined;
  try {
    const college = await Tenant.findOne({ id: String(req.params.collegeId) }).lean();
    if (!college) return res.status(404).json({ error: "College not found" });
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    if (!email.includes("@") || email.length > 320) {
      return res.status(400).json({ error: "A valid account email is required" });
    }
    const user = await User.findOne({ email }).lean();
    if (!user) return res.status(404).json({ error: "No account exists for that email" });

    const nextScope = [...new Set([...(user.collegeAdminOf ?? []), college.id])];
    const nextRole = user.role === ROLE_PLATFORM_ADMIN ? user.role : ROLE_COLLEGE_ADMIN;
    const updated = await User.findOneAndUpdate(
      { email },
      { $set: { role: nextRole, collegeAdminOf: nextScope } },
      { new: true, runValidators: true },
    ).lean();
    if (!(await audit(req, res, "college.admin.assign", "user", updated.id, college.id, {
      before: { role: user.role ?? "user", collegeAdminOf: user.collegeAdminOf ?? [] },
      after: { role: updated.role, collegeAdminOf: updated.collegeAdminOf ?? [] },
    }))) return undefined;
    return res.json({
      admin: {
        id: updated.id,
        email: updated.email,
        name: updated.name ?? "",
        role: updated.role,
        collegeAdminOf: updated.collegeAdminOf ?? [],
      },
    });
  } catch (err) {
    return validationError(res, err);
  }
});

adminRouter.delete("/colleges/:collegeId/admins/:userId", async (req, res) => {
  if (!platformOnly(req, res)) return undefined;
  try {
    const college = await Tenant.findOne({ id: String(req.params.collegeId) }).lean();
    if (!college) return res.status(404).json({ error: "College not found" });
    const user = await User.findOne({ id: String(req.params.userId) }).lean();
    if (!user) return res.status(404).json({ error: "Account not found" });
    if (user.role === ROLE_PLATFORM_ADMIN) {
      return res.status(400).json({ error: "Platform administrators do not need college assignments" });
    }
    const nextScope = (user.collegeAdminOf ?? []).filter((id) => id !== college.id);
    const nextRole = nextScope.length > 0 ? ROLE_COLLEGE_ADMIN : "user";
    const updated = await User.findOneAndUpdate(
      { id: user.id },
      { $set: { role: nextRole, collegeAdminOf: nextScope } },
      { new: true, runValidators: true },
    ).lean();
    if (!(await audit(req, res, "college.admin.remove", "user", updated.id, college.id, {
      before: { role: user.role ?? "user", collegeAdminOf: user.collegeAdminOf ?? [] },
      after: { role: updated.role, collegeAdminOf: updated.collegeAdminOf ?? [] },
    }))) return undefined;
    return res.json({
      admin: {
        id: updated.id,
        email: updated.email,
        name: updated.name ?? "",
        role: updated.role,
        collegeAdminOf: updated.collegeAdminOf ?? [],
      },
    });
  } catch (err) {
    return sendError(res, 503, "The administrator assignment could not be updated.", err);
  }
});

/* -------------------------------- branches ------------------------------- */

adminRouter.get("/colleges/:collegeId/branches", async (req, res) => {
  try {
    const college = await findCollege(req, res, req.params.collegeId);
    if (!college) return undefined;
    const branches = await Department.find({ tenantId: college.id }).sort({ name: 1 }).lean();
    return res.json({
      branches: branches.map((branch) => ({
        id: branch.id,
        tenantId: branch.tenantId,
        name: branch.name ?? "",
        slug: branch.slug ?? "",
        status: branch.status ?? "active",
        defaultTemplateId: branch.defaultTemplateId ?? null,
        defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
        metadata: branch.metadata ?? {},
      })),
    });
  } catch (err) {
    return sendError(res, 503, "Branches are temporarily unavailable. Please try again.", err);
  }
});

adminRouter.post("/colleges/:collegeId/branches", async (req, res) => {
  try {
    const college = await findCollege(req, res, req.params.collegeId);
    if (!college) return undefined;
    const body = req.body ?? {};
    const name = cleanName(body.name, "Branch name");
    const slug = cleanSlug(body.slug ?? name, "branch");
    // Generated ids stay inside the same 64-char grammar as supplied ids.
    const id = cleanId(body.id, "Branch id") ?? `${slug.slice(0, 40)}-${randomUUID().slice(0, 8)}`;
    const status = cleanStatus(body.status);
    const metadata = cleanMetadata(body.metadata) ?? {};
    if (await Department.exists({ id })) {
      return res.status(409).json({ error: "A branch with that id already exists" });
    }
    if (await Department.exists({ tenantId: college.id, slug })) {
      return res.status(409).json({ error: "A branch with that slug already exists in this college" });
    }
    const branch = await Department.create({
      id,
      tenantId: college.id,
      name,
      slug,
      status,
      metadata,
      defaultTemplateId: null,
      defaultTemplateVersion: null,
    });
    if (!(await audit(req, res, "branch.create", "branch", id, college.id, {
      name,
      slug,
      status,
    }))) return undefined;
    return res.status(201).json({
      branch: {
        id: branch.id,
        tenantId: branch.tenantId,
        name: branch.name,
        slug: branch.slug,
        status: branch.status,
        defaultTemplateId: null,
        defaultTemplateVersion: null,
        metadata: branch.metadata ?? {},
      },
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: "A branch with that id or slug already exists" });
    }
    return validationError(res, err);
  }
});

adminRouter.patch("/colleges/:collegeId/branches/:branchId", async (req, res) => {
  try {
    const found = await findBranch(req, res, req.params.collegeId, req.params.branchId);
    if (!found) return undefined;
    const { college, branch } = found;
    const body = req.body ?? {};
    if (body.tenantId !== undefined || body.collegeId !== undefined) {
      return res.status(400).json({ error: "A branch cannot be moved between colleges" });
    }
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name, "Branch name");
    if (body.slug !== undefined) patch.slug = cleanSlug(body.slug);
    if (body.status !== undefined) patch.status = cleanStatus(body.status);
    if (body.metadata !== undefined) patch.metadata = cleanMetadata(body.metadata);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No supported branch fields to update" });
    }
    if (patch.slug && patch.slug !== branch.slug) {
      const conflict = await Department.findOne({
        tenantId: college.id,
        slug: patch.slug,
        id: { $ne: branch.id },
      }).lean();
      if (conflict) return res.status(409).json({ error: "That branch slug is already in use" });
    }
    const updated = await Department.findOneAndUpdate(
      { id: branch.id, tenantId: college.id },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    const before = {};
    for (const key of Object.keys(patch)) before[key] = branch[key] ?? null;
    if (!(await audit(req, res, "branch.update", "branch", branch.id, college.id, {
      before,
      after: safeAuditMetadata(patch),
    }))) return undefined;
    return res.json({
      branch: {
        id: updated.id,
        tenantId: updated.tenantId,
        name: updated.name,
        slug: updated.slug,
        status: updated.status,
        defaultTemplateId: updated.defaultTemplateId ?? null,
        defaultTemplateVersion: updated.defaultTemplateVersion ?? null,
        metadata: updated.metadata ?? {},
      },
    });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: "That branch slug is already in use" });
    return validationError(res, err);
  }
});

adminRouter.get("/colleges/:collegeId/branches/:branchId/templates", async (req, res) => {
  try {
    const found = await findBranch(req, res, req.params.collegeId, req.params.branchId);
    if (!found) return undefined;
    const records = await listTemplateRecordsAuthoritative();
    const templates = records
      .filter(({ template }) => canViewBranchTemplate(req.actor, template, found.branch))
      .map(({ template, updatedAt, createdAt }) => summaryTemplate(template, updatedAt ?? createdAt));
    return res.json({ templates });
  } catch (err) {
    return sendError(res, 503, "Branch templates are temporarily unavailable.", err);
  }
});

adminRouter.put("/colleges/:collegeId/branches/:branchId/default-template", async (req, res) => {
  try {
    const found = await findBranch(req, res, req.params.collegeId, req.params.branchId);
    if (!found) return undefined;
    const { college, branch } = found;
    if (branch.status !== "active") {
      return res.status(400).json({ error: "Activate the branch before setting a default template" });
    }

    const templateId = req.body?.templateId ?? null;
    const requestedVersion = req.body?.templateVersion;
    if (templateId == null) {
      const cleared = await Department.findOneAndUpdate(
        { id: branch.id, tenantId: college.id },
        { $set: { defaultTemplateId: null, defaultTemplateVersion: null } },
        { new: true },
      ).lean();
      if (!(await audit(req, res, "branch.default_template.clear", "branch", branch.id, college.id, {
        before: {
          defaultTemplateId: branch.defaultTemplateId ?? null,
          defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
        },
        after: { defaultTemplateId: null, defaultTemplateVersion: null },
      }))) return undefined;
      return res.json({
        branch: {
          id: cleared.id,
          tenantId: cleared.tenantId,
          defaultTemplateId: null,
          defaultTemplateVersion: null,
        },
      });
    }

    let version = null;
    if (requestedVersion !== undefined && requestedVersion !== null) {
      version = Number(requestedVersion);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: "templateVersion must be a positive integer" });
      }
    }
    const template = await getTemplateVersionAuthoritative(String(templateId), version);
    if (!template) return res.status(404).json({ error: "Template not found" });
    if (!canSetBranchDefault(req.actor, template, branch)) {
      return res.status(403).json({ error: "That template cannot be the default for this branch" });
    }
    if (templateScope(template) === "college" && templateCollegeId(template) !== college.id) {
      return res.status(400).json({ error: "The default template belongs to another college" });
    }
    if (templateBranchId(template) && templateBranchId(template) !== branch.id) {
      return res.status(400).json({ error: "The default template belongs to another branch" });
    }

    const updated = await Department.findOneAndUpdate(
      { id: branch.id, tenantId: college.id },
      {
        $set: {
          defaultTemplateId: template.id,
          defaultTemplateVersion: template.version,
        },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!(await audit(req, res, "branch.default_template.set", "branch", branch.id, college.id, {
      before: {
        defaultTemplateId: branch.defaultTemplateId ?? null,
        defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
      },
      after: {
        defaultTemplateId: template.id,
        defaultTemplateVersion: template.version,
        templateScope: templateScope(template),
      },
    }))) return undefined;
    return res.json({
      branch: {
        id: updated.id,
        tenantId: updated.tenantId,
        defaultTemplateId: updated.defaultTemplateId,
        defaultTemplateVersion: updated.defaultTemplateVersion,
      },
    });
  } catch (err) {
    return sendError(res, 503, "The branch default could not be updated.", err);
  }
});

/* ---------------------------------- audit -------------------------------- */

adminRouter.get("/audit", async (req, res) => {
  try {
    const scope = collegeScopeFor(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
    const filter = scope ? { collegeId: { $in: [...scope] } } : {};
    const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({
      actions: entries.map((entry) => ({
        id: String(entry._id),
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        collegeId: entry.collegeId ?? null,
        metadata: entry.metadata ?? {},
        createdAt: entry.createdAt,
      })),
    });
  } catch (err) {
    return sendError(res, 503, "The audit trail is temporarily unavailable.", err);
  }
});

/* ---------------------------------- assets ------------------------------- */

adminRouter.post("/assets", imageUpload.single("file"), async (req, res) => {
  try {
    const detected = validateImageUpload(req.file);
    ensureDirs();
    const filename = safeUploadFilename(req.file.originalname, detected.extension);
    const full = join(uploadsDir, filename);
    await writeFile(full, req.file.buffer, { flag: "wx" });
    return res.status(201).json({
      asset: {
        url: `/assets/uploads/${filename}`,
        mimeType: detected.mimeType,
        size: req.file.buffer.length,
        originalName: String(req.file.originalname ?? "").slice(0, 200),
      },
    });
  } catch (err) {
    if (err instanceof UploadValidationError || err?.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    return sendError(res, 500, "The asset could not be stored. Please try again.", err);
  }
});

// Oversized/malformed multipart uploads are client errors, not 500s.
adminRouter.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: "The uploaded image is too large or malformed" });
  }
  if (err instanceof UploadValidationError) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

export const __adminTesting = { validateTemplateFields, templateScope, mongoose };
