import { TEMPLATE_SCOPES } from "./templateAccess.js";

// STAGE 1: multi-college migration planner/applier.
//
// SAFETY CONTRACT
// - Dry-run is the default; callers must pass apply:true AND an exact
//   confirmDb matching the connected database before any write.
// - This module never runs during API startup and never deletes documents.
// - It does not inspect or infer production data. The CLI is explicit and
//   fail-closed; tests run only against isolated *_stage1*_test databases.
// - Unknown template ownership becomes the explicit `legacy` scope with
//   legacyUnscoped/needsReview flags. College ids, branch ids, owners and
//   template formatting are NEVER invented.
// - Assignments are not rewritten. Legacy assignments are normalized on read
//   by documentModel.js; this migration only reports them as read-only.
// - Idempotent: a document carrying this migration version is skipped.
//
// ROLLBACK LIMITATIONS (also documented in docs/stage1-multicollege.md)
// - Rollback restores only fields recorded in migrationStage1.previous for
//   this exact run. It refuses to overwrite a document whose current values
//   differ from what this run applied (e.g. an admin edited it afterwards).
// - It cannot restore deleted documents, undo seed data, or reverse changes
//   made by other tools. It never touches assignment content.

export const STAGE1_MIGRATION_VERSION = 1;

function validScope(value) {
  return TEMPLATE_SCOPES.includes(value);
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function changedFields(doc, updates) {
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    if (doc[key] !== value) changed.push(key);
  }
  return changed;
}

/**
 * Classify one template without writing anything.
 * Explicit scope + explicit tenant/owner is kept. Missing scope is derived
 * ONLY from explicit tenantId/ownerUserId. Anything else is legacy/review.
 */
export function classifyTemplate(template = {}) {
  const scope = validScope(template.scope) ? template.scope : null;
  const tenantId = template.tenantId ?? null;
  const ownerUserId = template.ownerUserId ?? null;
  const unknownScope = template.scope !== undefined && template.scope !== null && !validScope(template.scope);

  if (scope === "college") {
    if (!tenantId) {
      return { scope: "legacy", legacyUnscoped: true, needsReview: true, reason: "college scope without tenantId" };
    }
    return { scope, legacyUnscoped: false, needsReview: false, reason: "explicit college scope" };
  }

  if (scope === "private") {
    if (!ownerUserId) {
      return { scope: "legacy", legacyUnscoped: true, needsReview: true, reason: "private scope without ownerUserId" };
    }
    return { scope, legacyUnscoped: false, needsReview: false, reason: "explicit private scope" };
  }

  if (scope === "platform") {
    // A platform template tied to a tenant is still platform-owned, but it
    // deserves review because the extra college id may be stale.
    return {
      scope,
      legacyUnscoped: false,
      needsReview: Boolean(tenantId),
      reason: tenantId ? "platform scope with tenantId (review)" : "explicit platform scope",
    };
  }

  if (scope === "legacy") {
    return {
      scope,
      legacyUnscoped: true,
      needsReview: true,
      reason: "explicit legacy scope",
    };
  }

  // No usable scope: derive only from explicit ownership, never from names.
  if (tenantId) {
    return {
      scope: "college",
      legacyUnscoped: false,
      needsReview: unknownScope,
      reason: unknownScope ? "unknown scope with explicit tenantId (review)" : "explicit tenantId",
    };
  }
  if (ownerUserId) {
    return {
      scope: "private",
      legacyUnscoped: false,
      needsReview: unknownScope,
      reason: unknownScope ? "unknown scope with explicit ownerUserId (review)" : "explicit ownerUserId",
    };
  }
  return {
    scope: "legacy",
    legacyUnscoped: true,
    needsReview: true,
    reason: unknownScope ? "unknown scope" : "unknown ownership",
  };
}

export function planTemplateMigration(template = {}) {
  const target = classifyTemplate(template);
  const updates = {};
  const scopeChanged = template.scope !== target.scope;
  if (scopeChanged) {
    updates.scope = target.scope;
    // Newly scoped documents get explicit flags so later queries never have to
    // guess. Already-correct documents are left untouched.
    updates.legacyUnscoped = target.legacyUnscoped;
    updates.needsReview = target.needsReview;
  } else {
    if (target.legacyUnscoped && template.legacyUnscoped !== true) updates.legacyUnscoped = true;
    if (target.needsReview && template.needsReview !== true) updates.needsReview = true;
    if (!target.legacyUnscoped && template.legacyUnscoped === true) updates.legacyUnscoped = false;
    if (!target.needsReview && template.needsReview === true) updates.needsReview = false;
  }

  const alreadyMigrated = template.migrationStage1?.version === STAGE1_MIGRATION_VERSION;
  const changed = changedFields(template, updates);

  return {
    id: template.id ?? (template._id ? String(template._id) : null),
    name: template.name ?? null,
    action: alreadyMigrated || changed.length === 0 ? "skip" : "update",
    reason: alreadyMigrated ? "already migrated" : changed.length === 0 ? target.reason : target.reason,
    currentScope: template.scope ?? null,
    targetScope: target.scope,
    legacyUnscoped: target.legacyUnscoped,
    needsReview: target.needsReview,
    updates: changed.length ? updates : {},
    changed,
  };
}

export function planUserMigration(user = {}) {
  const role = user.role;
  const roleValid = ["user", "college_admin", "platform_admin"].includes(role);
  const alreadyMigrated = user.migrationStage1?.version === STAGE1_MIGRATION_VERSION;

  if (roleValid || alreadyMigrated) {
    return {
      id: user.id ?? (user._id ? String(user._id) : null),
      email: user.email ?? null,
      action: "skip",
      reason: roleValid ? "role already set" : "already migrated",
      currentRole: role ?? null,
      targetRole: roleValid ? role : null,
      updates: {},
      changed: [],
    };
  }

  // Missing/invalid roles become the least-privileged role. Never elevate.
  return {
    id: user.id ?? (user._id ? String(user._id) : null),
    email: user.email ?? null,
    action: "update",
    reason: role === undefined || role === null ? "missing role" : "invalid role",
    currentRole: role ?? null,
    targetRole: "user",
    updates: { role: "user" },
    changed: ["role"],
  };
}

export function planMigration({ templates = [], users = [] } = {}) {
  const templatePlans = templates.map(planTemplateMigration);
  const userPlans = users.map(planUserMigration);
  return {
    version: STAGE1_MIGRATION_VERSION,
    templates: templatePlans,
    users: userPlans,
    summary: {
      templates: {
        update: templatePlans.filter((p) => p.action === "update").length,
        skip: templatePlans.filter((p) => p.action === "skip").length,
      },
      users: {
        update: userPlans.filter((p) => p.action === "update").length,
        skip: userPlans.filter((p) => p.action === "skip").length,
      },
      assignments: "read-only (normalized on read; never rewritten)",
    },
  };
}

export function assertApplyAllowed({ apply = false, dbName, confirmDb } = {}) {
  if (!apply) return;
  if (!dbName) throw new Error("apply requires a connected database name");
  if (!confirmDb || confirmDb !== dbName) {
    throw new Error(`apply requires --confirm-db ${dbName}`);
  }
}

function previousValues(doc, keys) {
  const previous = {};
  const had = [];
  for (const key of keys) {
    previous[key] = doc[key] ?? null;
    if (hasOwn(doc, key) && doc[key] !== undefined) had.push(key);
  }
  return { previous, had };
}

function appliedValues(updates) {
  return { ...updates };
}

function migrationMetadata(doc, updates, runId, now) {
  const keys = Object.keys(updates);
  const { previous, had } = previousValues(doc, keys);
  return {
    version: STAGE1_MIGRATION_VERSION,
    runId,
    appliedAt: now,
    previous,
    had,
    applied: appliedValues(updates),
  };
}

function assertNoDeletes() {
  // Kept as an explicit, auditable guard: this module has no delete paths.
  return true;
}

/**
 * Read-only plan by default. Pass apply:true and a matching confirmDb to write.
 * `db` is a native MongoDB Db (or compatible object with collections).
 */
export async function runMigration({
  db,
  apply = false,
  confirmDb,
  runId = `mig_stage1_${Date.now()}`,
  now = new Date(),
} = {}) {
  if (!db) throw new Error("runMigration requires a MongoDB Db");
  const dbName = db.databaseName;
  assertApplyAllowed({ apply, dbName, confirmDb });
  assertNoDeletes();

  const templates = await db.collection("templates").find({}).toArray();
  const users = await db.collection("users").find({}).toArray();
  const plan = planMigration({ templates, users });
  const applied = [];

  if (apply) {
    for (let i = 0; i < templates.length; i += 1) {
      const doc = templates[i];
      const item = plan.templates[i];
      if (item.action !== "update") continue;

      const metadata = migrationMetadata(doc, item.updates, runId, now);
      const result = await db.collection("templates").updateOne(
        { _id: doc._id, "migrationStage1.version": { $ne: STAGE1_MIGRATION_VERSION } },
        { $set: { ...item.updates, migrationStage1: metadata } },
      );
      if (result.modifiedCount) applied.push({ collection: "templates", id: item.id, fields: item.changed });
    }

    for (let i = 0; i < users.length; i += 1) {
      const doc = users[i];
      const item = plan.users[i];
      if (item.action !== "update") continue;

      const metadata = migrationMetadata(doc, item.updates, runId, now);
      const result = await db.collection("users").updateOne(
        { _id: doc._id, "migrationStage1.version": { $ne: STAGE1_MIGRATION_VERSION } },
        { $set: { ...item.updates, migrationStage1: metadata } },
      );
      if (result.modifiedCount) applied.push({ collection: "users", id: item.id, fields: item.changed });
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    db: dbName,
    runId: apply ? runId : null,
    plan,
    applied,
    assignments: { readOnly: true, rewritten: 0 },
  };
}

function rollbackUpdate(doc) {
  const meta = doc.migrationStage1 ?? {};
  const changed = Array.isArray(meta.had) ? meta.had : Object.keys(meta.previous ?? {});
  const set = {};
  const unset = { migrationStage1: "" };

  for (const key of Object.keys(meta.applied ?? {})) {
    if (meta.applied[key] !== doc[key]) {
      return { skip: `current ${key} no longer matches the applied value` };
    }
  }

  for (const [key, value] of Object.entries(meta.previous ?? {})) {
    if (changed.includes(key)) set[key] = value;
    else unset[key] = "";
  }
  return { set, unset };
}

/**
 * Roll back one migration run. Dry-run by default. Skips documents whose
 * current values were edited after the run (never overwrites newer work).
 */
export async function runRollback({
  db,
  runId,
  apply = false,
  confirmDb,
  now = new Date(),
} = {}) {
  if (!db) throw new Error("runRollback requires a MongoDB Db");
  if (!runId) throw new Error("runRollback requires a runId");
  const dbName = db.databaseName;
  assertApplyAllowed({ apply, dbName, confirmDb });

  const plan = [];
  const applied = [];
  for (const collection of ["templates", "users"]) {
    const docs = await db.collection(collection).find({ "migrationStage1.runId": runId }).toArray();
    for (const doc of docs) {
      const update = rollbackUpdate(doc);
      if (update.skip) {
        plan.push({ collection, id: doc.id ?? String(doc._id), action: "skip", reason: update.skip });
        continue;
      }
      plan.push({
        collection,
        id: doc.id ?? String(doc._id),
        action: apply ? "rollback" : "would-rollback",
        set: update.set,
        unset: Object.keys(update.unset),
      });
      if (apply) {
        const result = await db.collection(collection).updateOne(
          { _id: doc._id, "migrationStage1.runId": runId },
          { $set: update.set, $unset: update.unset },
        );
        if (result.modifiedCount) applied.push({ collection, id: doc.id ?? String(doc._id) });
      }
    }
  }

  return {
    mode: apply ? "rollback" : "rollback-dry-run",
    db: dbName,
    runId,
    at: now,
    plan,
    applied,
    limitations: [
      "Only fields recorded by this run are restored.",
      "Documents edited after the run are skipped, not overwritten.",
      "Deleted documents, seed data and assignment content are not restored.",
    ],
  };
}
