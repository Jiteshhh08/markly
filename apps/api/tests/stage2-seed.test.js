import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectStage2TestDb, disconnectStage2TestDb } from "./helpers/testDb.js";
import { runSeed, seedDefinitions } from "../src/lib/multicollegeSeed.js";

const TEST_DB = "markly_stage2_seed_test";
const SEED_ID = "tcet-computer-engineering";

let db;

async function templates() {
  return db.collection("templates").find({}).toArray();
}

before(async () => {
  db = await connectStage2TestDb(TEST_DB);
  await db.dropDatabase();
});

after(async () => {
  await db?.dropDatabase().catch(() => {});
  await disconnectStage2TestDb();
});

describe("STAGE 2 idempotent TCET seed", () => {
  it("creates the college, branch, and published template on a new install", async () => {
    const result = await runSeed({
      db,
      apply: true,
      confirmDb: db.databaseName,
    });

    assert.equal(result.plan.tenant.action, "create");
    assert.equal(result.plan.department.action, "create");
    assert.equal(result.plan.departments.length, 10);
    assert.equal(result.plan.template.action, "create");
    assert.equal(result.applied.length, 12);

    const tenant = await db.collection("tenants").findOne({ id: "tcet" });
    const department = await db
      .collection("departments")
      .findOne({ id: "tcet-computer-engineering" });
    const template = await db
      .collection("templates")
      .findOne({ id: SEED_ID, version: 1 });

    assert.ok(tenant);
    assert.ok(department);
    assert.ok(template);
    assert.equal(await db.collection("departments").countDocuments({ tenantId: "tcet" }), 10);
    assert.equal(department.defaultTemplateId, SEED_ID);
    assert.equal(department.defaultTemplateVersion, 1);
    assert.equal(template.scope, "college");
    assert.equal(template.tenantId, "tcet");
    assert.equal(template.departmentId, "tcet-computer-engineering");
    assert.equal(template.status, "active");
    assert.equal(template.seedKey, seedDefinitions().template.seedKey);
  });

  it("never overwrites administrator edits or user templates on re-run", async () => {
    const before = await templates();
    const seedTemplate = before.find((doc) => doc.id === SEED_ID && doc.version === 1);
    assert.ok(seedTemplate);

    await db.collection("templates").updateOne(
      { id: SEED_ID, version: 1 },
      {
        $set: {
          name: "Administrator renamed TCET",
          footer: { text: "Administrator footer" },
          status: "draft",
        },
      },
    );
    await db.collection("templates").insertOne({
      id: SEED_ID,
      version: 2,
      name: "Administrator published v2",
      scope: "college",
      tenantId: "tcet",
      departmentId: "tcet-computer-engineering",
      status: "active",
      footer: { text: "Published v2 footer" },
    });
    await db.collection("templates").insertOne({
      id: "stage2-seed-user-template",
      version: 1,
      name: "User template that must survive",
      scope: "private",
      ownerUserId: "usr_stage2_seed_owner",
      status: "active",
    });

    const second = await runSeed({
      db,
      apply: true,
      confirmDb: db.databaseName,
    });
    assert.equal(second.plan.template.action, "skip");
    assert.equal(
      second.applied.some((entry) => entry.collection === "templates"),
      false,
      "an existing template id must never be inserted again",
    );

    const v1 = await db.collection("templates").findOne({ id: SEED_ID, version: 1 });
    const v2 = await db.collection("templates").findOne({ id: SEED_ID, version: 2 });
    const userTemplate = await db
      .collection("templates")
      .findOne({ id: "stage2-seed-user-template" });
    assert.equal(v1.name, "Administrator renamed TCET");
    assert.equal(v1.footer.text, "Administrator footer");
    assert.equal(v1.status, "draft");
    assert.equal(v2.name, "Administrator published v2");
    assert.equal(v2.footer.text, "Published v2 footer");
    assert.equal(userTemplate.name, "User template that must survive");
    assert.equal(await db.collection("templates").countDocuments({ id: SEED_ID }), 2);
  });

  it("does not resurrect v1 when only a newer administrator version exists", async () => {
    await db.collection("templates").deleteOne({ id: SEED_ID, version: 1 });

    const third = await runSeed({
      db,
      apply: true,
      confirmDb: db.databaseName,
    });
    assert.equal(third.plan.template.action, "skip");
    assert.equal(await db.collection("templates").countDocuments({ id: SEED_ID, version: 1 }), 0);
    assert.equal(await db.collection("templates").countDocuments({ id: SEED_ID, version: 2 }), 1);
  });

  it("dry-run reports the plan without writing anything", async () => {
    await db.collection("templates").deleteMany({});
    await db.collection("tenants").deleteMany({ id: "tcet" });
    await db.collection("departments").deleteMany({ tenantId: "tcet" });

    const dry = await runSeed({ db });
    assert.equal(dry.mode, "dry-run");
    assert.equal(dry.plan.departments.length, 10);
    assert.equal(dry.plan.template.action, "create");
    assert.equal(await db.collection("templates").countDocuments({ id: SEED_ID }), 0);
    assert.equal(await db.collection("tenants").countDocuments({ id: "tcet" }), 0);
    assert.equal(await db.collection("departments").countDocuments({ tenantId: "tcet" }), 0);
  });
});
