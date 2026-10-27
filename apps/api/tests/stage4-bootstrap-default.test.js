import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage4-bootstrap-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage4TestDb, disconnectStage4TestDb } from "./helpers/testDb.js";
import { cookieFor, request, startServer, stopServer } from "./helpers/stage2Http.js";
import { runSeed } from "../src/lib/multicollegeSeed.js";

const { default: app } = await import("../src/index.js");
const { Department, Template, Tenant, User } = await import("../src/models/index.js");
const { loadActorById } = await import("../src/lib/roles.js");
const { resolveTemplateForGeneration } = await import("../src/lib/templateResolution.js");

const TEST_DB = "markly_stage4_bootstrap_test";
const OTHER_COLLEGE = "bootstrap-other-college";
const OTHER_BRANCH = "bootstrap-other-branch";
const OTHER_TEMPLATE = "bootstrap-other-default";
const BOOTSTRAP_TEMPLATE = "tcet-computer-engineering";

const NEW_USER = "bootstrap-new-user";
const MEMBER_USER = "bootstrap-member";
const OTHER_USER = "bootstrap-other-user";
const ADMIN_USER = "bootstrap-admin";

const USERS = {
  [NEW_USER]: {
    email: `${NEW_USER}@example.com`,
    name: "Unconfigured User",
    tenantIds: [],
  },
  [MEMBER_USER]: {
    email: `${MEMBER_USER}@example.com`,
    name: "College Member",
    tenantIds: [OTHER_COLLEGE],
  },
  [OTHER_USER]: {
    email: `${OTHER_USER}@example.com`,
    name: "Other College User",
    tenantIds: [],
    preferences: { collegeId: OTHER_COLLEGE, departmentId: OTHER_BRANCH },
  },
  [ADMIN_USER]: {
    email: `${ADMIN_USER}@example.com`,
    name: "Platform Admin",
    role: "platform_admin",
    tenantIds: [],
  },
};

let server;
let base;

function cookie(userId) {
  return cookieFor({ id: userId, email: USERS[userId].email });
}

function listTemplates(userId) {
  return request(base, "GET", "/api/v1/templates", { cookie: cookie(userId) });
}

before(async () => {
  const db = await connectStage4TestDb(TEST_DB);
  await db.dropDatabase();
  await runSeed({ db, apply: true, confirmDb: db.databaseName });

  await Tenant.create({
    id: OTHER_COLLEGE,
    name: "Other College",
    slug: OTHER_COLLEGE,
    status: "active",
  });
  await Department.create({
    id: OTHER_BRANCH,
    tenantId: OTHER_COLLEGE,
    name: "Other Branch",
    status: "active",
    defaultTemplateId: OTHER_TEMPLATE,
    defaultTemplateVersion: 1,
  });
  await Template.create({
    id: OTHER_TEMPLATE,
    version: 1,
    name: "Other College Default",
    scope: "platform",
    status: "active",
    tenantId: null,
    departmentId: null,
  });
  await User.create(
    Object.entries(USERS).map(([id, data]) => ({ id, ...data })),
  );

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  const mongoose = (await import("mongoose")).default;
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await disconnectStage4TestDb();
});

describe("TCET Computer Engineering onboarding default", () => {
  it("marks the TCET Computer Engineering template for an unconfigured user", async () => {
    const res = await listTemplates(NEW_USER);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.bootstrapDefault.id, BOOTSTRAP_TEMPLATE);
    assert.equal(res.data.bootstrapDefault.version, 1);
    assert.equal(res.data.bootstrapDefault.collegeId, "tcet");
    assert.equal(res.data.bootstrapDefault.collegeName, "TCET");
    assert.equal(res.data.bootstrapDefault.branchId, "tcet-computer-engineering");
    assert.equal(res.data.bootstrapDefault.branchName, "Computer Engineering");

    const card = res.data.templates.find((template) => template.id === BOOTSTRAP_TEMPLATE);
    assert.ok(card, "the bootstrap template must be present in the catalogue");
    assert.equal(card.isBootstrapDefault, true);
  });

  it("resolves the bootstrap default for generation and accepts its explicit id", async () => {
    const actor = await loadActorById(NEW_USER);
    assert.ok(actor);

    const resolved = await resolveTemplateForGeneration({ actor });
    assert.equal(resolved.source, "bootstrap_default");
    assert.equal(resolved.template.id, BOOTSTRAP_TEMPLATE);
    assert.equal(resolved.template.version, 1);

    const explicit = await resolveTemplateForGeneration({
      actor,
      templateId: BOOTSTRAP_TEMPLATE,
      templateVersion: 1,
    });
    assert.equal(explicit.source, "explicit");
    assert.equal(explicit.template.id, BOOTSTRAP_TEMPLATE);
  });

  it("does not give the TCET fallback to a college member with no preferences", async () => {
    const res = await listTemplates(MEMBER_USER);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.bootstrapDefault, null);
    assert.equal(
      res.data.templates.some((template) => template.isBootstrapDefault),
      false,
    );

    const actor = await loadActorById(MEMBER_USER);
    await assert.rejects(
      () => resolveTemplateForGeneration({ actor }),
      (err) => err?.code === "preferences_required",
    );
  });

  it("does not give the TCET fallback to a user with another college preference", async () => {
    const res = await listTemplates(OTHER_USER);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.bootstrapDefault, null);
    assert.equal(
      res.data.templates.some((template) => template.id === BOOTSTRAP_TEMPLATE),
      false,
      "another college's catalogue must not expose the TCET template",
    );

    const actor = await loadActorById(OTHER_USER);
    const resolved = await resolveTemplateForGeneration({ actor });
    assert.equal(resolved.source, "branch_default");
    assert.equal(resolved.template.id, OTHER_TEMPLATE);

    await assert.rejects(
      () =>
        resolveTemplateForGeneration({
          actor,
          templateId: BOOTSTRAP_TEMPLATE,
          templateVersion: 1,
        }),
      /unavailable/i,
    );
  });

  it("never marks the bootstrap template for an administrator", async () => {
    const res = await listTemplates(ADMIN_USER);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.bootstrapDefault, null);
    const card = res.data.templates.find((template) => template.id === BOOTSTRAP_TEMPLATE);
    assert.ok(card, "administrators still see the seeded college template normally");
    assert.equal(card.isBootstrapDefault, undefined);
  });

  it("disables the fallback when the Computer Engineering branch is inactive", async () => {
    await Department.updateOne(
      { id: "tcet-computer-engineering" },
      { $set: { status: "inactive" } },
    );
    try {
      const res = await listTemplates(NEW_USER);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.bootstrapDefault, null);
      assert.equal(
        res.data.templates.some((template) => template.isBootstrapDefault),
        false,
      );

      const actor = await loadActorById(NEW_USER);
      await assert.rejects(
        () => resolveTemplateForGeneration({ actor }),
        (err) => err?.code === "preferences_required",
      );
    } finally {
      await Department.updateOne(
        { id: "tcet-computer-engineering" },
        { $set: { status: "active" } },
      );
    }
  });
});
