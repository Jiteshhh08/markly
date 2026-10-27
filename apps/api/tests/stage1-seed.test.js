import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectStage1TestDb, disconnectStage1TestDb } from "./helpers/testDb.js";
import { runSeed, seedDefinitions } from "../src/lib/multicollegeSeed.js";

let db;

async function cleanup() {
  await db.collection("tenants").deleteMany({ id: "tcet" });
  await db.collection("departments").deleteMany({ tenantId: "tcet" });
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
    assert.equal(defs.department.defaultTemplateId, "tcet-computer-engineering");
    assert.equal(defs.department.defaultTemplateVersion, 1);
    assert.equal(defs.template.id, "tcet-computer-engineering");
    assert.equal(defs.template.tenantId, "tcet");
    assert.equal(defs.template.departmentId, "tcet-computer-engineering");
    assert.equal(defs.template.scope, "college");
    assert.equal(defs.template.ownerUserId, null);
    assert.equal(defs.template.page.size, "A4");
    assert.equal(defs.template.typography.baseSize, "12pt");
    assert.equal(hasDollarKey(defs.template), false, "Mongo comment metadata must be stripped");

    assert.equal(defs.departments.length, 10);
    assert.deepEqual(
      defs.departments.map((department) => department.name),
      [
        "Computer Engineering",
        "Information Technology",
        "Electronics & Telecommunication Engineering",
        "Electronics and Computer Science",
        "Mechanical Engineering",
        "Civil Engineering",
        "Artificial Intelligence & Machine Learning (AI & ML)",
        "Artificial Intelligence & Data Science (AI & DS)",
        "Computer Science and Engineering (Internet of Things / IoT)",
        "Computer Science and Engineering (Cyber Security)",
      ],
    );
    assert.equal(
      defs.departments.filter((department) => department.defaultTemplateId).length,
      1,
      "only the Computer Engineering branch is the seeded default",
    );
  });

  it("dry-runs by default and requires the exact database name to write", async () => {
    await cleanup();
    const dryRun = await runSeed({ db });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.plan.tenant.action, "create");
    assert.equal(dryRun.plan.department.action, "create");
    assert.equal(dryRun.plan.departments.length, 10);
    assert.equal(dryRun.plan.departments.every((branch) => branch.action === "create"), true);
    assert.equal(dryRun.plan.template.action, "create");
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 0);
    assert.equal(await db.collection("departments").countDocuments({ tenantId: "tcet" }), 0);

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
    assert.equal(first.applied.length, 12);
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 1);
    assert.equal(await db.collection("departments").countDocuments({ tenantId: "tcet" }), 10);
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
    assert.equal(department.defaultTemplateId, "tcet-computer-engineering");
    assert.equal(department.defaultTemplateVersion, 1);
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
  });

  it("backfills missing branches and a missing Computer Engineering default without overwriting an admin choice", async () => {
    await db.collection("departments").deleteOne({ id: "tcet-information-technology" });
    await db.collection("departments").updateOne(
      { id: "tcet-computer-engineering" },
      { $unset: { defaultTemplateId: "", defaultTemplateVersion: "" } },
    );

    const backfill = await runSeed({ db, apply: true, confirmDb: db.databaseName });
    assert.ok(
      backfill.applied.some(
        (entry) =>
          entry.collection === "departments" &&
          entry.id === "tcet-information-technology",
      ),
      JSON.stringify(backfill.applied),
    );
    assert.ok(
      backfill.applied.some(
        (entry) =>
          entry.collection === "departments" &&
          entry.id === "tcet-computer-engineering" &&
          entry.action === "default",
      ),
      JSON.stringify(backfill.applied),
    );
    const restored = await db
      .collection("departments")
      .findOne({ id: "tcet-computer-engineering" });
    assert.equal(restored.defaultTemplateId, "tcet-computer-engineering");
    assert.equal(restored.defaultTemplateVersion, 1);

    await db.collection("departments").updateOne(
      { id: "tcet-computer-engineering" },
      { $set: { defaultTemplateId: "admin-chosen-template", defaultTemplateVersion: 7 } },
    );
    const preserved = await runSeed({ db, apply: true, confirmDb: db.databaseName });
    assert.equal(
      preserved.applied.some(
        (entry) =>
          entry.collection === "departments" &&
          entry.id === "tcet-computer-engineering" &&
          entry.action === "default",
      ),
      false,
      "an administrator-chosen default must never be overwritten",
    );
    const chosen = await db
      .collection("departments")
      .findOne({ id: "tcet-computer-engineering" });
    assert.equal(chosen.defaultTemplateId, "admin-chosen-template");
    assert.equal(chosen.defaultTemplateVersion, 7);
  });
});
