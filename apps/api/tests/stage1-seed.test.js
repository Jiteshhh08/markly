import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectStage1TestDb, disconnectStage1TestDb } from "./helpers/testDb.js";
import { planSeed, runSeed, seedDefinitions } from "../src/lib/multicollegeSeed.js";

let db;

async function cleanup() {
  await db.collection("tenants").deleteMany({ id: "tcet" });
  await db.collection("departments").deleteMany({ id: "tcet-computer-engineering" });
  await db.collection("templates").deleteMany({ id: "tcet-computer-engineering", version: 1 });
  await db.collection("assignments").deleteMany({ recordId: /^stage1seed_/ });
}

before(async () => {
  db = await connectStage1TestDb("markly_stage1_seed_test");
  await cleanup();
});

after(async () => {
  await cleanup().catch(() => {});
  await disconnectStage1TestDb();
});

function hasDollarKey(value) {
  if (Array.isArray(value)) return value.some(hasDollarKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key.startsWith("$") || hasDollarKey(child));
}

describe("STAGE 1 idempotent multicollege seed", () => {
  it("defines explicit TCET college/branch/template ownership from the existing seed file", () => {
    const defs = seedDefinitions();
    assert.equal(defs.tenant.id, "tcet");
    assert.equal(defs.tenant.slug, "tcet");
    assert.equal(defs.department.id, "tcet-computer-engineering");
    assert.equal(defs.department.tenantId, "tcet");
    assert.equal(defs.template.id, "tcet-computer-engineering");
    assert.equal(defs.template.tenantId, "tcet");
    assert.equal(defs.template.departmentId, "tcet-computer-engineering");
    assert.equal(defs.template.scope, "college");
    assert.equal(defs.template.ownerUserId, null);
    assert.equal(defs.template.page.size, "A4");
    assert.equal(defs.template.typography.baseSize, "12pt");
    assert.equal(hasDollarKey(defs.template), false, "Mongo comment metadata must be stripped");
  });

  it("dry-runs by default and requires the exact database name to write", async () => {
    await cleanup();
    const dryRun = await runSeed({ db });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.plan.tenant.action, "create");
    assert.equal(dryRun.plan.department.action, "create");
    assert.equal(dryRun.plan.template.action, "create");
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 0);

    await assert.rejects(
      () => runSeed({ db, apply: true, confirmDb: "not-this-db" }),
      /confirm-db/,
    );
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 0);
  });

  it("applies once, is idempotent, and never overwrites admin edits", async () => {
    const assignmentBefore = {
      recordId: "stage1seed_assignment",
      userId: "usr_seed",
      data: { id: "stage1seed_assignment", generatedContent: { title: "Seed untouched" } },
    };
    await db.collection("assignments").insertOne(assignmentBefore);

    const first = await runSeed({ db, apply: true, confirmDb: db.databaseName });
    assert.equal(first.mode, "apply");
    assert.equal(first.applied.length, 3);
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 1);
    assert.equal(await db.collection("departments").countDocuments({ id: "tcet-computer-engineering" }), 1);
    assert.equal(
      await db.collection("templates").countDocuments({ id: "tcet-computer-engineering", version: 1 }),
      1,
    );

    const tenant = await db.collection("tenants").findOne({ id: "tcet" });
    assert.equal(tenant.seedKey, "stage1:tcet:college");
    assert.equal(tenant.status, "active");
    const department = await db.collection("departments").findOne({ id: "tcet-computer-engineering" });
    assert.equal(department.tenantId, "tcet");
    assert.equal(department.seedKey, "stage1:tcet:department");
    const template = await db.collection("templates").findOne({ id: "tcet-computer-engineering", version: 1 });
    assert.equal(template.scope, "college");
    assert.equal(template.ownerUserId, null);
    assert.equal(template.isSeed, true);
    assert.equal(template.legacyUnscoped, false);
    assert.equal(template.needsReview, false);
    assert.equal(template.page.size, "A4");
    assert.equal(template.typography.fontFamily, "Georgia, 'Times New Roman', serif");
    assert.equal(hasDollarKey(template), false);

    const second = await runSeed({ db, apply: true, confirmDb: db.databaseName });
    assert.equal(second.applied.length, 0, "second seed must be a no-op");
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 1);
    assert.equal(await db.collection("templates").countDocuments({ id: "tcet-computer-engineering" }), 1);

    await db.collection("tenants").updateOne({ id: "tcet" }, { $set: { name: "Admin edited TCET" } });
    await runSeed({ db, apply: true, confirmDb: db.databaseName });
    const edited = await db.collection("tenants").findOne({ id: "tcet" });
    assert.equal(edited.name, "Admin edited TCET", "seed must not overwrite admin edits");

    const assignmentAfter = await db.collection("assignments").findOne({ recordId: "stage1seed_assignment" });
    assert.deepEqual(assignmentAfter, assignmentBefore, "seed must not touch assignments");

    const plan = planSeed({
      tenants: [tenant],
      departments: [department],
      templates: [template],
    });
    assert.equal(plan.tenant.action, "skip");
    assert.equal(plan.department.action, "skip");
    assert.equal(plan.template.action, "skip");
  });
});
