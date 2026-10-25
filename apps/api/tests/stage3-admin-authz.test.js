import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// AUTH_REQUIRED=0 is the dangerous configuration: legacy routes are open. Admin
// routes must still authenticate and authorize from the persisted user.
process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "0";
process.env.JWT_SECRET = "stage3-admin-authz-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { AuditLog, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const {
  startServer,
  stopServer,
  cookieFor,
  forgedCookieFor,
  request,
} = await import("./helpers/stage2Http.js");

const TEST_DB = "markly_stage3_admin_authz_test";
const PREFIX = "stage3-authz";
const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;
const BRANCH_A2 = `${PREFIX}-branch-a2`;
const BRANCH_B1 = `${PREFIX}-branch-b1`;

let db;
let server;
let base;
let platformAdmin;
let collegeAdminA;
let collegeAdminB;
let ordinaryA;
let ordinaryB;

function auth(user) {
  return { cookie: cookieFor(user) };
}

async function api(user, method, path, body, headers = {}) {
  return request(base, method, path, {
    ...(user ? auth(user) : {}),
    body,
    headers,
  });
}

async function cleanup() {
  await User.deleteMany({ email: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
  await Template.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Department.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Tenant.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await AuditLog.deleteMany({ actorEmail: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
}

before(async () => {
  db = await connectStage3TestDb(TEST_DB);
  await db.dropDatabase();

  platformAdmin = await User.create({
    id: `${PREFIX}-usr-platform`,
    email: `${PREFIX}-platform@example.com`,
    name: "Stage3 Platform",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: `${PREFIX}-usr-college-a`,
    email: `${PREFIX}-college-a@example.com`,
    name: "Stage3 College A Admin",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_A],
    tenantIds: [COLLEGE_A],
  });
  collegeAdminB = await User.create({
    id: `${PREFIX}-usr-college-b`,
    email: `${PREFIX}-college-b@example.com`,
    name: "Stage3 College B Admin",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_B],
    tenantIds: [COLLEGE_B],
  });
  ordinaryA = await User.create({
    id: `${PREFIX}-usr-user-a`,
    email: `${PREFIX}-user-a@example.com`,
    name: "Stage3 Ordinary A",
    role: "user",
    tenantIds: [COLLEGE_A],
    preferences: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
  });
  ordinaryB = await User.create({
    id: `${PREFIX}-usr-user-b`,
    email: `${PREFIX}-user-b@example.com`,
    name: "Stage3 Ordinary B",
    role: "user",
    tenantIds: [COLLEGE_B],
    preferences: { collegeId: COLLEGE_B, departmentId: BRANCH_B1 },
  });

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage3 Authz College A", slug: COLLEGE_A },
    { id: COLLEGE_B, name: "Stage3 Authz College B", slug: COLLEGE_B },
  ]);
  await Department.create([
    { id: BRANCH_A1, tenantId: COLLEGE_A, name: "A1", slug: "a1" },
    { id: BRANCH_A2, tenantId: COLLEGE_A, name: "A2", slug: "a2" },
    { id: BRANCH_B1, tenantId: COLLEGE_B, name: "B1", slug: "b1" },
  ]);

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await cleanup().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage3TestDb();
});

describe("STAGE 3 admin authentication and authorization boundaries", () => {
  it("rejects anonymous admin requests even when AUTH_REQUIRED=0", async () => {
    const dashboard = await api(null, "GET", "/api/v1/admin/dashboard");
    assert.equal(dashboard.status, 401, JSON.stringify(dashboard.data));

    const colleges = await api(null, "GET", "/api/v1/admin/colleges");
    assert.equal(colleges.status, 401, JSON.stringify(colleges.data));

    const create = await api(null, "POST", "/api/v1/admin/colleges", {
      name: "Anonymous College",
      slug: "anonymous-college",
    });
    assert.equal(create.status, 401, JSON.stringify(create.data));
    assert.equal(await Tenant.countDocuments({ slug: "anonymous-college" }), 0);

    const invalid = await request(base, "GET", "/api/v1/admin/dashboard", {
      cookie: "markly_token=not-a-token",
    });
    assert.equal(invalid.status, 401, JSON.stringify(invalid.data));
  });

  it("ignores forged JWT role claims and uses the persisted user", async () => {
    const forged = forgedCookieFor(ordinaryA, {
      role: "platform_admin",
      collegeAdminOf: [COLLEGE_A, COLLEGE_B],
      tenantIds: [COLLEGE_A, COLLEGE_B],
    });

    const dashboard = await request(base, "GET", "/api/v1/admin/dashboard", {
      cookie: forged,
    });
    assert.equal(dashboard.status, 403, JSON.stringify(dashboard.data));

    const createCollege = await request(base, "POST", "/api/v1/admin/colleges", {
      cookie: forged,
      body: { name: "Forged College", slug: "forged-college" },
    });
    assert.equal(createCollege.status, 403, JSON.stringify(createCollege.data));
    assert.equal(await Tenant.countDocuments({ slug: "forged-college" }), 0);

    const me = await request(base, "GET", "/api/v1/auth/me", { cookie: forged });
    assert.equal(me.status, 200, JSON.stringify(me.data));
    assert.equal(me.data.user.role, "user");
    assert.deepEqual(me.data.user.collegeAdminOf, []);
    assert.deepEqual(me.data.user.tenantIds, [COLLEGE_A]);

    const ordinaryDashboard = await api(ordinaryA, "GET", "/api/v1/admin/dashboard");
    assert.equal(ordinaryDashboard.status, 403, JSON.stringify(ordinaryDashboard.data));
  });

  it("allows platform admins globally and college admins only inside their persisted scope", async () => {
    const platformDashboard = await api(platformAdmin, "GET", "/api/v1/admin/dashboard");
    assert.equal(platformDashboard.status, 200, JSON.stringify(platformDashboard.data));
    assert.equal(platformDashboard.data.stats.colleges, 2);
    assert.equal(platformDashboard.data.stats.branches, 3);

    const platformColleges = await api(platformAdmin, "GET", "/api/v1/admin/colleges");
    assert.equal(platformColleges.status, 200);
    assert.deepEqual(
      platformColleges.data.colleges.map((college) => college.id).sort(),
      [COLLEGE_A, COLLEGE_B],
    );

    const ownColleges = await api(collegeAdminA, "GET", "/api/v1/admin/colleges");
    assert.equal(ownColleges.status, 200, JSON.stringify(ownColleges.data));
    assert.deepEqual(ownColleges.data.colleges.map((college) => college.id), [COLLEGE_A]);

    const ownCollege = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
    );
    assert.equal(ownCollege.status, 200, JSON.stringify(ownCollege.data));
    assert.equal(ownCollege.data.college.id, COLLEGE_A);
    assert.equal(ownCollege.data.branches.length, 2);

    const otherCollege = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_B}`,
    );
    assert.equal(otherCollege.status, 403, JSON.stringify(otherCollege.data));

    const otherBranches = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
    );
    assert.equal(otherBranches.status, 403, JSON.stringify(otherBranches.data));

    const createCollege = await api(collegeAdminA, "POST", "/api/v1/admin/colleges", {
      name: "College Admin College",
      slug: "college-admin-college",
    });
    assert.equal(createCollege.status, 403, JSON.stringify(createCollege.data));

    const patchOwnCollege = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
      { name: "Renamed by college admin" },
    );
    assert.equal(patchOwnCollege.status, 403, JSON.stringify(patchOwnCollege.data));

    const assignAdmin = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: ordinaryA.email },
    );
    assert.equal(assignAdmin.status, 403, JSON.stringify(assignAdmin.data));

    const removeAdmin = await api(
      collegeAdminA,
      "DELETE",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins/${ordinaryA.id}`,
    );
    assert.equal(removeAdmin.status, 403, JSON.stringify(removeAdmin.data));

    const ownBranch = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      { name: "College Admin Branch", slug: "college-admin-branch" },
    );
    assert.equal(ownBranch.status, 201, JSON.stringify(ownBranch.data));
    assert.equal(ownBranch.data.branch.tenantId, COLLEGE_A);

    const otherBranch = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
      { name: "Cross College Branch", slug: "cross-college-branch" },
    );
    assert.equal(otherBranch.status, 403, JSON.stringify(otherBranch.data));
    assert.equal(
      await Department.countDocuments({ slug: "cross-college-branch" }),
      0,
    );

    const ordinary = await api(ordinaryA, "GET", "/api/v1/admin/colleges");
    assert.equal(ordinary.status, 403, JSON.stringify(ordinary.data));
  });

  it("never lets ordinary users create shared or platform templates", async () => {
    const college = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Ordinary College Template",
      scope: "college",
      tenantId: COLLEGE_A,
    });
    assert.equal(college.status, 403, JSON.stringify(college.data));

    const platform = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Ordinary Platform Template",
      scope: "platform",
    });
    assert.equal(platform.status, 403, JSON.stringify(platform.data));

    const legacy = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Ordinary Legacy Template",
      scope: "legacy",
    });
    assert.equal(legacy.status, 403, JSON.stringify(legacy.data));

    const privateTemplate = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Ordinary Private Template",
    });
    assert.equal(privateTemplate.status, 201, JSON.stringify(privateTemplate.data));
    assert.equal(privateTemplate.data.template.scope, "private");
    assert.equal(privateTemplate.data.template.ownerUserId, ordinaryA.id);

    const platformTemplate = await api(platformAdmin, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Platform Template",
      scope: "platform",
    });
    assert.equal(platformTemplate.status, 201, JSON.stringify(platformTemplate.data));
    assert.equal(platformTemplate.data.template.scope, "platform");

    const collegeTemplate = await api(collegeAdminA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz College A Template",
      scope: "college",
      tenantId: COLLEGE_A,
    });
    assert.equal(collegeTemplate.status, 201, JSON.stringify(collegeTemplate.data));
    assert.equal(collegeTemplate.data.template.scope, "college");
    assert.equal(collegeTemplate.data.template.tenantId, COLLEGE_A);

    const crossCollege = await api(collegeAdminA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Cross College Template",
      scope: "college",
      tenantId: COLLEGE_B,
    });
    assert.equal(crossCollege.status, 403, JSON.stringify(crossCollege.data));

    const otherCollegeTemplate = await api(platformAdmin, "POST", "/api/v1/templates", {
      name: "Stage3 Authz College B Template",
      scope: "college",
      tenantId: COLLEGE_B,
    });
    assert.equal(
      otherCollegeTemplate.status,
      201,
      JSON.stringify(otherCollegeTemplate.data),
    );
  });

  it("keeps private templates owner-only, including against platform admins", async () => {
    const created = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Authz Owner Private Template",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;
    assert.equal(created.data.template.scope, "private");
    assert.equal(created.data.template.ownerUserId, ordinaryA.id);

    const ownerRead = await api(ordinaryA, "GET", `/api/v1/templates/${id}`);
    assert.equal(ownerRead.status, 200, JSON.stringify(ownerRead.data));
    assert.equal(ownerRead.data.template.ownerUserId, ordinaryA.id);

    for (const outsider of [ordinaryB, collegeAdminA, platformAdmin]) {
      const read = await api(outsider, "GET", `/api/v1/templates/${id}`);
      assert.equal(read.status, 404, JSON.stringify(read.data));
      const history = await api(outsider, "GET", `/api/v1/templates/${id}/versions`);
      assert.equal(history.status, 403, JSON.stringify(history.data));
      const preview = await api(outsider, "GET", `/api/v1/templates/${id}/preview`);
      assert.equal(preview.status, 403, JSON.stringify(preview.data));
      const update = await api(outsider, "PUT", `/api/v1/templates/${id}`, {
        footer: { text: "stolen" },
      });
      assert.equal(update.status, 403, JSON.stringify(update.data));
      const publish = await api(outsider, "POST", `/api/v1/templates/${id}/publish`, {});
      assert.equal(publish.status, 403, JSON.stringify(publish.data));
      const archive = await api(outsider, "POST", `/api/v1/templates/${id}/archive`, {});
      assert.equal(archive.status, 403, JSON.stringify(archive.data));
    }

    const platformCatalogue = await api(
      platformAdmin,
      "GET",
      "/api/v1/templates?scope=private",
    );
    assert.equal(platformCatalogue.status, 200);
    assert.equal(
      platformCatalogue.data.templates.some((template) => template.id === id),
      false,
    );

    const ownerCatalogue = await api(ordinaryA, "GET", "/api/v1/templates?scope=private");
    assert.equal(ownerCatalogue.status, 200);
    assert.equal(
      ownerCatalogue.data.templates.some((template) => template.id === id),
      true,
    );

    const dashboard = await api(platformAdmin, "GET", "/api/v1/admin/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(
      dashboard.data.recentTemplates.some((template) => template.id === id),
      false,
    );

    // The owner may still manage and publish their own private copy.
    const ownerUpdate = await api(ordinaryA, "PUT", `/api/v1/templates/${id}`, {
      footer: { text: "owner update" },
      status: "active",
    });
    assert.equal(ownerUpdate.status, 200, JSON.stringify(ownerUpdate.data));
    assert.equal(ownerUpdate.data.template.version, 2);
    assert.equal(ownerUpdate.data.template.scope, "private");
    assert.equal(ownerUpdate.data.template.ownerUserId, ordinaryA.id);
  });

  it("prevents cross-college management and draft disclosure", async () => {
    const created = await api(platformAdmin, "POST", "/api/v1/templates", {
      name: "Stage3 Authz College B Draft",
      scope: "college",
      tenantId: COLLEGE_B,
      departmentId: BRANCH_B1,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;
    assert.equal(created.data.template.status, "draft");

    const crossCatalogue = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_B)}`,
    );
    assert.equal(crossCatalogue.status, 403, JSON.stringify(crossCatalogue.data));

    const unscoped = await api(collegeAdminA, "GET", "/api/v1/templates");
    assert.equal(unscoped.status, 200);
    assert.equal(
      unscoped.data.templates.some((template) => template.id === id),
      false,
      "another college's draft must never appear in the catalogue",
    );

    const read = await api(collegeAdminA, "GET", `/api/v1/templates/${id}`);
    assert.equal(read.status, 404, JSON.stringify(read.data));
    const history = await api(collegeAdminA, "GET", `/api/v1/templates/${id}/versions`);
    assert.equal(history.status, 403, JSON.stringify(history.data));
    const preview = await api(collegeAdminA, "GET", `/api/v1/templates/${id}/preview`);
    assert.equal(preview.status, 403, JSON.stringify(preview.data));
    const update = await api(collegeAdminA, "PUT", `/api/v1/templates/${id}`, {
      footer: { text: "cross-college edit" },
    });
    assert.equal(update.status, 403, JSON.stringify(update.data));
    const publish = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/publish`,
      {},
    );
    assert.equal(publish.status, 403, JSON.stringify(publish.data));
    const archive = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/archive`,
      {},
    );
    assert.equal(archive.status, 403, JSON.stringify(archive.data));

    const ownAdminRead = await api(collegeAdminB, "GET", `/api/v1/templates/${id}`);
    assert.equal(ownAdminRead.status, 200, JSON.stringify(ownAdminRead.data));

    const platformRead = await api(platformAdmin, "GET", `/api/v1/templates/${id}`);
    assert.equal(platformRead.status, 200, JSON.stringify(platformRead.data));
  });

  it("scopes dashboard counts, recent templates and audit actions by college", async () => {
    const collegeDashboard = await api(
      collegeAdminA,
      "GET",
      "/api/v1/admin/dashboard",
    );
    assert.equal(collegeDashboard.status, 200, JSON.stringify(collegeDashboard.data));
    assert.equal(collegeDashboard.data.stats.colleges, 1);
    assert.equal(
      collegeDashboard.data.stats.branches,
      await Department.countDocuments({ tenantId: COLLEGE_A }),
    );
    assert.equal(
      collegeDashboard.data.recentTemplates.some(
        (template) => template.tenantId === COLLEGE_B,
      ),
      false,
    );
    assert.equal(
      collegeDashboard.data.recentActions.every(
        (action) => action.collegeId === COLLEGE_A,
      ),
      true,
    );

    const platformDashboard = await api(
      platformAdmin,
      "GET",
      "/api/v1/admin/dashboard",
    );
    assert.equal(platformDashboard.status, 200);
    assert.equal(platformDashboard.data.stats.colleges, 2);
    assert.equal(
      platformDashboard.data.stats.branches,
      await Department.countDocuments({}),
    );
    assert.equal(
      platformDashboard.data.recentTemplates.some(
        (template) => template.tenantId === COLLEGE_B,
      ),
      true,
    );
    assert.equal(
      platformDashboard.data.recentActions.some(
        (action) => action.collegeId === COLLEGE_B,
      ),
      true,
    );

    const collegeAudit = await api(collegeAdminA, "GET", "/api/v1/admin/audit?limit=100");
    assert.equal(collegeAudit.status, 200, JSON.stringify(collegeAudit.data));
    assert.equal(collegeAudit.data.actions.length > 0, true);
    assert.equal(
      collegeAudit.data.actions.every((action) => action.collegeId === COLLEGE_A),
      true,
    );

    const platformAudit = await api(
      platformAdmin,
      "GET",
      "/api/v1/admin/audit?limit=100",
    );
    assert.equal(platformAudit.status, 200);
    assert.equal(
      platformAudit.data.actions.some((action) => action.collegeId === COLLEGE_B),
      true,
    );

    const persisted = await AuditLog.find({ collegeId: COLLEGE_A }).lean();
    assert.equal(persisted.length > 0, true);
    assert.equal(
      persisted.every(
        (entry) =>
          entry.actorId &&
          entry.action &&
          entry.entityType &&
          entry.entityId &&
          entry.createdAt,
      ),
      true,
    );
  });

  it("fails closed with 503 when persisted authorization is unavailable", async () => {
    await disconnectStage3TestDb();
    try {
      const dashboard = await api(platformAdmin, "GET", "/api/v1/admin/dashboard");
      assert.equal(dashboard.status, 503, JSON.stringify(dashboard.data));
      const create = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
        name: "Offline College",
        slug: "offline-college",
      });
      assert.equal(create.status, 503, JSON.stringify(create.data));
    } finally {
      db = await connectStage3TestDb(TEST_DB);
    }
  });
});
