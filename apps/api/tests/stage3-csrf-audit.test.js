import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// NODE_ENV=test keeps index.js from starting its own listener. The CSRF
// middleware reads the environment per request, so individual tests switch to
// production and back while exercising the real mounted middleware.
process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage3-csrf-audit-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";
delete process.env.ALLOWED_ORIGINS;
delete process.env.TEMPLATE_PERSISTENCE_REQUIRED;

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
// index.js calls dotenv.config(); tests own these values after import.
delete process.env.ALLOWED_ORIGINS;
delete process.env.TEMPLATE_PERSISTENCE_REQUIRED;

const { AuditLog, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { recordAudit } = await import("../src/lib/audit.js");
const { startServer, stopServer, cookieFor, bearerFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage3_csrf_audit_test";
const PREFIX = "stage3-csrf";
const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;

let db;
let server;
let base;
let platformAdmin;
let collegeAdminA;
let unique = 0;

function api(user, method, path, body, headers = {}) {
  return request(base, method, path, {
    ...(user ? { cookie: cookieFor(user) } : {}),
    body,
    headers,
  });
}

function collegeBody(label) {
  unique += 1;
  return {
    name: `Stage3 CSRF ${label} ${unique}`,
    slug: `stage3-csrf-${label}-${unique}`,
  };
}

async function withEnv(values, fn) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = String(values[key]);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
    name: "Stage3 CSRF Platform",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: `${PREFIX}-usr-college-a`,
    email: `${PREFIX}-college-a@example.com`,
    name: "Stage3 CSRF College A",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_A],
    tenantIds: [COLLEGE_A],
  });

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage3 CSRF College A", slug: "stage3-csrf-college-a" },
    { id: COLLEGE_B, name: "Stage3 CSRF College B", slug: "stage3-csrf-college-b" },
  ]);
  await Department.create([
    { id: BRANCH_A1, tenantId: COLLEGE_A, name: "A1", slug: "a1" },
  ]);

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await cleanup().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage3TestDb();
});

describe("STAGE 3 CSRF protection and audit integrity", () => {
  it("blocks production cookie mutations without a trusted Origin and permits same-origin/Bearer", async () => {
    await withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: undefined }, async () => {
      const body = collegeBody("no-origin");
      const blocked = await api(platformAdmin, "POST", "/api/v1/admin/colleges", body);
      assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
      assert.match(blocked.data.error, /cross-site/i);
      assert.equal(await Tenant.countDocuments({ slug: body.slug }), 0);

      const foreignBody = collegeBody("foreign-origin");
      const foreign = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { origin: "https://evil.example" },
        body: foreignBody,
      });
      assert.equal(foreign.status, 403, JSON.stringify(foreign.data));
      assert.equal(await Tenant.countDocuments({ slug: foreignBody.slug }), 0);

      const refererBody = collegeBody("foreign-referer");
      const foreignReferer = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { referer: "https://evil.example/some/page" },
        body: refererBody,
      });
      assert.equal(foreignReferer.status, 403, JSON.stringify(foreignReferer.data));
      assert.equal(await Tenant.countDocuments({ slug: refererBody.slug }), 0);

      // Same-origin is accepted even without an ALLOWED_ORIGINS entry.
      const sameOriginBody = collegeBody("same-origin");
      const sameOrigin = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { origin: base },
        body: sameOriginBody,
      });
      assert.equal(sameOrigin.status, 201, JSON.stringify(sameOrigin.data));

      const sameRefererBody = collegeBody("same-referer");
      const sameReferer = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { referer: `${base}/admin` },
        body: sameRefererBody,
      });
      assert.equal(sameReferer.status, 201, JSON.stringify(sameReferer.data));

      const bearerBody = collegeBody("bearer");
      const bearer = await request(base, "POST", "/api/v1/admin/colleges", {
        auth: bearerFor(platformAdmin),
        body: bearerBody,
      });
      assert.equal(bearer.status, 201, JSON.stringify(bearer.data));

      // A valid Bearer token bypasses the ambient-cookie check even when a
      // cookie is also present.
      const bothBody = collegeBody("both");
      const both = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        auth: bearerFor(platformAdmin),
        body: bothBody,
      });
      assert.equal(both.status, 201, JSON.stringify(both.data));

      const get = await api(platformAdmin, "GET", "/api/v1/admin/dashboard");
      assert.equal(get.status, 200, JSON.stringify(get.data));

      const invalidCookie = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: "markly_token=not-a-valid-token",
        body: collegeBody("invalid-cookie"),
      });
      assert.equal(invalidCookie.status, 401, JSON.stringify(invalidCookie.data));
    });

    await withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: base }, async () => {
      const allowedBody = collegeBody("allowlisted");
      const allowed = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { origin: base },
        body: allowedBody,
      });
      assert.equal(allowed.status, 201, JSON.stringify(allowed.data));

      const notAllowedBody = collegeBody("not-allowlisted");
      const notAllowed = await request(base, "POST", "/api/v1/admin/colleges", {
        cookie: cookieFor(platformAdmin),
        headers: { origin: "https://another.example" },
        body: notAllowedBody,
      });
      assert.equal(notAllowed.status, 403, JSON.stringify(notAllowed.data));
    });

    // The same production guard protects template mutations.
    await withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: undefined }, async () => {
      const blockedTemplate = await api(platformAdmin, "POST", "/api/v1/templates", {
        name: "Stage3 CSRF Blocked Private Template",
      });
      assert.equal(blockedTemplate.status, 403, JSON.stringify(blockedTemplate.data));
      assert.equal(
        await Template.countDocuments({ name: "Stage3 CSRF Blocked Private Template" }),
        0,
      );

      const bearerTemplate = await request(base, "POST", "/api/v1/templates", {
        auth: bearerFor(platformAdmin),
        body: { name: "Stage3 CSRF Bearer Private Template" },
      });
      assert.equal(bearerTemplate.status, 201, JSON.stringify(bearerTemplate.data));
    });

    // Outside production the historical cookie behavior is preserved.
    const nonProductionBody = collegeBody("non-production");
    const nonProduction = await api(
      platformAdmin,
      "POST",
      "/api/v1/admin/colleges",
      nonProductionBody,
    );
    assert.equal(nonProduction.status, 201, JSON.stringify(nonProduction.data));
  });

  it("records scoped administrative audit entries with safe before/after metadata", async () => {
    const body = collegeBody("audit");
    const created = await api(platformAdmin, "POST", "/api/v1/admin/colleges", {
      ...body,
      metadata: { city: "Mumbai", nested: { accreditation: "NAAC" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const collegeId = created.data.college.id;

    const createAudit = await AuditLog.findOne({
      action: "college.create",
      entityId: collegeId,
    }).lean();
    assert.ok(createAudit);
    assert.equal(createAudit.actorId, platformAdmin.id);
    assert.equal(createAudit.actorEmail, platformAdmin.email);
    assert.equal(createAudit.entityType, "college");
    assert.equal(createAudit.collegeId, collegeId);
    assert.ok(createAudit.createdAt instanceof Date);
    assert.equal(createAudit.metadata.slug, body.slug);

    const updated = await api(
      platformAdmin,
      "PATCH",
      `/api/v1/admin/colleges/${collegeId}`,
      {
        name: "Stage3 CSRF Audit Renamed",
        metadata: {
          password: "super-secret-password",
          passwordHash: "super-secret-hash",
          apiKey: "super-secret-api-key",
          token: "super-secret-token",
          authorization: "Bearer super-secret-bearer",
          cookie: "markly_token=super-secret-cookie",
          safe: "visible",
        },
      },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.data));

    const updateAudit = await AuditLog.findOne({
      action: "college.update",
      entityId: collegeId,
    })
      .sort({ createdAt: -1 })
      .lean();
    assert.ok(updateAudit);
    assert.equal(updateAudit.actorId, platformAdmin.id);
    assert.equal(updateAudit.collegeId, collegeId);
    assert.equal(updateAudit.metadata.after.metadata.password, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.passwordHash, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.apiKey, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.token, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.authorization, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.cookie, "[redacted]");
    assert.equal(updateAudit.metadata.after.metadata.safe, "visible");
    assert.equal(updateAudit.metadata.before.name, body.name);
    assert.equal(updateAudit.metadata.before.metadata.city, "Mumbai");

    const secretValues = [
      "super-secret-password",
      "super-secret-hash",
      "super-secret-api-key",
      "super-secret-token",
      "super-secret-bearer",
      "super-secret-cookie",
    ];
    const updateJson = JSON.stringify(updateAudit);
    for (const secret of secretValues) {
      assert.equal(updateJson.includes(secret), false, `audit leaked ${secret}`);
    }

    const auditList = await api(platformAdmin, "GET", "/api/v1/admin/audit?limit=100");
    assert.equal(auditList.status, 200, JSON.stringify(auditList.data));
    const listJson = JSON.stringify(auditList.data);
    for (const secret of secretValues) {
      assert.equal(listJson.includes(secret), false, `audit API leaked ${secret}`);
    }
    assert.equal(
      auditList.data.actions.some(
        (entry) =>
          entry.action === "college.update" &&
          entry.entityId === collegeId &&
          entry.actorEmail === platformAdmin.email,
      ),
      true,
    );

    // College admins only see audit entries in their persisted scope.
    const branch = await api(
      collegeAdminA,
      "POST",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches`,
      { name: "Stage3 CSRF Audit Branch", slug: "stage3-csrf-audit-branch" },
    );
    assert.equal(branch.status, 201, JSON.stringify(branch.data));

    const other = await api(platformAdmin, "POST", "/api/v1/admin/colleges", collegeBody("audit-b"));
    assert.equal(other.status, 201, JSON.stringify(other.data));
    const scoped = await api(collegeAdminA, "GET", "/api/v1/admin/audit?limit=100");
    assert.equal(scoped.status, 200, JSON.stringify(scoped.data));
    assert.equal(scoped.data.actions.length > 0, true);
    assert.equal(
      scoped.data.actions.every((entry) => entry.collegeId === COLLEGE_A),
      true,
    );
    assert.equal(
      scoped.data.actions.some((entry) => entry.entityId === branch.data.branch.id),
      true,
    );
    assert.equal(
      scoped.data.actions.some((entry) => entry.collegeId === other.data.college.id),
      false,
    );
  });

  it("redacts direct audit metadata and bounds oversized metadata", async () => {
    const secrets = {
      password: "direct-secret-password",
      passwordHash: "direct-secret-hash",
      token: "direct-secret-token",
      authorization: "Bearer direct-secret-bearer",
      cookie: "markly_token=direct-secret-cookie",
      apiKey: "direct-secret-api-key",
      privateKey: "direct-secret-private-key",
      nested: { clientSecret: "direct-secret-client" },
      list: [{ credential: "direct-secret-credential" }],
      safe: "visible",
    };
    await recordAudit({
      actor: { id: platformAdmin.id, email: platformAdmin.email },
      action: "stage3.audit.secrecy",
      entityType: "test",
      entityId: "stage3-audit-secrecy",
      collegeId: COLLEGE_A,
      metadata: secrets,
    });

    const doc = await AuditLog.findOne({
      action: "stage3.audit.secrecy",
      entityId: "stage3-audit-secrecy",
    }).lean();
    assert.ok(doc);
    assert.equal(doc.actorId, platformAdmin.id);
    assert.equal(doc.collegeId, COLLEGE_A);
    assert.equal(doc.metadata.password, "[redacted]");
    assert.equal(doc.metadata.passwordHash, "[redacted]");
    assert.equal(doc.metadata.token, "[redacted]");
    assert.equal(doc.metadata.authorization, "[redacted]");
    assert.equal(doc.metadata.cookie, "[redacted]");
    assert.equal(doc.metadata.apiKey, "[redacted]");
    assert.equal(doc.metadata.privateKey, "[redacted]");
    assert.equal(doc.metadata.nested.clientSecret, "[redacted]");
    assert.equal(doc.metadata.list[0].credential, "[redacted]");
    assert.equal(doc.metadata.safe, "visible");

    const json = JSON.stringify(doc);
    for (const value of [
      "direct-secret-password",
      "direct-secret-hash",
      "direct-secret-token",
      "direct-secret-bearer",
      "direct-secret-cookie",
      "direct-secret-api-key",
      "direct-secret-private-key",
      "direct-secret-client",
      "direct-secret-credential",
    ]) {
      assert.equal(json.includes(value), false, `audit leaked ${value}`);
    }
    assert.equal(json.includes("\"safe\":\"visible\""), true);

    await recordAudit({
      actor: { id: platformAdmin.id, email: platformAdmin.email },
      action: "stage3.audit.oversized",
      entityType: "test",
      entityId: "stage3-audit-oversized",
      metadata: { items: Array.from({ length: 50 }, () => "y".repeat(500)) },
    });
    const oversized = await AuditLog.findOne({
      action: "stage3.audit.oversized",
      entityId: "stage3-audit-oversized",
    }).lean();
    assert.ok(oversized);
    assert.equal(oversized.metadata.note, "metadata omitted (too large)");
  });

  it("returns an explicit 500 instead of claiming success when audit persistence fails", async () => {
    const originalCreate = AuditLog.create;
    const body = collegeBody("audit-failure");
    try {
      AuditLog.create = async () => {
        throw new Error("simulated audit store outage");
      };
      const response = await api(platformAdmin, "POST", "/api/v1/admin/colleges", body);
      assert.equal(response.status, 500, JSON.stringify(response.data));
      assert.match(response.data.error, /audit record could not be written/i);
    } finally {
      AuditLog.create = originalCreate;
    }

    // The mutation may already be saved, but the response must never claim
    // success without a durable audit record.
    assert.ok(await Tenant.findOne({ slug: body.slug }).lean());
    assert.equal(
      await AuditLog.countDocuments({ action: "college.create", entityId: body.slug }),
      0,
    );

    const created = await api(collegeAdminA, "POST", "/api/v1/templates", {
      name: "Stage3 CSRF Audit Failure Template",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      status: "draft",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const templateId = created.data.template.id;

    try {
      AuditLog.create = async () => {
        throw new Error("simulated audit store outage");
      };
      const published = await api(
        collegeAdminA,
        "POST",
        `/api/v1/templates/${templateId}/publish`,
        { footer: { text: "publish without audit" } },
      );
      assert.equal(published.status, 500, JSON.stringify(published.data));
      assert.match(published.data.error, /audit record could not be written/i);
    } finally {
      AuditLog.create = originalCreate;
    }

    const versionTwo = await Template.findOne({ id: templateId, version: 2 }).lean();
    assert.ok(versionTwo);
    assert.equal(versionTwo.status, "published");
    assert.equal(
      await AuditLog.countDocuments({
        action: "template.publish",
        entityId: templateId,
        "metadata.after.version": 2,
      }),
      0,
    );
  });

  it("audits template create, publish and archive with actor and college scope", async () => {
    const created = await api(collegeAdminA, "POST", "/api/v1/templates", {
      name: "Stage3 CSRF Audited Lifecycle",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      status: "draft",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;

    const published = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/publish`,
      { footer: { text: "audited published" } },
    );
    assert.equal(published.status, 200, JSON.stringify(published.data));

    const archived = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/archive`,
      {},
    );
    assert.equal(archived.status, 200, JSON.stringify(archived.data));

    for (const action of ["template.create", "template.publish", "template.archive"]) {
      const entry = await AuditLog.findOne({ action, entityId: id }).lean();
      assert.ok(entry, `missing audit entry for ${action}`);
      assert.equal(entry.actorId, collegeAdminA.id);
      assert.equal(entry.actorEmail, collegeAdminA.email);
      assert.equal(entry.entityType, "template");
      assert.equal(entry.collegeId, COLLEGE_A);
      assert.ok(entry.createdAt);
    }

    const list = await api(collegeAdminA, "GET", "/api/v1/admin/audit?limit=100");
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const actions = list.data.actions.filter((entry) => entry.entityId === id);
    assert.deepEqual(
      actions.map((entry) => entry.action).sort(),
      ["template.archive", "template.create", "template.publish"],
    );
  });

  it("fails closed when audit persistence is required but MongoDB is unavailable", async () => {
    await disconnectStage3TestDb();
    try {
      const memoryOnly = await recordAudit({
        actor: { id: platformAdmin.id, email: platformAdmin.email },
        action: "stage3.audit.offline",
        entityType: "test",
        entityId: "stage3-audit-offline",
      });
      assert.equal(memoryOnly, null);

      await withEnv({ TEMPLATE_PERSISTENCE_REQUIRED: "1" }, async () => {
        await assert.rejects(
          () =>
            recordAudit({
              actor: { id: platformAdmin.id, email: platformAdmin.email },
              action: "stage3.audit.offline-required",
              entityType: "test",
              entityId: "stage3-audit-offline-required",
            }),
          /Audit persistence is unavailable/,
        );
      });

      await withEnv({ NODE_ENV: "production" }, async () => {
        await assert.rejects(
          () =>
            recordAudit({
              actor: { id: platformAdmin.id, email: platformAdmin.email },
              action: "stage3.audit.offline-production",
              entityType: "test",
              entityId: "stage3-audit-offline-production",
            }),
          /Audit persistence is unavailable/,
        );
      });
    } finally {
      db = await connectStage3TestDb(TEST_DB);
    }
  });
});
