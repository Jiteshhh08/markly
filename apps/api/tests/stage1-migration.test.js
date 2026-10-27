import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectStage1TestDb, disconnectStage1TestDb } from "./helpers/testDb.js";
import {
  STAGE1_MIGRATION_VERSION,
  assertApplyAllowed,
  classifyTemplate,
  planTemplateMigration,
  runMigration,
  runRollback,
} from "../src/lib/multicollegeMigration.js";

const PREFIX = "stage1mig_";
let db;

async function cleanup() {
  await db.collection("templates").deleteMany({ id: new RegExp(`^${PREFIX}`) });
  await db.collection("users").deleteMany({ id: new RegExp(`^${PREFIX}`) });
  await db.collection("assignments").deleteMany({ recordId: new RegExp(`^${PREFIX}`) });
}

before(async () => {
  db = await connectStage1TestDb("markly_stage1_migration_test");
  await cleanup();
});

after(async () => {
  await cleanup().catch(() => {});
  await disconnectStage1TestDb();
});

function template(id, extra = {}) {
  return {
    id: `${PREFIX}${id}`,
    name: `Fixture ${id}`,
    version: 1,
    page: { size: "A4", margin: { top: "1mm" } },
    typography: { fontFamily: "Fixture Serif", baseSize: "11pt", lineHeight: 1.4 },
    ...extra,
  };
}

async function seedFixtures() {
  await cleanup();
  await db.collection("templates").insertMany([
    template("college_from_tenant", { tenantId: "college-a", departmentId: "dept-a1" }),
    template("private_from_owner", { ownerUserId: "usr_owner" }),
    template("unknown_owner"),
    template("unknown_scope_with_tenant", { scope: "shared", tenantId: "college-a" }),
    template("college_without_tenant", { scope: "college" }),
    template("private_without_owner", { scope: "private" }),
    template("already_scoped", { scope: "college", tenantId: "college-a" }),
    template("already_migrated", { migrationStage1: { version: STAGE1_MIGRATION_VERSION, runId: "old" } }),
    template("explicit_legacy", { scope: "legacy" }),
  ]);
  await db.collection("users").insertMany([
    { id: `${PREFIX}user_norole`, email: "stage1mig-norole@example.com" },
    { id: `${PREFIX}user_invalid`, email: "stage1mig-invalid@example.com", role: "superadmin" },
    { id: `${PREFIX}user_platform`, email: "stage1mig-platform@example.com", role: "platform_admin" },
    {
      id: `${PREFIX}user_college_admin`,
      email: "stage1mig-college@example.com",
      role: "college_admin",
      collegeAdminOf: ["college-a"],
    },
    {
      id: `${PREFIX}user_already_migrated`,
      email: "stage1mig-migrated@example.com",
      migrationStage1: { version: STAGE1_MIGRATION_VERSION, runId: "old" },
    },
  ]);
  await db.collection("assignments").insertOne({
    recordId: `${PREFIX}assignment_legacy`,
    userId: "usr_owner",
    data: {
      id: `${PREFIX}assignment_legacy`,
      generatedContent: { title: "Legacy content" },
      template: { id: "legacy-tpl", version: 1 },
    },
    legacyOnly: true,
  });
}

describe("STAGE 1 multi-college migration safety", () => {
  it("classifies ownership without inventing ids and keeps explicit data", () => {
    assert.deepEqual(
      (({ scope, legacyUnscoped, needsReview }) => ({ scope, legacyUnscoped, needsReview }))(classifyTemplate({})),
      { scope: "legacy", legacyUnscoped: true, needsReview: true },
    );
    assert.equal(classifyTemplate({ tenantId: "college-a" }).scope, "college");
    assert.equal(classifyTemplate({ ownerUserId: "usr_owner" }).scope, "private");
    assert.equal(classifyTemplate({ scope: "college" }).scope, "legacy");
    assert.equal(classifyTemplate({ scope: "private" }).scope, "legacy");
    assert.equal(classifyTemplate({ scope: "platform", tenantId: "college-a" }).needsReview, true);
    assert.equal(classifyTemplate({ scope: "shared", tenantId: "college-a" }).needsReview, true);
  });

  it("keeps already migrated documents out of the plan", () => {
    const plan = planTemplateMigration({
      id: "tpl",
      migrationStage1: { version: STAGE1_MIGRATION_VERSION, runId: "old" },
    });
    assert.equal(plan.action, "skip");
    assert.equal(plan.reason, "already migrated");
  });

  it("requires explicit apply confirmation and never deletes/rewrites assignments", async () => {
    await seedFixtures();
    const beforeCounts = {
      templates: await db.collection("templates").countDocuments({}),
      users: await db.collection("users").countDocuments({}),
      assignments: await db.collection("assignments").countDocuments({}),
    };
    const assignmentBefore = await db.collection("assignments").findOne({ recordId: `${PREFIX}assignment_legacy` });

    const dryRun = await runMigration({ db });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.assignments.rewritten, 0);
    assert.equal((await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` })).scope, undefined);
    assert.equal((await db.collection("users").findOne({ id: `${PREFIX}user_norole` })).role, undefined);

    await assert.rejects(
      () => runMigration({ db, apply: true, confirmDb: "wrong-db" }),
      /confirm-db/,
    );
    assert.equal((await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` })).scope, undefined);

    const runId = "run_stage1_migration_1";
    const applied = await runMigration({ db, apply: true, confirmDb: db.databaseName, runId });
    assert.equal(applied.mode, "apply");
    assert.ok(applied.applied.length >= 7, JSON.stringify(applied.applied));

    const college = await db.collection("templates").findOne({ id: `${PREFIX}college_from_tenant` });
    assert.equal(college.scope, "college");
    assert.equal(college.legacyUnscoped, false);
    assert.equal(college.needsReview, false);
    assert.equal(college.migrationStage1.runId, runId);
    assert.deepEqual(college.migrationStage1.had, []);
    assert.deepEqual(college.page, { size: "A4", margin: { top: "1mm" } }, "formatting must be untouched");
    assert.equal(college.tenantId, "college-a");

    const privateFromOwner = await db.collection("templates").findOne({ id: `${PREFIX}private_from_owner` });
    assert.equal(privateFromOwner.scope, "private");
    assert.equal(privateFromOwner.ownerUserId, "usr_owner");

    const unknown = await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` });
    assert.equal(unknown.scope, "legacy");
    assert.equal(unknown.legacyUnscoped, true);
    assert.equal(unknown.needsReview, true);
    assert.equal(unknown.tenantId, undefined, "college id must not be invented");

    const unknownScope = await db.collection("templates").findOne({ id: `${PREFIX}unknown_scope_with_tenant` });
    assert.equal(unknownScope.scope, "college");
    assert.equal(unknownScope.needsReview, true);

    const collegeNoTenant = await db.collection("templates").findOne({ id: `${PREFIX}college_without_tenant` });
    assert.equal(collegeNoTenant.scope, "legacy");
    assert.equal(collegeNoTenant.legacyUnscoped, true);

    const privateNoOwner = await db.collection("templates").findOne({ id: `${PREFIX}private_without_owner` });
    assert.equal(privateNoOwner.scope, "legacy");
    assert.equal(privateNoOwner.ownerUserId, undefined, "owner must not be invented");

    const alreadyScoped = await db.collection("templates").findOne({ id: `${PREFIX}already_scoped` });
    assert.equal(alreadyScoped.migrationStage1, undefined, "no write for an already-correct document");

    const alreadyMigrated = await db.collection("templates").findOne({ id: `${PREFIX}already_migrated` });
    assert.equal(alreadyMigrated.migrationStage1.runId, "old");

    const explicitLegacy = await db.collection("templates").findOne({ id: `${PREFIX}explicit_legacy` });
    assert.equal(explicitLegacy.scope, "legacy");
    assert.equal(explicitLegacy.legacyUnscoped, true);

    const noRole = await db.collection("users").findOne({ id: `${PREFIX}user_norole` });
    assert.equal(noRole.role, "user");
    assert.equal(noRole.migrationStage1.runId, runId);
    const invalidRole = await db.collection("users").findOne({ id: `${PREFIX}user_invalid` });
    assert.equal(invalidRole.role, "user");
    assert.deepEqual(invalidRole.migrationStage1.previous, { role: "superadmin" });
    const platformUser = await db.collection("users").findOne({ id: `${PREFIX}user_platform` });
    assert.equal(platformUser.role, "platform_admin");
    assert.equal(platformUser.migrationStage1, undefined);
    const collegeAdmin = await db.collection("users").findOne({ id: `${PREFIX}user_college_admin` });
    assert.deepEqual(collegeAdmin.collegeAdminOf, ["college-a"]);
    assert.equal(collegeAdmin.role, "college_admin");

    const assignmentAfter = await db.collection("assignments").findOne({ recordId: `${PREFIX}assignment_legacy` });
    assert.deepEqual(assignmentAfter, assignmentBefore, "assignments are never rewritten");
    assert.equal(assignmentAfter.documentSchemaVersion, undefined);

    assert.deepEqual(
      {
        templates: await db.collection("templates").countDocuments({}),
        users: await db.collection("users").countDocuments({}),
        assignments: await db.collection("assignments").countDocuments({}),
      },
      beforeCounts,
      "migration must never delete documents",
    );

    const second = await runMigration({ db, apply: true, confirmDb: db.databaseName, runId: "run_stage1_migration_2" });
    assert.equal(second.applied.length, 0, "second apply must be a no-op");
    assert.equal(
      (await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` })).migrationStage1.runId,
      runId,
      "idempotent rerun must not overwrite the original run metadata",
    );
  });

  it("rolls back only the fields recorded by the run and documents its limits", async () => {
    const runId = "run_stage1_migration_1";
    const dryRun = await runRollback({ db, runId });
    assert.equal(dryRun.mode, "rollback-dry-run");
    assert.ok(dryRun.plan.some((entry) => entry.action === "would-rollback"));
    assert.equal((await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` })).scope, "legacy");

    await assert.rejects(
      () => runRollback({ db, runId, apply: true, confirmDb: "wrong-db" }),
      /confirm-db/,
    );

    const rolledBack = await runRollback({ db, runId, apply: true, confirmDb: db.databaseName });
    assert.equal(rolledBack.mode, "rollback");
    assert.ok(rolledBack.applied.length >= 7);
    assert.ok(rolledBack.limitations.some((line) => line.includes("edited after the run")));

    const unknown = await db.collection("templates").findOne({ id: `${PREFIX}unknown_owner` });
    assert.equal(unknown.scope, undefined);
    assert.equal(unknown.legacyUnscoped, undefined);
    assert.equal(unknown.needsReview, undefined);
    assert.equal(unknown.migrationStage1, undefined);

    const college = await db.collection("templates").findOne({ id: `${PREFIX}college_from_tenant` });
    assert.equal(college.scope, undefined);
    assert.equal(college.tenantId, "college-a");
    assert.deepEqual(college.page, { size: "A4", margin: { top: "1mm" } });

    const noRole = await db.collection("users").findOne({ id: `${PREFIX}user_norole` });
    assert.equal(noRole.role, undefined);
    const invalidRole = await db.collection("users").findOne({ id: `${PREFIX}user_invalid` });
    assert.equal(invalidRole.role, "superadmin");
    assert.equal(invalidRole.migrationStage1, undefined);

    const assignment = await db.collection("assignments").findOne({ recordId: `${PREFIX}assignment_legacy` });
    assert.equal(assignment.documentSchemaVersion, undefined);
    assert.equal(assignment.data.generatedContent.title, "Legacy content");
  });

  it("skips rollback for documents edited after the migration run", async () => {
    const runId = "run_stage1_migration_3";
    await runMigration({ db, apply: true, confirmDb: db.databaseName, runId });

    const id = `${PREFIX}unknown_owner`;
    await db.collection("templates").updateOne({ id }, { $set: { scope: "platform" } });

    const rollback = await runRollback({ db, runId, apply: true, confirmDb: db.databaseName });
    const skipped = rollback.plan.find((entry) => entry.id === id);
    assert.equal(skipped.action, "skip");
    assert.match(skipped.reason, /no longer matches/);
    assert.equal((await db.collection("templates").findOne({ id })).scope, "platform");

    const college = await db.collection("templates").findOne({ id: `${PREFIX}college_from_tenant` });
    assert.equal(college.scope, undefined, "unmodified documents still roll back");
  });

  it("validates confirmation inputs directly", () => {
    assert.doesNotThrow(() => assertApplyAllowed({ apply: false, dbName: "db", confirmDb: undefined }));
    assert.throws(() => assertApplyAllowed({ apply: true, dbName: "db" }), /confirm-db/);
    assert.throws(() => assertApplyAllowed({ apply: true, dbName: "db", confirmDb: "other" }), /confirm-db/);
    assert.doesNotThrow(() => assertApplyAllowed({ apply: true, dbName: "db", confirmDb: "db" }));
  });
});
