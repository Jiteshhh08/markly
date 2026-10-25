import { loadTemplates } from "./templates.js";
import { STAGE1_MIGRATION_VERSION } from "./multicollegeMigration.js";

// STAGE 1: idempotent TCET seed.
//
// The seed reuses the existing tenant template file as the source of truth and
// only INSERTS missing documents ($setOnInsert). Re-running never overwrites
// an administrator's edits, never duplicates records and never deletes data.
// It is a CLI/library operation only: nothing here runs at API startup.

export const STAGE1_SEED_KEY = "stage1:tcet";

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
  const department = {
    id: String(seed.department.id),
    tenantId: String(seed.department.tenantId),
    name: String(seed.department.name || seed.department.id),
    status: "active",
    seedKey: `${STAGE1_SEED_KEY}:department`,
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
  return { tenant, department, template };
}

export function planSeed({ tenants = [], departments = [], templates = [] } = {}) {
  const defs = seedDefinitions();
  const tenantExists = tenants.some((doc) => doc.id === defs.tenant.id);
  const departmentExists = departments.some((doc) => doc.id === defs.department.id);
  // STAGE 2: ANY version of the seed template id means the install already has
  // the TCET template. Never insert v1 over an administrator-edited v1 or next
  // to a newer published version; existing installs keep their changes.
  const templateExists = templates.some((doc) => doc.id === defs.template.id);

  return {
    tenant: { action: tenantExists ? "skip" : "create", id: defs.tenant.id },
    department: { action: departmentExists ? "skip" : "create", id: defs.department.id },
    template: { action: templateExists ? "skip" : "create", id: defs.template.id, version: defs.template.version ?? 1 },
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
    if (plan.department.action === "create") {
      const result = await db.collection("departments").updateOne(
        { id: plan.definitions.department.id },
        { $setOnInsert: plan.definitions.department },
        { upsert: true },
      );
      if (result.upsertedCount) applied.push({ collection: "departments", id: plan.definitions.department.id });
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
