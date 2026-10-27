import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage1-authz-test-secret-0123456789abcdef";

import { connectStage1TestDb, disconnectStage1TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { Template, User } = await import("../src/models/index.js");
const { verifyToken, updateProfileForUser } = await import("../src/lib/auth.js");
const { createTemplate, getTemplateVersion } = await import("../src/lib/templateStore.js");
const {
  loadActor,
  loadActorById,
  requireCollegeAdmin,
  requirePersistedActor,
  requirePlatformAdmin,
} = await import("../src/lib/roles.js");

let server;
let base;

const EMAIL_RE = /^stage1-authz-.*@example\.com$/;

async function cleanup() {
  await User.deleteMany({ email: EMAIL_RE });
  await Template.deleteMany({ id: /^(stage1-authz-|ordinary-private-)/ });
}

before(async () => {
  await connectStage1TestDb("markly_stage1_auth_test");
  await cleanup();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup().catch(() => {});
  await disconnectStage1TestDb();
  if (!server) return;
  try {
    server.closeAllConnections?.();
  } catch {
    /* older node */
  }
  await new Promise((resolve) => server.close(resolve));
});

function uniq(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function raw(method, path, { body, cookie, auth } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, data, setCookies };
}

function sessionCookie(setCookies) {
  const cookie = setCookies.find((value) => value.startsWith("markly_token="));
  return cookie ? cookie.split(";")[0] : "";
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function runMiddleware(middleware, req) {
  const res = mockResponse();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe("STAGE 1 persisted-role authorization", () => {
  it("public registration ignores role/college-scope fields and persists an ordinary user", async () => {
    const email = uniq("stage1-authz-reg-");
    const registered = await raw("POST", "/api/v1/auth/register", {
      body: {
        email,
        password: "supersecret1",
        name: "Registration probe",
        role: "platform_admin",
        collegeAdminOf: ["tcet"],
        tenantIds: ["tcet"],
        preferences: { collegeId: "tcet", departmentId: "tcet-ce" },
      },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    assert.equal(verifyToken(registered.data.token).role, undefined, "tokens must not carry role claims");

    const persisted = await User.findOne({ email }).lean();
    assert.ok(persisted, "registration must be durable");
    assert.equal(persisted.role, "user");
    assert.deepEqual(persisted.collegeAdminOf, []);
    assert.deepEqual(persisted.tenantIds, []);
  });

  it("refuses to claim an existing legacy/admin account through public registration", async () => {
    const email = uniq("stage1-authz-legacy-account-");
    const id = `usr_stage1_authz_legacy_${Date.now()}`;
    await User.create({ id, email, name: "Legacy admin", role: "platform_admin" });

    const attempted = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1", name: "Claim attempt", role: "platform_admin" },
    });
    assert.equal(attempted.status, 409, JSON.stringify(attempted.data));

    const persisted = await User.findOne({ email }).lean();
    assert.equal(persisted.id, id);
    assert.equal(persisted.name, "Legacy admin");
    assert.equal(persisted.role, "platform_admin");
    assert.equal(persisted.passwordHash, undefined, "registration must not set a credential");
  });

  it("profile updates accept name/avatar only and cannot change role or scope", async () => {
    const email = uniq("stage1-authz-profile-");
    const registered = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(registered.status, 201);
    const cookie = sessionCookie(registered.setCookies);
    assert.ok(cookie);

    const patched = await raw("PATCH", "/api/v1/auth/profile", {
      cookie,
      body: {
        name: "Stage 1 Profile",
        avatarUrl: "https://example.com/avatar.png",
        role: "platform_admin",
        collegeAdminOf: ["tcet"],
        tenantIds: ["tcet"],
        preferences: { collegeId: "tcet" },
      },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal(Object.prototype.hasOwnProperty.call(patched.data.user, "role"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(patched.data.user, "collegeAdminOf"), false);

    const persisted = await User.findOne({ email }).lean();
    assert.equal(persisted.name, "Stage 1 Profile");
    assert.equal(persisted.avatarUrl, "https://example.com/avatar.png");
    assert.equal(persisted.role, "user");
    assert.deepEqual(persisted.collegeAdminOf, []);
    assert.deepEqual(persisted.tenantIds, []);

    await assert.rejects(
      () => updateProfileForUser(persisted.id, { role: "platform_admin" }),
      /No profile fields to update/,
    );
  });

  it("loads the current persisted actor and ignores forged token role claims", async () => {
    const platformId = "usr_stage1_authz_platform";
    const collegeAdminId = "usr_stage1_authz_college_admin";
    const ordinaryId = "usr_stage1_authz_ordinary";
    await User.create([
      {
        id: platformId,
        email: "stage1-authz-platform@example.com",
        name: "Platform",
        role: "platform_admin",
      },
      {
        id: collegeAdminId,
        email: "stage1-authz-college-admin@example.com",
        name: "College A admin",
        role: "college_admin",
        collegeAdminOf: ["college-a"],
      },
      {
        id: ordinaryId,
        email: "stage1-authz-ordinary@example.com",
        name: "Ordinary",
        role: "user",
      },
    ]);

    const platformActor = await loadActorById(platformId);
    assert.equal(platformActor.role, "platform_admin");
    assert.deepEqual(platformActor.collegeAdminOf, []);

    const forged = await loadActor({ user: { sub: ordinaryId, email: "stage1-authz-ordinary@example.com", role: "platform_admin" } });
    assert.equal(forged.role, "user", "token role claims are never trusted");

    const platformWithDowngradedClaim = await loadActor({ user: { sub: platformId, role: "user" } });
    assert.equal(platformWithDowngradedClaim.role, "platform_admin");

    const ordinaryAsPlatform = await runMiddleware(requirePlatformAdmin, {
      user: { sub: ordinaryId, role: "platform_admin" },
    });
    assert.equal(ordinaryAsPlatform.nextCalled, false);
    assert.equal(ordinaryAsPlatform.res.statusCode, 403);

    const platformAllowed = await runMiddleware(requirePlatformAdmin, {
      user: { sub: platformId, role: "user" },
    });
    assert.equal(platformAllowed.nextCalled, true);
    assert.equal(platformAllowed.res.statusCode, 200);
  });

  it("enforces college scope and denies cross-college access", async () => {
    const collegeAdminId = "usr_stage1_authz_college_admin";
    const platformId = "usr_stage1_authz_platform";
    const ordinaryId = "usr_stage1_authz_ordinary";

    const ownCollege = await runMiddleware(requireCollegeAdmin("college-a"), {
      user: { sub: collegeAdminId, role: "college_admin" },
    });
    assert.equal(ownCollege.nextCalled, true);

    const otherCollege = await runMiddleware(requireCollegeAdmin("college-b"), {
      user: { sub: collegeAdminId, role: "college_admin" },
    });
    assert.equal(otherCollege.nextCalled, false);
    assert.equal(otherCollege.res.statusCode, 403);

    const platformAnyCollege = await runMiddleware(requireCollegeAdmin("college-b"), {
      user: { sub: platformId, role: "platform_admin" },
    });
    assert.equal(platformAnyCollege.nextCalled, true);

    const ordinaryDenied = await runMiddleware(requireCollegeAdmin("college-a"), {
      user: { sub: ordinaryId, role: "platform_admin" },
    });
    assert.equal(ordinaryDenied.nextCalled, false);
    assert.equal(ordinaryDenied.res.statusCode, 403);
  });

  it("re-evaluates a changed role from MongoDB without issuing a new token", async () => {
    const id = "usr_stage1_authz_promote";
    const email = "stage1-authz-promote@example.com";
    await User.create({ id, email, name: "Promote", role: "user" });

    const before = await loadActorById(id);
    assert.equal(before.role, "user");
    const denied = await runMiddleware(requirePlatformAdmin, { user: { sub: id } });
    assert.equal(denied.nextCalled, false);

    await User.updateOne({ id }, { $set: { role: "platform_admin" } });
    const after = await loadActorById(id);
    assert.equal(after.role, "platform_admin");
    const allowed = await runMiddleware(requirePlatformAdmin, { user: { sub: id } });
    assert.equal(allowed.nextCalled, true);

    await User.deleteOne({ id });
  });

  it("blocks ordinary users from mutating/publishing shared templates at the HTTP route", async () => {
    const sharedId = `stage1-authz-shared-${Date.now()}`;
    createTemplate({
      id: sharedId,
      name: "Stage 1 shared template",
      scope: "college",
      tenantId: "college-a",
      departmentId: "dept-a1",
      status: "draft",
    });

    const ordinaryEmail = uniq("stage1-authz-shared-user-");
    const ordinaryReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: ordinaryEmail, password: "supersecret1" },
    });
    assert.equal(ordinaryReg.status, 201);
    const ordinaryCookie = sessionCookie(ordinaryReg.setCookies);

    const deniedStatus = await raw("PUT", `/api/v1/templates/${sharedId}`, {
      cookie: ordinaryCookie,
      body: { status: "active" },
    });
    assert.equal(deniedStatus.status, 403, "ordinary users must not publish a shared template");

    const deniedName = await raw("PUT", `/api/v1/templates/${sharedId}`, {
      cookie: ordinaryCookie,
      body: { name: "Ordinary rename attempt" },
    });
    assert.equal(deniedName.status, 403, "ordinary users must not mutate a shared template");

    const deniedCreate = await raw("POST", "/api/v1/templates", {
      cookie: ordinaryCookie,
      body: { name: "Ordinary shared create", scope: "college", tenantId: "college-a" },
    });
    assert.equal(deniedCreate.status, 403, "ordinary users must not create college templates");

    const privateCreate = await raw("POST", "/api/v1/templates", {
      cookie: ordinaryCookie,
      body: { name: `Ordinary private ${Date.now()}` },
    });
    assert.equal(privateCreate.status, 201);
    assert.equal(privateCreate.data.template.scope, "private");
    assert.equal(privateCreate.data.template.ownerUserId, verifyToken(ordinaryReg.data.token).sub);

    const ownPrivatePublish = await raw("PUT", `/api/v1/templates/${privateCreate.data.template.id}`, {
      cookie: ordinaryCookie,
      body: { status: "active" },
    });
    assert.equal(ownPrivatePublish.status, 200, "a private owner may activate their own copy");

    const invalidStatus = await raw("PUT", `/api/v1/templates/${privateCreate.data.template.id}`, {
      cookie: ordinaryCookie,
      body: { status: "deleted" },
    });
    assert.equal(invalidStatus.status, 400, "status must stay inside the defined lifecycle");

    const otherEmail = uniq("stage1-authz-shared-other-");
    const otherReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: otherEmail, password: "supersecret1" },
    });
    assert.equal(otherReg.status, 201);
    const otherCookie = sessionCookie(otherReg.setCookies);
    const otherPrivatePublish = await raw("PUT", `/api/v1/templates/${privateCreate.data.template.id}`, {
      cookie: otherCookie,
      body: { status: "active" },
    });
    assert.equal(otherPrivatePublish.status, 403, "another user must not touch a private template");

    const platformEmail = uniq("stage1-authz-shared-platform-");
    const platformReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: platformEmail, password: "supersecret1" },
    });
    assert.equal(platformReg.status, 201);
    await User.updateOne({ email: platformEmail }, { $set: { role: "platform_admin" } });
    const platformCookie = sessionCookie(platformReg.setCookies);
    const platformPublish = await raw("PUT", `/api/v1/templates/${sharedId}`, {
      cookie: platformCookie,
      body: { status: "active" },
    });
    assert.equal(platformPublish.status, 200, "a persisted platform admin may publish shared templates");
    assert.equal(getTemplateVersion(sharedId).status, "active");
  });

  it("hides legacy and other users' private templates from the HTTP catalogue", async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const legacyId = `stage1-authz-legacy-${suffix}`;
    const privateId = `stage1-authz-private-${suffix}`;

    const ownerEmail = uniq("stage1-authz-catalogue-owner-");
    const ownerReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: ownerEmail, password: "supersecret1" },
    });
    assert.equal(ownerReg.status, 201);
    const ownerCookie = sessionCookie(ownerReg.setCookies);
    const ownerId = verifyToken(ownerReg.data.token).sub;

    createTemplate({ id: legacyId, name: "Stage 1 legacy template", scope: "legacy", status: "active" });
    createTemplate({
      id: privateId,
      name: "Stage 1 private template",
      scope: "private",
      ownerUserId: ownerId,
      status: "draft",
    });

    const ownerList = await raw("GET", "/api/v1/templates", { cookie: ownerCookie });
    assert.equal(ownerList.status, 200);
    const ownerIds = ownerList.data.templates.map((t) => t.id);
    assert.equal(ownerIds.includes(privateId), true, "owners see their own private template");
    assert.equal(ownerIds.includes(legacyId), false, "legacy templates are platform-admin-only");
    assert.equal((await raw("GET", `/api/v1/templates/${legacyId}`, { cookie: ownerCookie })).status, 404);
    assert.equal((await raw("GET", `/api/v1/templates/${privateId}`, { cookie: ownerCookie })).status, 200);

    const otherEmail = uniq("stage1-authz-catalogue-other-");
    const otherReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: otherEmail, password: "supersecret1" },
    });
    assert.equal(otherReg.status, 201);
    const otherCookie = sessionCookie(otherReg.setCookies);
    const otherList = await raw("GET", "/api/v1/templates", { cookie: otherCookie });
    const otherIds = otherList.data.templates.map((t) => t.id);
    assert.equal(otherIds.includes(privateId), false, "another user must not see a private template");
    assert.equal(otherIds.includes(legacyId), false);
    assert.equal((await raw("GET", `/api/v1/templates/${privateId}`, { cookie: otherCookie })).status, 404);

    const platformEmail = uniq("stage1-authz-catalogue-platform-");
    const platformReg = await raw("POST", "/api/v1/auth/register", {
      body: { email: platformEmail, password: "supersecret1" },
    });
    assert.equal(platformReg.status, 201);
    await User.updateOne({ email: platformEmail }, { $set: { role: "platform_admin" } });
    const platformCookie = sessionCookie(platformReg.setCookies);

    const platformList = await raw("GET", "/api/v1/templates", { cookie: platformCookie });
    const platformIds = platformList.data.templates.map((t) => t.id);
    assert.equal(platformIds.includes(legacyId), true, "platform admins review legacy templates");
    assert.equal(platformIds.includes(privateId), false, "even platform admins cannot see private templates");
    assert.equal((await raw("GET", `/api/v1/templates/${legacyId}`, { cookie: platformCookie })).status, 200);
    assert.equal((await raw("GET", `/api/v1/templates/${privateId}`, { cookie: platformCookie })).status, 404);
  });

  it("rejects tokens for unknown users and missing authentication", async () => {
    const unknown = await runMiddleware(requirePersistedActor, { user: { sub: "usr_stage1_authz_missing" } });
    assert.equal(unknown.nextCalled, false);
    assert.equal(unknown.res.statusCode, 401);

    const anonymous = await runMiddleware(requirePersistedActor, {});
    assert.equal(anonymous.nextCalled, false);
    assert.equal(anonymous.res.statusCode, 401);

    assert.equal(await loadActorById(""), null);
    assert.equal(await loadActorById("usr_stage1_authz_missing"), null);
  });
});
