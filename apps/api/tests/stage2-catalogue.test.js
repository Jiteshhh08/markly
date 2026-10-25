import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
// Open reads let us exercise the anonymous catalogue. Authenticated requests
// still carry signed cookies and are authorized from the persisted user.
process.env.AUTH_REQUIRED = "0";
process.env.JWT_SECRET = "stage2-catalogue-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage2TestDb, disconnectStage2TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { Department, Tenant, User } = await import("../src/models/index.js");
const { createTemplatePersisted } = await import("../src/lib/templateStore.js");
const { startServer, stopServer, cookieFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage2_catalogue_test";

let db;
let server;
let base;
let platformAdmin;
let collegeAdminA;
let ordinaryA;
let ordinaryAMember;
let ordinaryAPrefOnly;
let ordinaryB;

const ids = {
  platformPublished: "stage2-catalogue-platform-published",
  platformDraft: "stage2-catalogue-platform-draft",
  platformArchived: "stage2-catalogue-platform-archived",
  aPublishedA1: "stage2-catalogue-a-published-a1",
  aDraftA1: "stage2-catalogue-a-draft-a1",
  aPublishedA2: "stage2-catalogue-a-published-a2",
  aPublishedNoBranch: "stage2-catalogue-a-published-nobranch",
  bPublishedB1: "stage2-catalogue-b-published-b1",
  privateA: "stage2-catalogue-private-a",
  privateB: "stage2-catalogue-private-b",
  legacy: "stage2-catalogue-legacy",
};

function cookie(user) {
  return cookieFor(user);
}

function listIds(response) {
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.templates.map((template) => template.id);
}

function assertIncludes(list, expected, message) {
  for (const id of expected) assert.equal(list.includes(id), true, `${message}: missing ${id}`);
}

function assertExcludes(list, unexpected, message) {
  for (const id of unexpected) assert.equal(list.includes(id), false, `${message}: leaked ${id}`);
}

before(async () => {
  db = await connectStage2TestDb(TEST_DB);
  await db.dropDatabase();

  await Tenant.create([
    { id: "college-a", name: "College A" },
    { id: "college-b", name: "College B" },
  ]);
  await Department.create([
    { id: "dept-a1", tenantId: "college-a", name: "A Branch 1" },
    { id: "dept-a2", tenantId: "college-a", name: "A Branch 2" },
    { id: "dept-b1", tenantId: "college-b", name: "B Branch 1" },
  ]);

  platformAdmin = await User.create({
    id: "usr_stage2_catalogue_platform",
    email: "stage2-catalogue-platform@example.com",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: "usr_stage2_catalogue_college_admin_a",
    email: "stage2-catalogue-college-admin-a@example.com",
    role: "college_admin",
    collegeAdminOf: ["college-a"],
  });
  ordinaryA = await User.create({
    id: "usr_stage2_catalogue_ordinary_a",
    email: "stage2-catalogue-ordinary-a@example.com",
    role: "user",
    tenantIds: ["college-a"],
    preferences: { collegeId: "college-a", departmentId: "dept-a1" },
  });
  ordinaryAMember = await User.create({
    id: "usr_stage2_catalogue_ordinary_a_member",
    email: "stage2-catalogue-ordinary-a-member@example.com",
    role: "user",
    tenantIds: ["college-a"],
  });
  // Preferences without tenant membership: branch-specific authorization.
  ordinaryAPrefOnly = await User.create({
    id: "usr_stage2_catalogue_ordinary_a_pref_only",
    email: "stage2-catalogue-ordinary-a-pref-only@example.com",
    role: "user",
    preferences: { collegeId: "college-a", departmentId: "dept-a1" },
  });
  ordinaryB = await User.create({
    id: "usr_stage2_catalogue_ordinary_b",
    email: "stage2-catalogue-ordinary-b@example.com",
    role: "user",
    tenantIds: ["college-b"],
    preferences: { collegeId: "college-b", departmentId: "dept-b1" },
  });

  await createTemplatePersisted({
    id: ids.platformPublished,
    name: "Stage2 Catalogue Platform Published",
    scope: "platform",
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.platformDraft,
    name: "Stage2 Catalogue Platform Draft",
    scope: "platform",
    status: "draft",
  });
  await createTemplatePersisted({
    id: ids.platformArchived,
    name: "Stage2 Catalogue Platform Archived",
    scope: "platform",
    status: "archived",
  });
  await createTemplatePersisted({
    id: ids.aPublishedA1,
    name: "Stage2 Catalogue A Published A1",
    scope: "college",
    tenantId: "college-a",
    departmentId: "dept-a1",
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.aDraftA1,
    name: "Stage2 Catalogue A Draft A1",
    scope: "college",
    tenantId: "college-a",
    departmentId: "dept-a1",
    status: "draft",
  });
  await createTemplatePersisted({
    id: ids.aPublishedA2,
    name: "Stage2 Catalogue A Published A2",
    scope: "college",
    tenantId: "college-a",
    departmentId: "dept-a2",
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.aPublishedNoBranch,
    name: "Stage2 Catalogue A Published No Branch",
    scope: "college",
    tenantId: "college-a",
    departmentId: null,
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.bPublishedB1,
    name: "Stage2 Catalogue B Published B1",
    scope: "college",
    tenantId: "college-b",
    departmentId: "dept-b1",
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.privateA,
    name: "Stage2 Catalogue Private A",
    scope: "private",
    ownerUserId: ordinaryA.id,
    status: "draft",
  });
  await createTemplatePersisted({
    id: ids.privateB,
    name: "Stage2 Catalogue Private B",
    scope: "private",
    ownerUserId: ordinaryB.id,
    status: "active",
  });
  await createTemplatePersisted({
    id: ids.legacy,
    name: "Stage2 Catalogue Legacy",
    scope: "legacy",
    status: "active",
  });

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await db?.dropDatabase().catch(() => {});
  await disconnectStage2TestDb();
});

describe("STAGE 2 server-side template catalogue visibility", () => {
  it("shows anonymous callers only published platform templates", async () => {
    const list = listIds(await request(base, "GET", "/api/v1/templates"));
    assertIncludes(list, [ids.platformPublished], "anonymous");
    assertExcludes(
      list,
      [
        ids.platformDraft,
        ids.platformArchived,
        ids.aPublishedA1,
        ids.aDraftA1,
        ids.bPublishedB1,
        ids.privateA,
        ids.privateB,
        ids.legacy,
      ],
      "anonymous",
    );
  });

  it("isolates ordinary users by persisted college/branch preferences", async () => {
    const list = listIds(
      await request(base, "GET", "/api/v1/templates", { cookie: cookie(ordinaryA) }),
    );
    assertIncludes(
      list,
      [ids.platformPublished, ids.aPublishedA1, ids.aPublishedNoBranch, ids.privateA],
      "ordinary A",
    );
    assertExcludes(
      list,
      [
        ids.platformDraft,
        ids.platformArchived,
        ids.aDraftA1,
        ids.aPublishedA2,
        ids.bPublishedB1,
        ids.privateB,
        ids.legacy,
      ],
      "ordinary A",
    );

    const other = listIds(
      await request(base, "GET", "/api/v1/templates", { cookie: cookie(ordinaryB) }),
    );
    assertIncludes(
      other,
      [ids.platformPublished, ids.bPublishedB1, ids.privateB],
      "ordinary B",
    );
    assertExcludes(
      other,
      [ids.aPublishedA1, ids.aPublishedA2, ids.aDraftA1, ids.privateA, ids.legacy],
      "ordinary B",
    );
  });

  it("requires an explicit, authorized college/branch scope for cross-branch browsing", async () => {
    const ownScope = listIds(
      await request(
        base,
        "GET",
        "/api/v1/templates?collegeId=college-a&departmentId=dept-a1",
        { cookie: cookie(ordinaryA) },
      ),
    );
    assertIncludes(
      ownScope,
      [ids.platformPublished, ids.aPublishedA1, ids.aPublishedNoBranch, ids.privateA],
      "ordinary A explicit own scope",
    );
    assertExcludes(
      ownScope,
      [ids.aPublishedA2, ids.aDraftA1, ids.bPublishedB1],
      "ordinary A explicit own scope",
    );

    // tenantIds membership authorizes the whole college, so a member may
    // explicitly browse a sibling branch. Drafts stay hidden.
    const siblingBranch = listIds(
      await request(
        base,
        "GET",
        "/api/v1/templates?collegeId=college-a&departmentId=dept-a2",
        { cookie: cookie(ordinaryA) },
      ),
    );
    assertIncludes(
      siblingBranch,
      [ids.platformPublished, ids.aPublishedA2, ids.aPublishedNoBranch],
      "ordinary A member sibling branch",
    );
    assertExcludes(
      siblingBranch,
      [ids.aPublishedA1, ids.aDraftA1, ids.bPublishedB1, ids.legacy],
      "ordinary A member sibling branch",
    );

    const wholeCollege = listIds(
      await request(base, "GET", "/api/v1/templates?tenantId=college-a", {
        cookie: cookie(ordinaryA),
      }),
    );
    assertIncludes(
      wholeCollege,
      [ids.platformPublished, ids.aPublishedA1, ids.aPublishedA2, ids.aPublishedNoBranch],
      "ordinary A whole college",
    );
    assertExcludes(
      wholeCollege,
      [ids.aDraftA1, ids.bPublishedB1, ids.legacy],
      "ordinary A whole college",
    );

    const foreign = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-b",
      { cookie: cookie(ordinaryA) },
    );
    assert.equal(foreign.status, 403, JSON.stringify(foreign.data));

    // A branch preference without college membership is limited to that
    // branch: sibling branches and whole-college requests are forbidden.
    const preferenceOwn = listIds(
      await request(
        base,
        "GET",
        "/api/v1/templates?collegeId=college-a&departmentId=dept-a1",
        { cookie: cookie(ordinaryAPrefOnly) },
      ),
    );
    assertIncludes(
      preferenceOwn,
      [ids.platformPublished, ids.aPublishedA1, ids.aPublishedNoBranch],
      "preference-only own branch",
    );
    assertExcludes(
      preferenceOwn,
      [ids.aPublishedA2, ids.aDraftA1, ids.privateA, ids.bPublishedB1],
      "preference-only own branch",
    );

    const branchOutsidePreference = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-a&departmentId=dept-a2",
      { cookie: cookie(ordinaryAPrefOnly) },
    );
    assert.equal(branchOutsidePreference.status, 403, JSON.stringify(branchOutsidePreference.data));

    const wholeCollegeOutsidePreference = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-a",
      { cookie: cookie(ordinaryAPrefOnly) },
    );
    assert.equal(
      wholeCollegeOutsidePreference.status,
      403,
      JSON.stringify(wholeCollegeOutsidePreference.data),
    );

    const foreignPreference = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-b",
      { cookie: cookie(ordinaryAPrefOnly) },
    );
    assert.equal(foreignPreference.status, 403, JSON.stringify(foreignPreference.data));
  });

  it("uses college membership when preferences are absent, but never treats missing scope as 'everything'", async () => {
    const noScope = listIds(
      await request(base, "GET", "/api/v1/templates", {
        cookie: cookie(ordinaryAMember),
      }),
    );
    assertIncludes(noScope, [ids.platformPublished], "member without preferences");
    assertExcludes(
      noScope,
      [ids.aPublishedA1, ids.aPublishedA2, ids.aDraftA1, ids.bPublishedB1, ids.legacy],
      "member without preferences",
    );

    const explicit = listIds(
      await request(base, "GET", "/api/v1/templates?collegeId=college-a", {
        cookie: cookie(ordinaryAMember),
      }),
    );
    assertIncludes(
      explicit,
      [ids.platformPublished, ids.aPublishedA1, ids.aPublishedA2, ids.aPublishedNoBranch],
      "member explicit college",
    );
    assertExcludes(
      explicit,
      [ids.aDraftA1, ids.bPublishedB1, ids.privateA, ids.legacy],
      "member explicit college",
    );
  });

  it("lets college admins see their own drafts but not another college or private templates", async () => {
    const list = listIds(
      await request(base, "GET", "/api/v1/templates", { cookie: cookie(collegeAdminA) }),
    );
    assertIncludes(
      list,
      [
        ids.platformPublished,
        ids.aPublishedA1,
        ids.aDraftA1,
        ids.aPublishedA2,
        ids.aPublishedNoBranch,
      ],
      "college admin A",
    );
    assertExcludes(
      list,
      [ids.platformDraft, ids.bPublishedB1, ids.privateA, ids.privateB, ids.legacy],
      "college admin A",
    );
  });

  it("lets platform admins review shared and legacy templates but never private ones", async () => {
    const list = listIds(
      await request(base, "GET", "/api/v1/templates", { cookie: cookie(platformAdmin) }),
    );
    assertIncludes(
      list,
      [
        ids.platformPublished,
        ids.platformDraft,
        ids.platformArchived,
        ids.aPublishedA1,
        ids.aDraftA1,
        ids.bPublishedB1,
        ids.legacy,
      ],
      "platform admin",
    );
    assertExcludes(list, [ids.privateA, ids.privateB], "platform admin");

    const collegeBScope = listIds(
      await request(base, "GET", "/api/v1/templates?collegeId=college-b", {
        cookie: cookie(platformAdmin),
      }),
    );
    assertIncludes(
      collegeBScope,
      [ids.platformPublished, ids.bPublishedB1, ids.legacy],
      "platform admin explicit college B",
    );
    assertExcludes(
      collegeBScope,
      [ids.aPublishedA1, ids.aDraftA1, ids.aPublishedA2],
      "platform admin explicit college B",
    );
  });

  it("applies the same visibility rules to direct template reads", async () => {
    const cases = [
      [ordinaryA, ids.bPublishedB1, 404, "cross-college published"],
      [ordinaryA, ids.aDraftA1, 404, "ordinary draft"],
      [ordinaryA, ids.privateB, 404, "another user's private"],
      [ordinaryA, ids.legacy, 404, "ordinary legacy"],
      [ordinaryA, ids.privateA, 200, "own private"],
      [collegeAdminA, ids.aDraftA1, 200, "college admin own draft"],
      [platformAdmin, ids.privateA, 404, "platform admin private"],
      [platformAdmin, ids.legacy, 200, "platform admin legacy"],
    ];
    for (const [user, id, expected, label] of cases) {
      const response = await request(base, "GET", `/api/v1/templates/${id}`, {
        cookie: cookie(user),
      });
      assert.equal(response.status, expected, `${label}: ${response.text}`);
    }

    assert.equal(
      (await request(base, "GET", `/api/v1/templates/${ids.platformPublished}`)).status,
      200,
    );
    assert.equal(
      (await request(base, "GET", `/api/v1/templates/${ids.platformDraft}`)).status,
      404,
    );
    assert.equal(
      (await request(base, "GET", `/api/v1/templates/${ids.aPublishedA1}`)).status,
      404,
    );
  });

  it("validates explicit scope shape, existence, and college/branch consistency", async () => {
    const missingCollege = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-missing",
      { cookie: cookie(platformAdmin) },
    );
    assert.equal(missingCollege.status, 400, JSON.stringify(missingCollege.data));

    const missingDepartment = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-a&departmentId=dept-missing",
      { cookie: cookie(platformAdmin) },
    );
    assert.equal(missingDepartment.status, 400, JSON.stringify(missingDepartment.data));

    const wrongCollege = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-a&departmentId=dept-b1",
      { cookie: cookie(platformAdmin) },
    );
    assert.equal(wrongCollege.status, 400, JSON.stringify(wrongCollege.data));

    const departmentOnly = await request(
      base,
      "GET",
      "/api/v1/templates?departmentId=dept-a1",
      { cookie: cookie(platformAdmin) },
    );
    assert.equal(departmentOnly.status, 400, JSON.stringify(departmentOnly.data));

    const unauthorizedMissingCollege = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-missing",
      { cookie: cookie(ordinaryA) },
    );
    assert.equal(
      unauthorizedMissingCollege.status,
      403,
      "authorization must run before existence checks",
    );

    const duplicate = await request(
      base,
      "GET",
      "/api/v1/templates?collegeId=college-a&collegeId=college-b",
      { cookie: cookie(platformAdmin) },
    );
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.data));
  });
});
