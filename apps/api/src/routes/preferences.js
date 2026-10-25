import { Router } from "express";
import mongoose from "mongoose";
import { Department, Tenant, User } from "../models/index.js";
import { sendError } from "../lib/errors.js";
import { loadActorById } from "../lib/roles.js";
import {
  TEMPLATE_SCOPE_COLLEGE,
  canUseTemplate,
  templateBranchId,
  templateCollegeId,
  templateScope,
} from "../lib/templateAccess.js";
import {
  ensureTemplatesLoaded,
  getTemplateVersionAuthoritative,
  listTemplateRecordsAuthoritative,
} from "../lib/templateStore.js";

// STAGE 4: per-user college/branch preferences.
//
// SECURITY RULE: every handler operates on req.actor.id only. No request body,
// query string, or path parameter can select another user's preferences.
// index.js mounts this router behind requirePersistedActor, so anonymous and
// memory-only callers receive 401/503 rather than a fake local preference.

export const preferencesRouter = Router();

const MAX_ID_LENGTH = 128;

class PreferencesError extends Error {
  constructor(message, status = 400, code = "preferences_invalid") {
    super(message);
    this.name = "PreferencesError";
    this.status = status;
    this.code = code;
  }
}

function cleanId(value, label) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || typeof value === "object") {
    throw new PreferencesError(`${label} must be a single value.`);
  }
  const id = String(value).trim();
  if (!id) return null;
  if (id.length > MAX_ID_LENGTH) {
    throw new PreferencesError(`${label} is too long.`);
  }
  return id;
}

function cleanVersion(value) {
  if (value === undefined || value === null || value === "") return null;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new PreferencesError("preferredTemplateVersion must be a positive integer.");
  }
  return version;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function normalizePreferences(preferences) {
  return {
    collegeId: preferences?.collegeId ?? null,
    departmentId: preferences?.departmentId ?? null,
    preferredTemplateId: preferences?.preferredTemplateId ?? null,
    preferredTemplateVersion: preferences?.preferredTemplateVersion ?? null,
    setupCompletedAt: preferences?.setupCompletedAt ?? null,
    updatedAt: preferences?.updatedAt ?? null,
  };
}

export function isSetupComplete(preferences) {
  if (!preferences) return false;
  // Legacy Stage 1-3 preferences already contain a valid college/branch pair
  // but predate setupCompletedAt; they must not trigger the first-time screen.
  if (preferences.setupCompletedAt) return true;
  return Boolean(preferences.collegeId && preferences.departmentId);
}

function templateSummary(template) {
  if (!template) return null;
  return {
    id: template.id,
    version: template.version,
    name: template.name ?? "",
    status: template.status ?? "",
    scope: templateScope(template),
    tenantId: templateCollegeId(template),
    departmentId: templateBranchId(template),
  };
}

async function exactDefaultTemplate(branch) {
  if (!branch?.defaultTemplateId) return null;
  const version = Number(branch.defaultTemplateVersion);
  if (!Number.isInteger(version) || version < 1) return null;
  return getTemplateVersionAuthoritative(branch.defaultTemplateId, version);
}

async function buildPreferencesResponse(actor) {
  const preferences = normalizePreferences(actor?.preferences);
  let college = null;
  let branch = null;
  let defaultTemplate = null;
  let preferredTemplate = null;

  if (preferences.collegeId) {
    college = await Tenant.findOne({ id: preferences.collegeId }).lean();
  }
  if (preferences.collegeId && preferences.departmentId) {
    branch = await Department.findOne({
      id: preferences.departmentId,
      tenantId: preferences.collegeId,
    }).lean();
  }

  if (branch) {
    defaultTemplate = await exactDefaultTemplate(branch);
  }

  if (preferences.preferredTemplateId) {
    const template = await getTemplateVersionAuthoritative(
      preferences.preferredTemplateId,
      preferences.preferredTemplateVersion ?? null,
    );
    if (template) {
      const available = canUseTemplate(actor, template);
      preferredTemplate = available
        ? { ...templateSummary(template), available: true }
        : {
            id: template.id,
            version: template.version,
            available: false,
          };
    }
  }

  return {
    preferences,
    setupCompleted: isSetupComplete(preferences),
    college: college
      ? {
          id: college.id,
          name: college.name ?? "",
          slug: college.slug ?? "",
          status: college.status ?? "active",
        }
      : null,
    branch: branch
      ? {
          id: branch.id,
          tenantId: branch.tenantId,
          name: branch.name ?? "",
          slug: branch.slug ?? "",
          status: branch.status ?? "active",
          defaultTemplateId: branch.defaultTemplateId ?? null,
          defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
          defaultTemplate: templateSummary(defaultTemplate),
        }
      : null,
    preferredTemplate,
  };
}

async function validateCollegeAndBranch({ collegeId, departmentId }) {
  if (departmentId && !collegeId) {
    throw new PreferencesError("Select a college before choosing a branch.");
  }
  if (!collegeId && !departmentId) return { college: null, branch: null };

  const college = await Tenant.findOne({ id: collegeId }).lean();
  if (!college) throw new PreferencesError("College not found.");
  if (college.status === "inactive") {
    throw new PreferencesError("The selected college is inactive.");
  }

  const branch = await Department.findOne({
    id: departmentId,
    tenantId: collegeId,
  }).lean();
  if (!branch) {
    throw new PreferencesError("The selected branch does not belong to this college.");
  }
  if (branch.status === "inactive") {
    throw new PreferencesError("The selected branch is inactive.");
  }
  return { college, branch };
}

async function resolvePreferredTemplate({ actor, collegeId, departmentId, templateId, templateVersion }) {
  if (!templateId) {
    if (templateVersion != null) {
      throw new PreferencesError("preferredTemplateVersion requires preferredTemplateId.");
    }
    return null;
  }

  await ensureTemplatesLoaded();
  const template = await getTemplateVersionAuthoritative(templateId, templateVersion);
  if (!template) {
    throw new PreferencesError("The selected preferred template is unavailable.", 404);
  }

  const scope = templateScope(template);
  if (!collegeId && scope === TEMPLATE_SCOPE_COLLEGE) {
    throw new PreferencesError(
      "Choose your college and branch before selecting a college template.",
    );
  }

  // Validate against the preferences being saved, not the actor's old ones.
  const prospectiveActor = {
    ...actor,
    preferences: {
      collegeId,
      departmentId,
      preferredTemplateId: null,
      preferredTemplateVersion: null,
      setupCompletedAt: null,
    },
  };
  if (!canUseTemplate(prospectiveActor, template)) {
    throw new PreferencesError("The selected preferred template is unavailable.", 404);
  }

  // Defense in depth: college/branch metadata must agree with the selection.
  if (scope === TEMPLATE_SCOPE_COLLEGE) {
    if (templateCollegeId(template) !== collegeId) {
      throw new PreferencesError("The selected preferred template is unavailable.", 404);
    }
    if (templateBranchId(template) && templateBranchId(template) !== departmentId) {
      throw new PreferencesError("The selected preferred template is unavailable.", 404);
    }
  }

  return template;
}

function userIdQuery(actorId) {
  const id = String(actorId ?? "").trim();
  if (mongoose.Types.ObjectId.isValid(id)) {
    return { $or: [{ id }, { _id: id }] };
  }
  return { id };
}

preferencesRouter.get("/", async (req, res) => {
  try {
    return res.json(await buildPreferencesResponse(req.actor));
  } catch (err) {
    return sendError(res, 503, "Your preferences are temporarily unavailable. Please try again.", err);
  }
});

preferencesRouter.get("/options", async (req, res) => {
  try {
    const colleges = await Tenant.find({ status: { $ne: "inactive" } })
      .sort({ name: 1 })
      .lean();
    const collegeIds = colleges.map((college) => college.id);
    const branches = await Department.find({
      tenantId: { $in: collegeIds },
      status: { $ne: "inactive" },
    })
      .sort({ name: 1 })
      .lean();

    const branchesByCollege = new Map();
    for (const branch of branches) {
      const list = branchesByCollege.get(branch.tenantId) ?? [];
      list.push(branch);
      branchesByCollege.set(branch.tenantId, list);
    }

    // Eligible templates are resolved server-side so the UI can offer real
    // choices without widening the catalogue scope. Personal templates
    // (published platform + the actor's own private ones) are available even
    // when no college is configured; branch lists only contain templates that
    // the actor could actually select for that exact college/branch.
    const allTemplates = (await listTemplateRecordsAuthoritative()).map(
      (record) => record.template,
    );
    const personalActor = { ...req.actor, preferences: null };
    const personalTemplates = allTemplates
      .filter((template) => {
        const scope = templateScope(template);
        if (scope !== "platform" && scope !== "private") return false;
        return canUseTemplate(personalActor, template);
      })
      .map(templateSummary);

    const out = [];
    for (const college of colleges) {
      const collegeBranches = [];
      for (const branch of branchesByCollege.get(college.id) ?? []) {
        const defaultTemplate = await exactDefaultTemplate(branch);
        const branchActor = {
          ...req.actor,
          preferences: {
            ...(req.actor.preferences ?? {}),
            collegeId: college.id,
            departmentId: branch.id,
            preferredTemplateId: null,
            preferredTemplateVersion: null,
          },
        };
        const branchTemplates = allTemplates
          .filter((template) => {
            const scope = templateScope(template);
            if (scope === "platform") return canUseTemplate(branchActor, template);
            if (scope !== TEMPLATE_SCOPE_COLLEGE) return false;
            if (templateCollegeId(template) !== college.id) return false;
            const templateBranch = templateBranchId(template);
            if (templateBranch && templateBranch !== branch.id) return false;
            return canUseTemplate(branchActor, template);
          })
          .map(templateSummary);
        collegeBranches.push({
          id: branch.id,
          tenantId: branch.tenantId,
          name: branch.name ?? "",
          slug: branch.slug ?? "",
          status: branch.status ?? "active",
          defaultTemplateId: branch.defaultTemplateId ?? null,
          defaultTemplateVersion: branch.defaultTemplateVersion ?? null,
          defaultTemplate: templateSummary(defaultTemplate),
          templates: branchTemplates,
        });
      }
      out.push({
        id: college.id,
        name: college.name ?? "",
        slug: college.slug ?? "",
        status: college.status ?? "active",
        branches: collegeBranches,
      });
    }
    return res.json({ colleges: out, personalTemplates });
  } catch (err) {
    return sendError(res, 503, "College options are temporarily unavailable. Please try again.", err);
  }
});

preferencesRouter.put("/", async (req, res) => {
  const body = req.body ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "Invalid preferences payload.");
  }

  try {
    const existing = req.actor.preferences ?? {};
    const collegeProvided = hasOwn(body, "collegeId") || hasOwn(body, "tenantId");
    const branchProvided = hasOwn(body, "departmentId") || hasOwn(body, "branchId");
    const templateProvided =
      hasOwn(body, "preferredTemplateId") || hasOwn(body, "preferredTemplateVersion");

    const existingCollegeId = existing.collegeId ?? null;
    const existingDepartmentId = existing.departmentId ?? null;
    const collegeId = collegeProvided
      ? cleanId(body.collegeId ?? body.tenantId, "collegeId")
      : existingCollegeId;
    let departmentId;
    if (branchProvided) {
      departmentId = cleanId(body.departmentId ?? body.branchId, "departmentId");
    } else if (collegeProvided && collegeId !== existingCollegeId) {
      // Changing or clearing the college without naming a branch must not
      // silently keep the old branch (it belongs to the previous college).
      departmentId = null;
    } else {
      departmentId = existingDepartmentId;
    }

    if (collegeId && !departmentId) {
      throw new PreferencesError("Select a branch for the selected college.");
    }

    await validateCollegeAndBranch({ collegeId, departmentId });

    const requestedTemplateId = templateProvided
      ? cleanId(body.preferredTemplateId, "preferredTemplateId")
      : existing.preferredTemplateId ?? null;
    const requestedVersion = templateProvided
      ? cleanVersion(body.preferredTemplateVersion)
      : existing.preferredTemplateVersion ?? null;

    const template = await resolvePreferredTemplate({
      actor: req.actor,
      collegeId,
      departmentId,
      templateId: requestedTemplateId,
      templateVersion: requestedVersion,
    });

    const now = new Date();
    const preferences = {
      collegeId,
      departmentId,
      preferredTemplateId: template?.id ?? null,
      preferredTemplateVersion: template?.version ?? null,
      setupCompletedAt: now,
      updatedAt: now,
    };

    const updated = await User.findOneAndUpdate(
      userIdQuery(req.actor.id),
      { $set: { preferences } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) {
      return sendError(res, 404, "Your account is no longer available.");
    }

    const actor = await loadActorById(req.actor.id);
    if (!actor) {
      return sendError(res, 503, "Your preferences were saved, but could not be reloaded.");
    }
    return res.json(await buildPreferencesResponse(actor));
  } catch (err) {
    if (err instanceof PreferencesError) {
      return sendError(res, err.status, err.message);
    }
    return sendError(res, 503, "Your preferences could not be saved. Please try again.", err);
  }
});
