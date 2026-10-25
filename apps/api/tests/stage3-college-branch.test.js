import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage3-college-branch-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { AuditLog, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { startServer, stopServer, cookieFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage3_college_branch_test";
const PREFIX = "stage3-cb";
const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const COLLEGE_C = `${PREFIX}-college-c`;
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

function api(user, method, path, body) {
  return request(base, method, path, {
    ...(user ? { cookie: cookieFor(user) } : {}),
    body,
  });
}

async function createTemplate(user, body) {
  const response = await api(user, "POST", "/api/v1/templates", body);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.template;
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
    name: "Stage3 CB Platform",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: `${PREFIX}-usr-college-a`,
    email: `${PREFIX}-college-a@example.com`,
    name: "Stage3 CB College A Admin",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_A],
    tenantIds: [COLLEGE_A],
  });
  collegeAdminB = await User.create({
    id: `${PREFIX}-usr-college-b`,
    email: `${PREFIX}-college-b@example.com`,
    name: "Stage3 CB College B Admin",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_B],
    tenantIds: [COLLEGE_B],
  });
  ordinaryA = await User.create({
    id: `${PREFIX}-usr-user-a`,
    email: `${PREFIX}-user-a@example.com`,
    name: "Stage3 CB Ordinary A",
    role: "user",
    tenantIds: [COLLEGE_A],
    preferences: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
  });

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage3 CB College A", slug: "stage3-cb-college-a" },
    { id: COLLEGE_B, name: "Stage3 CB College B", slug: "stage3-cb-college-b" },
  ]);

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await cleanup().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage3TestDb();
});

describe("STAGE 3 college and branch management", () => {
  it("creates, edits and audits colleges with server-side uniqueness and validation", async () => {
    const created = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      id: COLLEGE_C,
      name: "Stage3 CB College C",
      slug: "stage3-cb-college-c",
      status: "active",
      metadata: { city: "Mumbai", nested: { accreditation: "NAAC" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.college.id, COLLEGE_C);
    assert.equal(created.data.college.status, "active");
    assert.equal(created.data.college.metadata.city, "Mumbai");

    const persisted = await Tenant.findOne({ id: COLLEGE_C }).lean();
    assert.ok(persisted, "the college must be durable before success is returned");
    assert.equal(persisted.name, "Stage3 CB College C");

    const createAudit = await AuditLog.findOne({
      action: "college.create",
      entityId: COLLEGE_C,
    }).lean();
    assert.ok(createAudit);
    assert.equal(createAudit.actorId, platformAdmin.id);
    assert.equal(createAudit.collegeId, COLLEGE_C);
    assert.equal(createAudit.metadata.slug, "stage3-cb-college-c");

    const duplicateId = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      id: COLLEGE_C,
      name: "Duplicate Id",
      slug: "stage3-cb-duplicate-id",
    });
    assert.equal(duplicateId.status, 409, JSON.stringify(duplicateId.data));

    const duplicateSlug = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      id: `${PREFIX}-college-c2`,
      name: "Duplicate Slug",
      slug: "stage3-cb-college-c",
    });
    assert.equal(duplicateSlug.status, 409, JSON.stringify(duplicateSlug.data));

    const shortName = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      name: "A",
      slug: "stage3-cb-short-name",
    });
    assert.equal(shortName.status, 400, JSON.stringify(shortName.data));

    const badMetadata = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      name: "Bad Metadata",
      slug: "stage3-cb-bad-metadata",
      metadata: [],
    });
    assert.equal(badMetadata.status, 400, JSON.stringify(badMetadata.data));

    const unsafeMetadata = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      name: "Unsafe Metadata",
      slug: "stage3-cb-unsafe-metadata",
      metadata: { $where: "sleep(1000)" },
    });
    assert.equal(unsafeMetadata.status, 400, JSON.stringify(unsafeMetadata.data));

    const updated = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_C}`,
      {
        name: "Stage3 CB College C Renamed",
        slug: "stage3-cb-college-c-renamed",
        status: "inactive",
        metadata: { city: "Pune" },
      },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.college.name, "Stage3 CB College C Renamed");
    assert.equal(updated.data.college.status, "inactive");
    assert.equal(updated.data.college.metadata.city, "Pune");

    const stored = await Tenant.findOne({ id: COLLEGE_C }).lean();
    assert.equal(stored.slug, "stage3-cb-college-c-renamed");
    assert.equal(stored.status, "inactive");

    const slugConflict = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_C}`,
      { slug: "stage3-cb-college-b" },
    );
    assert.equal(slugConflict.status, 409, JSON.stringify(slugConflict.data));

    const emptyPatch = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_C}`,
      {},
    );
    assert.equal(emptyPatch.status, 400, JSON.stringify(emptyPatch.data));

    const missing = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${PREFIX}-does-not-exist`,
      { name: "Missing College" },
    );
    assert.equal(missing.status, 404, JSON.stringify(missing.data));

    const secretPatch = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_C}`,
      {
        metadata: {
          password: "super-secret-password",
          apiKey: "super-secret-api-key",
          token: "super-secret-token",
          safe: "visible",
        },
      },
    );
    assert.equal(secretPatch.status, 200, JSON.stringify(secretPatch.data));

    const updateAudit = await AuditLog.findOne({
      action: "college.update",
      entityId: COLLEGE_C,
    })
      .sort({ createdAt: -1 })
      .lean();
    assert.ok(updateAudit);
    assert.equal(updateAudit.actorId, platformAdmin.id);
    assert.equal(updateAudit.metadata.after.metadata.password, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.apiKey, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.token, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.safe, "visible");
    const auditJson = JSON.stringify(updateAudit);
    assert.equal(auditJson.includes("super-secret-password"), false);
    assert.equal(auditJson.includes("super-secret-api-key"), false);
    assert.equal(auditJson.includes("super-secret-token"), false);

    const auditList = await api(
      platformAdmin,
      "GET",
      "/api/v1/admin/audit?limit=100",
    );
    assert.equal(auditList.status, 200, JSON.stringify(auditList.data));
    assert.equal(
      auditList.data.actions.some(
        (entry) =>
          entry.action === "college.create" &&
          entry.entityId === COLLEGE_C &&
          entry.actorEmail === platformAdmin.email &&
          entry.createdAt,
      ),
      true,
    );
  });

  it("keeps college admins inside their assigned colleges", async () => {
    const colleges = await api(collegeAdminA, "GET", "/api/v1/admin/colleges");
    assert.equal(colleges.status, 200, JSON.stringify(colleges.data));
    assert.deepEqual(
      colleges.data.colleges.map((college) => college.id),
      [COLLEGE_A],
    );

    const own = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
    );
    assert.equal(own.status, 200, JSON.stringify(own.data));

    for (const other of [COLLEGE_B, COLLEGE_C]) {
      const read = await api(
        collegeAdminA,
        "GET",
        `/api/v1/admin/colleges/${other}`,
      );
      assert.equal(read.status, 403, JSON.stringify(read.data));
      const branches = await api(
        collegeAdminA,
        "GET",
        `/api/v1/admin/colleges/${other}/branches`,
      );
      assert.equal(branches.status, 403, JSON.stringify(branches.data));
      const admins = await api(
        collegeAdminA,
        "GET",
        `/api/v1/admin/colleges/${other}/admins`,
      );
      assert.equal(admins.status, 403, JSON.stringify(admins.data));
    }

    const patch = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
      { name: "College Admin Cannot Rename" },
    );
    assert.equal(patch.status, 403, JSON.stringify(patch.data));

    const createCollege = await api(
      collegeAdminA,
      "POST",
      "/api/v1/admin/colleges",
      { name: "College Admin College", slug: "stage3-cb-college-admin" },
    );
    assert.equal(createCollege.status, 403, JSON.stringify(createCollege.data));

    const ownAdmins = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
    );
    assert.equal(ownAdmins.status, 200, JSON.stringify(ownAdmins.data));
    assert.equal(
      ownAdmins.data.admins.some((admin) => admin.email === collegeAdminA.email),
      true,
    );

    const assign = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: ordinaryA.email },
    );
    assert.equal(assign.status, 403, JSON.stringify(assign.data));

    const remove = await api(
      collegeAdminA,
      "DELETE",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins/${ordinaryA.id}`,
    );
    assert.equal(remove.status, 403, JSON.stringify(remove.data));

    const ordinary = await api(ordinaryA, "GET", "/api/v1/admin/colleges");
    assert.equal(ordinary.status, 403, JSON.stringify(ordinary.data));
  });

  it("creates branches with college-scoped uniqueness and immutable relationships", async () => {
    const branchA1 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      {
        id: BRANCH_A1,
        name: "Computer Engineering",
        slug: "computer-engineering",
        metadata: { code: "CE" },
      },
    );
    assert.equal(branchA1.status, 201, JSON.stringify(branchA1.data));
    assert.equal(branchA1.data.branch.tenantId, COLLEGE_A);
    assert.equal(branchA1.data.branch.status, "active");
    assert.equal(branchA1.data.branch.defaultTemplateId, null);

    const branchA2 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      {
        id: BRANCH_A2,
        name: "Information Technology",
        slug: "information-technology",
      },
    );
    assert.equal(branchA2.status, 201, JSON.stringify(branchA2.data));

    const duplicateId = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      { id: BRANCH_A1, name: "Duplicate Id", slug: "duplicate-id" },
    );
    assert.equal(duplicateId.status, 409, JSON.stringify(duplicateId.data));

    const duplicateSlug = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      { name: "Duplicate Slug", slug: "computer-engineering" },
    );
    assert.equal(duplicateSlug.status, 409, JSON.stringify(duplicateSlug.data));

    const sameSlugOtherCollege = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
      {
        id: BRANCH_B1,
        name: "Computer Engineering B",
        slug: "computer-engineering",
      },
    );
    assert.equal(
      sameSlugOtherCollege.status,
      201,
      JSON.stringify(sameSlugOtherCollege.data),
    );

    const duplicateGlobalId = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
      { id: BRANCH_A1, name: "Duplicate Global Id", slug: "duplicate-global-id" },
    );
    assert.equal(duplicateGlobalId.status, 409, JSON.stringify(duplicateGlobalId.data));

    const crossCollegeCreate = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
      { name: "Cross College", slug: "cross-college" },
    );
    assert.equal(crossCollegeCreate.status, 403, JSON.stringify(crossCollegeCreate.data));

    const ownBranches = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
    );
    assert.equal(ownBranches.status, 200, JSON.stringify(ownBranches.data));
    assert.deepEqual(
      ownBranches.data.branches.map((branch) => branch.id).sort(),
      [BRANCH_A1, BRANCH_A2],
    );

    const otherBranches = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches`,
    );
    assert.equal(otherBranches.status, 403, JSON.stringify(otherBranches.data));

    const updated = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}`,
      {
        name: "Computer Engineering Updated",
        slug: "computer-engineering-updated",
        status: "inactive",
        metadata: { code: "CE2" },
      },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.branch.name, "Computer Engineering Updated");
    assert.equal(updated.data.branch.status, "inactive");

    const stored = await Department.findOne({ id: BRANCH_A1 }).lean();
    assert.equal(stored.tenantId, COLLEGE_A);
    assert.equal(stored.slug, "computer-engineering-updated");
    assert.equal(stored.metadata.code, "CE2");

    const moveBranch = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}`,
      { tenantId: COLLEGE_B },
    );
    assert.equal(moveBranch.status, 400, JSON.stringify(moveBranch.data));
    assert.equal(
      (await Department.findOne({ id: BRANCH_A1 }).lean()).tenantId,
      COLLEGE_A,
    );

    const crossCollegePatch = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_B1}`,
      { name: "Wrong Path" },
    );
    assert.equal(crossCollegePatch.status, 404, JSON.stringify(crossCollegePatch.data));

    const missingBranch = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${PREFIX}-missing`,
      { name: "Missing Branch" },
    );
    assert.equal(missingBranch.status, 404, JSON.stringify(missingBranch.data));

    const inactiveDefault = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/default-template`,
      { templateId: null },
    );
    assert.equal(inactiveDefault.status, 400, JSON.stringify(inactiveDefault.data));

    const reactivated = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}`,
      { status: "active" },
    );
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.data));
    assert.equal(reactivated.data.branch.status, "active");

    const branchAudit = await AuditLog.findOne({
      action: "branch.create",
      entityId: BRANCH_A1,
    }).lean();
    assert.ok(branchAudit);
    assert.equal(branchAudit.actorId, collegeAdminA.id);
    assert.equal(branchAudit.collegeId, COLLEGE_A);
    assert.equal(branchAudit.metadata.slug, "computer-engineering");
  });

  it("exposes only branch-visible templates through the admin branch view", async () => {
    const platformTemplate = await createTemplate(platformAdmin, {
      name: "Stage3 CB Platform Published",
      scope: "platform",
      status: "active",
    });
    const branchTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB A1 Published",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      status: "active",
    });
    const collegeTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB A College Published",
      scope: "college",
      tenantId: COLLEGE_A,
      status: "active",
    });
    const draftTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB A Draft",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });
    const otherCollegeTemplate = await createTemplate(platformAdmin, {
      name: "Stage3 CB B Published",
      scope: "college",
      tenantId: COLLEGE_B,
      status: "active",
    });
    const privateTemplate = await createTemplate(ordinaryA, {
      name: "Stage3 CB Private",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });

    const ownView = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/templates`,
    );
    assert.equal(ownView.status, 200, JSON.stringify(ownView.data));
    const ownIds = ownView.data.templates.map((template) => template.id);
    assert.equal(ownIds.includes(branchTemplate.id), true);
    assert.equal(ownIds.includes(collegeTemplate.id), true);
    assert.equal(ownIds.includes(draftTemplate.id), true);
    assert.equal(ownIds.includes(otherCollegeTemplate.id), false);
    assert.equal(ownIds.includes(privateTemplate.id), false);
    assert.equal(ownIds.includes(platformTemplate.id), false);

    const platformView = await api(
      platformAdmin,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/templates`,
    );
    assert.equal(platformView.status, 200, JSON.stringify(platformView.data));
    const platformIds = platformView.data.templates.map((template) => template.id);
    assert.equal(platformIds.includes(platformTemplate.id), true);
    assert.equal(platformIds.includes(branchTemplate.id), true);
    assert.equal(platformIds.includes(collegeTemplate.id), true);
    assert.equal(platformIds.includes(draftTemplate.id), true);
    assert.equal(platformIds.includes(otherCollegeTemplate.id), true);
    assert.equal(platformIds.includes(privateTemplate.id), false);

    const otherBranchView = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A2}/templates`,
    );
    assert.equal(otherBranchView.status, 200, JSON.stringify(otherBranchView.data));
    const otherBranchIds = otherBranchView.data.templates.map((template) => template.id);
    assert.equal(otherBranchIds.includes(collegeTemplate.id), true);
    assert.equal(otherBranchIds.includes(branchTemplate.id), false);
    assert.equal(otherBranchIds.includes(draftTemplate.id), false);

    const crossCollegeView = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_B}/branches/${BRANCH_B1}/templates`,
    );
    assert.equal(crossCollegeView.status, 403, JSON.stringify(crossCollegeView.data));

    const ordinaryView = await api(
      ordinaryA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/templates`,
    );
    assert.equal(ordinaryView.status, 403, JSON.stringify(ordinaryView.data));
  });

  it("pins exact branch defaults and rejects invalid or cross-college references", async () => {
    const platformTemplate = await createTemplate(platformAdmin, {
      name: "Stage3 CB Default Platform",
      scope: "platform",
      status: "active",
    });
    const branchTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB Default A1",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      status: "active",
    });
    const branchA2Template = await createTemplate(collegeAdminA, {
      name: "Stage3 CB Default A2",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A2,
      status: "active",
    });
    const collegeTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB Default College",
      scope: "college",
      tenantId: COLLEGE_A,
      status: "active",
    });
    const draftTemplate = await createTemplate(collegeAdminA, {
      name: "Stage3 CB Default Draft",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });
    const otherCollegeTemplate = await createTemplate(platformAdmin, {
      name: "Stage3 CB Default B",
      scope: "college",
      tenantId: COLLEGE_B,
      status: "active",
    });
    const privateTemplate = await createTemplate(ordinaryA, {
      name: "Stage3 CB Default Private",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });

    async function setDefault(templateId, templateVersion, user = collegeAdminA) {
      return api(
        user,
        "PUT",
        `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/default-template`,
        { templateId, templateVersion },
      );
    }

    const platformDefault = await setDefault(platformTemplate.id, 1);
    assert.equal(platformDefault.status, 200, JSON.stringify(platformDefault.data));
    assert.equal(platformDefault.data.branch.defaultTemplateId, platformTemplate.id);
    assert.equal(platformDefault.data.branch.defaultTemplateVersion, 1);

    const branchDefault = await setDefault(branchTemplate.id, 1);
    assert.equal(branchDefault.status, 200, JSON.stringify(branchDefault.data));
    assert.equal(branchDefault.data.branch.defaultTemplateId, branchTemplate.id);

    const collegeDefault = await setDefault(collegeTemplate.id, 1);
    assert.equal(collegeDefault.status, 200, JSON.stringify(collegeDefault.data));
    assert.equal(collegeDefault.data.branch.defaultTemplateId, collegeTemplate.id);

    const crossCollege = await setDefault(otherCollegeTemplate.id, 1);
    assert.equal(crossCollege.status, 403, JSON.stringify(crossCollege.data));

    const wrongBranch = await setDefault(branchA2Template.id, 1);
    assert.equal(wrongBranch.status, 403, JSON.stringify(wrongBranch.data));

    const draft = await setDefault(draftTemplate.id, 1);
    assert.equal(draft.status, 403, JSON.stringify(draft.data));

    const privateDefault = await setDefault(privateTemplate.id, 1);
    assert.equal(privateDefault.status, 403, JSON.stringify(privateDefault.data));

    const missing = await setDefault(`${PREFIX}-missing-template`, 1);
    assert.equal(missing.status, 404, JSON.stringify(missing.data));

    const invalidVersion = await setDefault(platformTemplate.id, 0);
    assert.equal(invalidVersion.status, 400, JSON.stringify(invalidVersion.data));

    const nonNumericVersion = await setDefault(platformTemplate.id, "abc");
    assert.equal(nonNumericVersion.status, 400, JSON.stringify(nonNumericVersion.data));

    const cleared = await setDefault(null, null);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.equal(cleared.data.branch.defaultTemplateId, null);
    assert.equal(cleared.data.branch.defaultTemplateVersion, null);

    // Publishing a newer version never silently repoints an existing default.
    const publishedV2 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${collegeTemplate.id}/publish`,
      { footer: { text: "version two" } },
    );
    assert.equal(publishedV2.status, 200, JSON.stringify(publishedV2.data));
    assert.equal(publishedV2.data.template.version, 2);
    assert.equal(publishedV2.data.template.status, "published");

    const pinnedV1 = await setDefault(collegeTemplate.id, 1);
    assert.equal(pinnedV1.status, 200, JSON.stringify(pinnedV1.data));
    assert.equal(pinnedV1.data.branch.defaultTemplateVersion, 1);

    const publishedV3 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${collegeTemplate.id}/publish`,
      { footer: { text: "version three" } },
    );
    assert.equal(publishedV3.status, 200, JSON.stringify(publishedV3.data));
    assert.equal(publishedV3.data.template.version, 3);

    const stillV1 = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
    );
    const branchRow = stillV1.data.branches.find((branch) => branch.id === BRANCH_A1);
    assert.equal(branchRow.defaultTemplateId, collegeTemplate.id);
    assert.equal(branchRow.defaultTemplateVersion, 1);

    const latestDefault = await setDefault(collegeTemplate.id, undefined);
    assert.equal(latestDefault.status, 200, JSON.stringify(latestDefault.data));
    assert.equal(latestDefault.data.branch.defaultTemplateVersion, 3);

    const archived = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${collegeTemplate.id}/archive`,
      {},
    );
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.equal(archived.data.template.status, "archived");

    const afterArchive = await api(
      collegeAdminA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
    );
    const clearedRow = afterArchive.data.branches.find((branch) => branch.id === BRANCH_A1);
    assert.equal(clearedRow.defaultTemplateId, null);
    assert.equal(clearedRow.defaultTemplateVersion, null);

    const clearAudit = await AuditLog.findOne({
      action: "branch.default_template.clear",
      entityId: BRANCH_A1,
      "metadata.reason": "template archived",
    }).lean();
    assert.ok(clearAudit);
    assert.equal(clearAudit.collegeId, COLLEGE_A);

    const inactiveBranch = await api(
      collegeAdminA,
      "PATCH",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A2}`,
      { status: "inactive" },
    );
    assert.equal(inactiveBranch.status, 200, JSON.stringify(inactiveBranch.data));
    const inactiveDefault = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A2}/default-template`,
      { templateId: platformTemplate.id, templateVersion: 1 },
    );
    assert.equal(inactiveDefault.status, 400, JSON.stringify(inactiveDefault.data));

    const otherAdminDefault = await setDefault(platformTemplate.id, 1, collegeAdminB);
    assert.equal(otherAdminDefault.status, 403, JSON.stringify(otherAdminDefault.data));
  });

  it("assigns and removes college administrators with persisted scope and audit", async () => {
    const assignedA = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: ordinaryA.email },
    );
    assert.equal(assignedA.status, 200, JSON.stringify(assignedA.data));
    assert.equal(assignedA.data.admin.role, "college_admin");
    assert.deepEqual(assignedA.data.admin.collegeAdminOf, [COLLEGE_A]);

    const persisted = await User.findOne({ id: ordinaryA.id }).lean();
    assert.equal(persisted.role, "college_admin");
    assert.deepEqual(persisted.collegeAdminOf, [COLLEGE_A]);

    const ownColleges = await api(ordinaryA, "GET", "/api/v1/admin/colleges");
    assert.equal(ownColleges.status, 200, JSON.stringify(ownColleges.data));
    assert.deepEqual(
      ownColleges.data.colleges.map((college) => college.id),
      [COLLEGE_A],
    );

    const newBranch = await api(
      ordinaryA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      { name: "Promoted Admin Branch", slug: "promoted-admin-branch" },
    );
    assert.equal(newBranch.status, 201, JSON.stringify(newBranch.data));

    const cannotAssign = await api(
      ordinaryA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: collegeAdminA.email },
    );
    assert.equal(cannotAssign.status, 403, JSON.stringify(cannotAssign.data));

    const otherCollege = await api(
      ordinaryA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_B}`,
    );
    assert.equal(otherCollege.status, 403, JSON.stringify(otherCollege.data));

    const assignedB = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_B}/admins`,
      { email: ordinaryA.email },
    );
    assert.equal(assignedB.status, 200, JSON.stringify(assignedB.data));
    assert.equal(assignedB.data.admin.role, "college_admin");
    assert.deepEqual(
      assignedB.data.admin.collegeAdminOf.sort(),
      [COLLEGE_A, COLLEGE_B].sort(),
    );

    const bothColleges = await api(ordinaryA, "GET", "/api/v1/admin/colleges");
    assert.equal(bothColleges.status, 200);
    assert.deepEqual(
      bothColleges.data.colleges.map((college) => college.id).sort(),
      [COLLEGE_A, COLLEGE_B].sort(),
    );

    const removedA = await api(
      platformAdmin,
      "DELETE",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins/${ordinaryA.id}`,
    );
    assert.equal(removedA.status, 200, JSON.stringify(removedA.data));
    assert.equal(removedA.data.admin.role, "college_admin");
    assert.deepEqual(removedA.data.admin.collegeAdminOf, [COLLEGE_B]);

    const afterRemovalA = await api(
      ordinaryA,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
    );
    assert.equal(afterRemovalA.status, 403, JSON.stringify(afterRemovalA.data));

    const removedB = await api(
      platformAdmin,
      "DELETE",
      `/api/v1/admin/colleges/${COLLEGE_B}/admins/${ordinaryA.id}`,
    );
    assert.equal(removedB.status, 200, JSON.stringify(removedB.data));
    assert.equal(removedB.data.admin.role, "user");
    assert.deepEqual(removedB.data.admin.collegeAdminOf, []);

    const afterRemoval = await api(ordinaryA, "GET", "/api/v1/admin/colleges");
    assert.equal(afterRemoval.status, 403, JSON.stringify(afterRemoval.data));

    const platformRemoval = await api(
      platformAdmin,
      "DELETE",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins/${platformAdmin.id}`,
    );
    assert.equal(platformRemoval.status, 400, JSON.stringify(platformRemoval.data));

    const unknownEmail = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: `${PREFIX}-nobody@example.com` },
    );
    assert.equal(unknownEmail.status, 404, JSON.stringify(unknownEmail.data));

    const invalidEmail = await api(
      platformAdmin,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/admins`,
      { email: "not-an-email" },
    );
    assert.equal(invalidEmail.status, 400, JSON.stringify(invalidEmail.data));

    const assignAudit = await AuditLog.findOne({
      action: "college.admin.assign",
      entityId: ordinaryA.id,
      collegeId: COLLEGE_A,
    }).lean();
    assert.ok(assignAudit);
    assert.equal(assignAudit.actorId, platformAdmin.id);
    assert.equal(assignAudit.metadata.after.role, "college_admin");
    assert.equal(JSON.stringify(assignAudit).includes("password"), false);

    const removeAudit = await AuditLog.findOne({
      action: "college.admin.remove",
      entityId: ordinaryA.id,
      collegeId: COLLEGE_B,
    }).lean();
    assert.ok(removeAudit);
    assert.equal(removeAudit.actorId, platformAdmin.id);
    assert.equal(removeAudit.metadata.after.role, "user");
  });
});
