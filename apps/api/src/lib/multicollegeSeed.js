import { loadTemplates } from "./templates.js";
import { STAGE1_MIGRATION_VERSION } from "./multicollegeMigration.js";

// STAGE 1: idempotent TCET seed.
//
// The seed reuses the existing tenant template file as the source of truth and
// only INSERTS missing documents ($setOnInsert). Re-running never overwrites
// an administrator's edits, never duplicates records and never deletes data.
// It is a CLI/library operation only: nothing here runs at API startup.
//
// STAGE 8 follow-up: TCET now seeds all of its branches. The Computer
// Engineering branch is the first branch and is pinned to the seeded template
// as its default. Existing installs get missing branches, and a missing CE
// default is backfilled without overwriting an administrator's choice.

export const STAGE1_SEED_KEY = "stage1:tcet";

export const TCET_BRANCHES = Object.freeze([
  { id: "tcet-computer-engineering", name: "Computer Engineering" },
  { id: "tcet-information-technology", name: "Information Technology" },
  {
    id: "tcet-electronics-telecommunication-engineering",
    name: "Electronics & Telecommunication Engineering",
  },
  {
    id: "tcet-electronics-computer-science",
    name: "Electronics and Computer Science",
  },
  { id: "tcet-mechanical-engineering", name: "Mechanical Engineering" },
  { id: "tcet-civil-engineering", name: "Civil Engineering" },
  {
    id: "tcet-artificial-intelligence-machine-learning",
    name: "Artificial Intelligence & Machine Learning (AI & ML)",
  },
  {
    id: "tcet-artificial-intelligence-data-science",
    name: "Artificial Intelligence & Data Science (AI & DS)",
  },
  {
    id: "tcet-computer-science-engineering-iot",
    name: "Computer Science and Engineering (Internet of Things / IoT)",
  },
  {
    id: "tcet-computer-science-engineering-cyber-security",
    name: "Computer Science and Engineering (Cyber Security)",
  },
]);

function stripDollarKeys(value) {
  if (Array.isArray(value)) return value.map(stripDollarKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$")) continue;
    out[key] = stripDollarKeys(child);
  }
  return out;
}

function tcetSeedDoc() {
  const docs = loadTemplates();
  const doc = docs.find((entry) => entry?.template?.id === "tcet-computer-engineering") ?? docs[0];
  if (!doc?.template?.id || !doc?.tenant?.id || !doc?.department?.id) {
    throw new Error("TCET seed file is missing tenant/department/template identity");
  }
  return stripDollarKeys(doc);
}

export function seedDefinitions() {
  const seed = tcetSeedDoc();
  const tenant = {
    id: String(seed.tenant.id),
    name: String(seed.tenant.name || "TCET"),
    slug: String(seed.tenant.slug || seed.tenant.id),
    status: "active",
    seedKey: `${STAGE1_SEED_KEY}:college`,
    migrationStage1: { version: STAGE1_MIGRATION_VERSION, seed: true },
  };
  const template = {
    ...seed.template,
    // Explicit college ownership comes from the seed file's tenantId. It is
    // not inferred from the template name.
    scope: "college",
    ownerUserId: null,
    seedKey: `${STAGE1_SEED_KEY}:template:${seed.template.id}@${seed.template.version ?? 1}`,
    isSeed: true,
    legacyUnscoped: false,
    needsReview: false,
    migrationStage1: { version: STAGE1_MIGRATION_VERSION, seed: true },
  };
  const seedDepartmentId = String(seed.department.id);
  const defaultTemplateVersion = Number(template.version ?? 1);
  const departments = TCET_BRANCHES.map(({ id, name }) => ({
    id,
    tenantId: String(seed.tenant.id),
    name,
    status: "active",
    seedKey:
      id === seedDepartmentId
        ? `${STAGE1_SEED_KEY}:department`
        : `${STAGE1_SEED_KEY}:department:${id}`,
    migrationStage1: { version: STAGE1_MIGRATION_VERSION, seed: true },
    ...(id === seedDepartmentId
      ? {
          defaultTemplateId: String(template.id),
          defaultTemplateVersion,
        }
      : {}),
  }));
  const department = departments.find((entry) => entry.id === seedDepartmentId);
  if (!department) {
    throw new Error("TCET seed file department is missing from TCET_BRANCHES");
  }
  return { tenant, department, departments, template, templates: [template] };
}

function isPublishedStatus(status) {
  return status === "active" || status === "published";
}

export function planSeed({ tenants = [], departments = [], templates = [] } = {}) {
  const defs = seedDefinitions();
  const tenantExists = tenants.some((doc) => doc.id === defs.tenant.id);
  // STAGE 2: ANY version of the seed template id means the install already has
  // the TCET template. Never insert v1 over an administrator-edited v1 or next
  // to a newer published version; existing installs keep their changes.
  const templateExists = templates.some((doc) => doc.id === defs.template.id);
  const templateVersion = Number(defs.template.version ?? 1);
  const existingSeedTemplate = templates.find(
    (doc) =>
      doc.id === defs.template.id && Number(doc.version) === templateVersion,
  );
  const templatePlan = {
    action: templateExists ? "skip" : "create",
    id: defs.template.id,
    version: templateVersion,
  };
  const defaultTemplateUsable =
    templatePlan.action === "create" ||
    Boolean(existingSeedTemplate && isPublishedStatus(existingSeedTemplate.status));

  const branchPlans = defs.departments.map((department) => {
    const existing = departments.find((doc) => doc.id === department.id);
    const action = existing ? "skip" : "create";
    const defaultAction =
      existing &&
      !existing.defaultTemplateId &&
      department.defaultTemplateId &&
      existing.status !== "inactive" &&
      defaultTemplateUsable
        ? "set"
        : "skip";
    return { action, defaultAction, id: department.id, department };
  });
  const departmentPlan = branchPlans.find(
    (entry) => entry.id === defs.department.id,
  );

  return {
    tenant: { action: tenantExists ? "skip" : "create", id: defs.tenant.id },
    // Kept as the Computer Engineering branch for callers that only need the
    // first branch. `departments` is the complete TCET branch plan.
    department: departmentPlan,
    departments: branchPlans,
    template: templatePlan,
    templates: [templatePlan],
    definitions: defs,
  };
}

function assertApplyAllowed({ apply, dbName, confirmDb }) {
  if (!apply) return;
  if (!dbName) throw new Error("seed apply requires a connected database name");
  if (!confirmDb || confirmDb !== dbName) {
    throw new Error(`seed apply requires --confirm-db ${dbName}`);
  }
}

/**
 * Read-only plan by default. apply:true requires the exact connected db name.
 */
export async function runSeed({ db, apply = false, confirmDb } = {}) {
  if (!db) throw new Error("runSeed requires a MongoDB Db");
  const dbName = db.databaseName;
  assertApplyAllowed({ apply, dbName, confirmDb });

  const [tenants, departments, templates] = await Promise.all([
    db.collection("tenants").find({}).toArray(),
    db.collection("departments").find({}).toArray(),
    db.collection("templates").find({}).toArray(),
  ]);
  const plan = planSeed({ tenants, departments, templates });
  const applied = [];

  if (apply) {
    if (plan.tenant.action === "create") {
      const result = await db.collection("tenants").updateOne(
        { id: plan.definitions.tenant.id },
        { $setOnInsert: plan.definitions.tenant },
        { upsert: true },
      );
      if (result.upsertedCount) applied.push({ collection: "tenants", id: plan.definitions.tenant.id });
    }
    for (const branchPlan of plan.departments) {
      if (branchPlan.action === "create") {
        const result = await db.collection("departments").updateOne(
          { id: branchPlan.department.id },
          { $setOnInsert: branchPlan.department },
          { upsert: true },
        );
        if (result.upsertedCount) {
          applied.push({ collection: "departments", id: branchPlan.department.id });
        }
        continue;
      }
      if (branchPlan.defaultAction === "set") {
        // Backfill only a missing pointer on an active seeded branch. Never
        // overwrite an administrator-chosen default.
        const result = await db.collection("departments").updateOne(
          {
            id: branchPlan.department.id,
            tenantId: branchPlan.department.tenantId,
            status: { $ne: "inactive" },
            $or: [
              { defaultTemplateId: null },
              { defaultTemplateId: { $exists: false } },
            ],
          },
          {
            $set: {
              defaultTemplateId: branchPlan.department.defaultTemplateId,
              defaultTemplateVersion: branchPlan.department.defaultTemplateVersion,
            },
          },
        );
        if (result.modifiedCount) {
          applied.push({
            collection: "departments",
            id: branchPlan.department.id,
            action: "default",
          });
        }
      }
    }
    if (plan.template.action === "create") {
      const result = await db.collection("templates").updateOne(
        { id: plan.definitions.template.id, version: plan.definitions.template.version ?? 1 },
        { $setOnInsert: plan.definitions.template },
        { upsert: true },
      );
      if (result.upsertedCount) applied.push({ collection: "templates", id: plan.definitions.template.id });
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    db: dbName,
    plan,
    applied,
    assignments: { touched: 0 },
  };
}
