import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage4-preferences-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage4TestDb, disconnectStage4TestDb } from "./helpers/testDb.js";
import { cookieFor, request, startServer, stopServer } from "./helpers/stage2Http.js";

const { default: app } = await import("../src/index.js");
const { Department, Template, Tenant, User } = await import("../src/models/index.js");
const { resolveTemplateForGeneration } = await import("../src/lib/templateResolution.js");

const TEST_DB = "markly_stage4_preferences_test";
const PREFIX = "stage4-pref";

const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const COLLEGE_INACTIVE = `${PREFIX}-college-inactive`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;
const BRANCH_A2 = `${PREFIX}-branch-a2`;
const BRANCH_B1 = `${PREFIX}-branch-b1`;
const BRANCH_INACTIVE = `${PREFIX}-branch-inactive`;

const TEMPLATE_A_DEFAULT = `${PREFIX}-a-default`;
const TEMPLATE_A_OTHER = `${PREFIX}-a-other`;
const TEMPLATE_A_PLATFORM = `${PREFIX}-a-platform`;
const TEMPLATE_A_DRAFT = `${PREFIX}-a-draft`;
const TEMPLATE_A_ARCHIVED = `${PREFIX}-a-archived`;
const TEMPLATE_B = `${PREFIX}-b-template`;
const TEMPLATE_A_PRIVATE = `${PREFIX}-a-private`;
const TEMPLATE_B_PRIVATE = `${PREFIX}-b-private`;
const TEMPLATE_E_PRIVATE = `${PREFIX}-e-private`;

const USER_A = `${PREFIX}-user-a`;
const USER_B = `${PREFIX}-user-b`;
const USER_C = `${PREFIX}-user-c`;
const USER_D = `${PREFIX}-user-d`;
const USER_E = `${PREFIX}-user-e`;

const USERS = {
  [USER_A]: { email: `${USER_A}@example.com`, name: "Stage 4 User A", tenantIds: [COLLEGE_A] },
  [USER_B]: { email: `${USER_B}@example.com`, name: "Stage 4 User B", tenantIds: [COLLEGE_B] },
  [USER_C]: { email: `${USER_C}@example.com`, name: "Stage 4 User C", tenantIds: [] },
  [USER_D]: { email: `${USER_D}@example.com`, name: "Stage 4 User D", tenantIds: [COLLEGE_A] },
  [USER_E]: { email: `${USER_E}@example.com`, name: "Stage 4 User E", tenantIds: [] },
};

function stubContent() {
  return {
    experimentNumber: 7,
    title: "Explore subqueries in SQL",
    aim: "Explore subqueries in SQL",
    objectives: ["Understand single-row subqueries with IN and EXISTS"],
    theory: ["A subquery is a query nested inside another query for filtering."],
    steps: [
      {
        number: 1,
        title: "Set up tables",
        description: ["Create the student and enrollment tables first."],
        code: null,
        language: null,
      },
    ],
    conclusion: "Subqueries let us compose complex filters from simple parts.",
    metadata: {},
  };
}

function startAiStub() {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/generate" && req.method === "POST") {
        return send(200, {
          content: stubContent(),
          sources: [],
          provider: "stub",
          model: "stub-1",
          promptVersion: "stage4",
          validation: { ok: true },
          researchProvider: "none",
        });
      }
      if (req.url === "/v1/regenerate-section" && req.method === "POST") {
        return send(200, { value: "Regenerated" });
      }
      return send(404, { error: "stub: unknown route" });
    });
  });
  return server;
}

function cookie(userId) {
  return cookieFor({ id: userId, email: USERS[userId].email });
}

function getPreferences(userId, query = "") {
  return request(base, "GET", `/api/v1/preferences${query}`, { cookie: cookie(userId) });
}

function putPreferences(userId, body) {
  return request(base, "PUT", "/api/v1/preferences", { body, cookie: cookie(userId) });
}

function generate(userId, body = {}) {
  return request(base, "POST", "/api/v1/assignments/generate", {
    body: { aim: "Explore subqueries in SQL", subject: "DBMS", ...body },
    cookie: cookie(userId),
  });
}

function enqueueJob(userId, input = {}) {
  return request(base, "POST", "/api/v1/jobs", {
    body: { type: "generate", input: { aim: "Explore subqueries in SQL", subject: "DBMS", ...input } },
    cookie: cookie(userId),
  });
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const poll = await request(base, "GET", `/api/v1/jobs/${jobId}`, { cookie: cookie(USER_A) });
    assert.equal(poll.status, 200);
    if (poll.data?.job?.status === "failed") {
      assert.fail(`job failed: ${poll.data.job.error}`);
    }
    if (poll.data?.job?.status === "completed") return poll.data.job;
  }
  assert.fail("job did not complete in time");
}

let server;
let base;
let stub;
let originalAiUrl;

before(async () => {
  await connectStage4TestDb(TEST_DB);
  const db = (await import("mongoose")).default.connection.db;
  await db.dropDatabase();

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage 4 College A", slug: COLLEGE_A, status: "active" },
    { id: COLLEGE_B, name: "Stage 4 College B", slug: COLLEGE_B, status: "active" },
    {
      id: COLLEGE_INACTIVE,
      name: "Stage 4 Inactive College",
      slug: COLLEGE_INACTIVE,
      status: "inactive",
    },
  ]);

  await Department.create([
    {
      id: BRANCH_A1,
      tenantId: COLLEGE_A,
      name: "Stage 4 Branch A1",
      slug: BRANCH_A1,
      status: "active",
      defaultTemplateId: TEMPLATE_A_DEFAULT,
      defaultTemplateVersion: 1,
    },
    {
      id: BRANCH_A2,
      tenantId: COLLEGE_A,
      name: "Stage 4 Branch A2",
      slug: BRANCH_A2,
      status: "active",
    },
    {
      id: BRANCH_B1,
      tenantId: COLLEGE_B,
      name: "Stage 4 Branch B1",
      slug: BRANCH_B1,
      status: "active",
    },
    {
      id: BRANCH_INACTIVE,
      tenantId: COLLEGE_A,
      name: "Stage 4 Inactive Branch",
      slug: BRANCH_INACTIVE,
      status: "inactive",
    },
  ]);

  const template = (id, overrides = {}) => ({
    id,
    version: 1,
    name: id,
    status: "active",
    scope: "college",
    tenantId: COLLEGE_A,
    departmentId: BRANCH_A1,
    ownerUserId: null,
    page: { size: "A4", margin: { top: "110px", right: "18mm", bottom: "20mm", left: "18mm" } },
    typography: { fontFamily: "Georgia, serif", baseSize: "12pt", lineHeight: 1.6 },
    requiredSections: ["title", "aim", "objectives", "theory", "steps", "conclusion"],
    ...overrides,
  });

  await Template.create([
    template(TEMPLATE_A_DEFAULT, { version: 1 }),
    template(TEMPLATE_A_DEFAULT, { version: 2, name: `${TEMPLATE_A_DEFAULT}-v2` }),
    template(TEMPLATE_A_OTHER),
    template(TEMPLATE_A_PLATFORM, {
      scope: "platform",
      tenantId: null,
      departmentId: null,
    }),
    template(TEMPLATE_A_DRAFT, { status: "draft" }),
    template(TEMPLATE_A_ARCHIVED, { status: "archived" }),
    template(TEMPLATE_B, { tenantId: COLLEGE_B, departmentId: BRANCH_B1 }),
    template(TEMPLATE_A_PRIVATE, {
      scope: "private",
      ownerUserId: USER_A,
      tenantId: null,
      departmentId: null,
    }),
    template(TEMPLATE_B_PRIVATE, {
      scope: "private",
      ownerUserId: USER_B,
      tenantId: null,
      departmentId: null,
    }),
    template(TEMPLATE_E_PRIVATE, {
      scope: "private",
      ownerUserId: USER_E,
      tenantId: null,
      departmentId: null,
    }),
  ]);

  await User.create(
    Object.entries(USERS).map(([id, data]) => ({
      id,
      email: data.email,
      name: data.name,
      role: "user",
      tenantIds: data.tenantIds,
      preferences: null,
    })),
  );
  await User.updateOne(
    { id: USER_B },
    {
      $set: {
        preferences: {
          collegeId: COLLEGE_B,
          departmentId: BRANCH_B1,
          preferredTemplateId: null,
          preferredTemplateVersion: null,
          setupCompletedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    },
  );
  await User.updateOne(
    { id: USER_D },
    {
      $set: {
        preferences: {
          collegeId: COLLEGE_A,
          departmentId: BRANCH_A1,
          preferredTemplateId: null,
          preferredTemplateVersion: null,
        },
      },
    },
  );

  stub = startAiStub();
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  originalAiUrl = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${stub.address().port}`;

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  if (stub) await new Promise((resolve) => stub.close(resolve));
  if (originalAiUrl === undefined) delete process.env.AI_SERVICE_URL;
  else process.env.AI_SERVICE_URL = originalAiUrl;
  const db = (await import("mongoose")).default.connection.db;
  await db?.dropDatabase().catch(() => {});
  await disconnectStage4TestDb();
});

describe("STAGE 4 college/branch preferences", () => {
  it("reads only the authenticated user's preferences and never trusts a body user id", async () => {
    const anon = await request(base, "GET", "/api/v1/preferences");
    assert.equal(anon.status, 401);
    const anonPut = await request(base, "PUT", "/api/v1/preferences", {
      body: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
    });
    assert.equal(anonPut.status, 401);

    const a = await getPreferences(USER_A, `?userId=${USER_B}`);
    assert.equal(a.status, 200);
    assert.equal(a.data.setupCompleted, false);
    assert.equal(a.data.preferences.collegeId, null);

    const b = await getPreferences(USER_B);
    assert.equal(b.status, 200);
    assert.equal(b.data.preferences.collegeId, COLLEGE_B);
    assert.equal(b.data.preferences.departmentId, BRANCH_B1);

    const spoofed = await putPreferences(USER_A, {
      userId: USER_B,
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });
    assert.equal(spoofed.status, 200, JSON.stringify(spoofed.data));
    assert.equal(spoofed.data.preferences.collegeId, COLLEGE_A);

    const bAfter = await getPreferences(USER_B);
    assert.equal(bAfter.data.preferences.collegeId, COLLEGE_B, "B must not be modified");
    const aAfter = await getPreferences(USER_A);
    assert.equal(aAfter.data.preferences.collegeId, COLLEGE_A);
    assert.equal(aAfter.data.preferences.preferredTemplateId, TEMPLATE_A_OTHER);
  });

  it("saves exact college, branch and preferred template versions and exposes them in /auth/me", async () => {
    const saved = await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.setupCompleted, true);
    assert.equal(saved.data.college.id, COLLEGE_A);
    assert.equal(saved.data.branch.id, BRANCH_A1);
    assert.equal(saved.data.branch.defaultTemplate.id, TEMPLATE_A_DEFAULT);
    assert.equal(saved.data.branch.defaultTemplate.version, 1);
    assert.equal(saved.data.preferredTemplate.id, TEMPLATE_A_OTHER);
    assert.equal(saved.data.preferredTemplate.version, 1);
    assert.equal(saved.data.preferredTemplate.available, true);
    assert.ok(saved.data.preferences.setupCompletedAt);
    assert.equal(saved.data.preferences.preferredTemplateVersion, 1);

    const me = await request(base, "GET", "/api/v1/auth/me", { cookie: cookie(USER_A) });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.preferences.collegeId, COLLEGE_A);
    assert.equal(me.data.user.preferences.departmentId, BRANCH_A1);
    assert.equal(me.data.user.preferences.preferredTemplateId, TEMPLATE_A_OTHER);
    assert.equal(me.data.user.preferences.preferredTemplateVersion, 1);
    assert.ok(me.data.user.preferences.setupCompletedAt);
  });

  it("returns college-filtered options with the exact branch default and eligible templates", async () => {
    const options = await request(base, "GET", "/api/v1/preferences/options", {
      cookie: cookie(USER_A),
    });
    assert.equal(options.status, 200, JSON.stringify(options.data));

    const collegeA = options.data.colleges.find((college) => college.id === COLLEGE_A);
    assert.ok(collegeA);
    assert.deepEqual(
      collegeA.branches.map((branch) => branch.id).sort(),
      [BRANCH_A1, BRANCH_A2].sort(),
      "inactive branches must not be offered",
    );
    const branchA1 = collegeA.branches.find((branch) => branch.id === BRANCH_A1);
    assert.equal(branchA1.defaultTemplate.id, TEMPLATE_A_DEFAULT);
    assert.equal(branchA1.defaultTemplate.version, 1);
    assert.ok(branchA1.templates.some((template) => template.id === TEMPLATE_A_DEFAULT));
    assert.ok(branchA1.templates.some((template) => template.id === TEMPLATE_A_OTHER));
    assert.ok(!branchA1.templates.some((template) => template.id === TEMPLATE_A_DRAFT));
    assert.ok(!branchA1.templates.some((template) => template.id === TEMPLATE_A_ARCHIVED));
    assert.ok(!branchA1.templates.some((template) => template.id === TEMPLATE_B));

    assert.ok(options.data.personalTemplates.some((template) => template.id === TEMPLATE_A_PLATFORM));
    assert.ok(options.data.personalTemplates.some((template) => template.id === TEMPLATE_A_PRIVATE));
    assert.ok(!options.data.personalTemplates.some((template) => template.id === TEMPLATE_B_PRIVATE));
  });

  it("rejects branches outside the college and inactive/missing selections", async () => {
    const before = await getPreferences(USER_A);
    const cases = [
      [
        { collegeId: COLLEGE_A, departmentId: BRANCH_B1 },
        /does not belong|belong to this college/i,
      ],
      [
        { collegeId: COLLEGE_INACTIVE, departmentId: BRANCH_INACTIVE },
        /inactive/i,
      ],
      [
        { collegeId: COLLEGE_A, departmentId: BRANCH_INACTIVE },
        /inactive/i,
      ],
      [
        { collegeId: `${PREFIX}-missing-college`, departmentId: BRANCH_A1 },
        /not found|unavailable/i,
      ],
      [
        { collegeId: COLLEGE_A, departmentId: `${PREFIX}-missing-branch` },
        /does not belong|belong to this college/i,
      ],
      [{ collegeId: COLLEGE_A, departmentId: null }, /select a branch/i],
    ];
    for (const [body, pattern] of cases) {
      const res = await putPreferences(USER_A, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
      assert.match(res.data.error, pattern);
    }

    const after = await getPreferences(USER_A);
    assert.deepEqual(after.data.preferences, before.data.preferences);
  });

  it("rejects unpublished, archived, foreign and private templates that are not owned", async () => {
    const cases = [
      TEMPLATE_A_DRAFT,
      TEMPLATE_A_ARCHIVED,
      TEMPLATE_B,
      TEMPLATE_B_PRIVATE,
    ];
    for (const templateId of cases) {
      const res = await putPreferences(USER_A, {
        collegeId: COLLEGE_A,
        departmentId: BRANCH_A1,
        preferredTemplateId: templateId,
        preferredTemplateVersion: 1,
      });
      assert.equal(res.status, 404, `${templateId} -> ${res.status}`);
      assert.match(res.data.error, /unavailable/i);
    }

    const versionOnly = await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateVersion: 1,
    });
    assert.equal(versionOnly.status, 400);
    assert.match(versionOnly.data.error, /requires preferredTemplateId/i);

    const missing = await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: `${PREFIX}-missing-template`,
      preferredTemplateVersion: 1,
    });
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /unavailable/i);
  });

  it("supports a private-only setup path when the college is not listed", async () => {
    const saved = await putPreferences(USER_E, {
      collegeId: null,
      departmentId: null,
      preferredTemplateId: TEMPLATE_E_PRIVATE,
      preferredTemplateVersion: 1,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.setupCompleted, true);
    assert.equal(saved.data.college, null);
    assert.equal(saved.data.branch, null);
    assert.equal(saved.data.preferredTemplate.id, TEMPLATE_E_PRIVATE);
    assert.equal(saved.data.preferredTemplate.available, true);

    const foreign = await putPreferences(USER_E, {
      collegeId: null,
      departmentId: null,
      preferredTemplateId: TEMPLATE_B_PRIVATE,
      preferredTemplateVersion: 1,
    });
    assert.equal(foreign.status, 404);

    const collegeTemplate = await putPreferences(USER_E, {
      collegeId: null,
      departmentId: null,
      preferredTemplateId: TEMPLATE_A_DEFAULT,
      preferredTemplateVersion: 1,
    });
    assert.equal(collegeTemplate.status, 400);
    assert.match(collegeTemplate.data.error, /college and branch/i);

    const noTemplate = await putPreferences(USER_E, {
      collegeId: null,
      departmentId: null,
      preferredTemplateId: null,
      preferredTemplateVersion: null,
    });
    assert.equal(noTemplate.status, 200, JSON.stringify(noTemplate.data));
    assert.equal(noTemplate.data.setupCompleted, true);
    assert.equal(noTemplate.data.preferredTemplate, null);

    const noDefault = await generate(USER_E);
    assert.equal(noDefault.status, 409, JSON.stringify(noDefault.data));
    assert.match(noDefault.data.error, /choose a template|preferences/i);

    const explicit = await generate(USER_E, {
      templateId: TEMPLATE_A_PLATFORM,
      templateVersion: 1,
    });
    assert.equal(explicit.status, 200, JSON.stringify(explicit.data));
    assert.equal(explicit.data.template.id, TEMPLATE_A_PLATFORM);
    assert.equal(explicit.data.template.version, 1);
  });

  it("recognizes legacy college/branch preferences as completed setup", async () => {
    const legacy = await getPreferences(USER_D);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.setupCompleted, true);
    assert.equal(legacy.data.college.id, COLLEGE_A);
    assert.equal(legacy.data.branch.id, BRANCH_A1);

    const fresh = await getPreferences(USER_C);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.setupCompleted, false);
  });

  it("resolves explicit → preferred → exact branch default and never falls back on an invalid explicit id", async () => {
    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });

    const preferred = await generate(USER_A);
    assert.equal(preferred.status, 200, JSON.stringify(preferred.data));
    assert.equal(preferred.data.template.id, TEMPLATE_A_OTHER);
    assert.equal(preferred.data.template.version, 1);

    const explicit = await generate(USER_A, {
      templateId: TEMPLATE_A_PLATFORM,
      templateVersion: 1,
    });
    assert.equal(explicit.status, 200, JSON.stringify(explicit.data));
    assert.equal(explicit.data.template.id, TEMPLATE_A_PLATFORM);

    for (const [templateId, version] of [
      [TEMPLATE_B, 1],
      [TEMPLATE_A_ARCHIVED, 1],
      [`${PREFIX}-missing-template`, 1],
    ]) {
      const invalid = await generate(USER_A, { templateId, templateVersion: version });
      assert.equal(invalid.status, 404, `${templateId} -> ${invalid.status}`);
      assert.match(invalid.data.error, /unavailable/i);
    }

    const cleared = await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: null,
      preferredTemplateVersion: null,
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    const branchDefault = await generate(USER_A);
    assert.equal(branchDefault.status, 200, JSON.stringify(branchDefault.data));
    assert.equal(branchDefault.data.template.id, TEMPLATE_A_DEFAULT);
    assert.equal(
      branchDefault.data.template.version,
      1,
      "the branch default's pinned v1 must win over the template's latest v2",
    );

    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });
    await Template.updateOne(
      { id: TEMPLATE_A_OTHER, version: 1 },
      { $set: { status: "archived" } },
    );
    const stalePreferred = await generate(USER_A);
    assert.equal(stalePreferred.status, 200, JSON.stringify(stalePreferred.data));
    assert.equal(stalePreferred.data.template.id, TEMPLATE_A_DEFAULT);
    assert.equal(stalePreferred.data.template.version, 1);
    await Template.updateOne(
      { id: TEMPLATE_A_OTHER, version: 1 },
      { $set: { status: "active" } },
    );
  });

  it("returns actionable errors when the branch default is missing or unavailable", async () => {
    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: null,
      preferredTemplateVersion: null,
    });
    await Department.updateOne(
      { id: BRANCH_A1 },
      { $set: { defaultTemplateId: `${PREFIX}-missing-default`, defaultTemplateVersion: 1 } },
    );
    const missing = await generate(USER_A);
    assert.equal(missing.status, 409, JSON.stringify(missing.data));
    assert.match(missing.data.error, /default template/i);

    await Department.updateOne(
      { id: BRANCH_A1 },
      { $set: { defaultTemplateId: TEMPLATE_A_ARCHIVED, defaultTemplateVersion: 1 } },
    );
    const unavailable = await generate(USER_A);
    assert.equal(unavailable.status, 409, JSON.stringify(unavailable.data));
    assert.match(unavailable.data.error, /no longer available|default template/i);

    await Department.updateOne(
      { id: BRANCH_A1 },
      { $set: { defaultTemplateId: TEMPLATE_A_DEFAULT, defaultTemplateVersion: 1 } },
    );
  });

  it("requires setup for a Mongo-backed user with no preferences instead of silently using a global default", async () => {
    const res = await generate(USER_C);
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.match(res.data.error, /college and branch/i);

    const job = await enqueueJob(USER_C);
    assert.equal(job.status, 409, JSON.stringify(job.data));
    assert.match(job.data.error, /college and branch/i);

    // Anonymous/memory callers keep the legacy global default. This direct
    // resolver call proves the fallback is scoped to actors without an id.
    const anonymous = await resolveTemplateForGeneration({ actor: null });
    assert.ok(anonymous.template?.id);
    assert.equal(anonymous.source, "global_default");
  });

  it("pins the same resolved preference/default on background jobs and their assignments", async () => {
    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: null,
      preferredTemplateVersion: null,
    });
    const enqueued = await enqueueJob(USER_A);
    assert.equal(enqueued.status, 202, JSON.stringify(enqueued.data));
    assert.equal(enqueued.data.job.template.id, TEMPLATE_A_DEFAULT);
    assert.equal(enqueued.data.job.template.version, 1);

    const completed = await waitForJob(enqueued.data.job.id);
    const detail = await request(base, "GET", `/api/v1/assignments/${completed.assignmentId}`, {
      cookie: cookie(USER_A),
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.template.id, TEMPLATE_A_DEFAULT);
    assert.equal(detail.data.template.version, 1);

    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });
    const preferredJob = await enqueueJob(USER_A);
    assert.equal(preferredJob.status, 202, JSON.stringify(preferredJob.data));
    assert.equal(preferredJob.data.job.template.id, TEMPLATE_A_OTHER);
    assert.equal(preferredJob.data.job.template.version, 1);
    await waitForJob(preferredJob.data.job.id);

    const invalidJob = await enqueueJob(USER_A, {
      templateId: TEMPLATE_B,
      templateVersion: 1,
    });
    assert.equal(invalidJob.status, 404, JSON.stringify(invalidJob.data));
  });

  it("keeps existing assignments on their original template after preferences/defaults change", async () => {
    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_OTHER,
      preferredTemplateVersion: 1,
    });
    const created = await generate(USER_A);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const assignmentId = created.data.id;
    assert.equal(created.data.template.id, TEMPLATE_A_OTHER);
    assert.equal(created.data.template.version, 1);

    await putPreferences(USER_A, {
      collegeId: COLLEGE_A,
      departmentId: BRANCH_A1,
      preferredTemplateId: TEMPLATE_A_PLATFORM,
      preferredTemplateVersion: 1,
    });
    await Department.updateOne(
      { id: BRANCH_A1 },
      { $set: { defaultTemplateId: TEMPLATE_A_DEFAULT, defaultTemplateVersion: 2 } },
    );

    const reread = await request(base, "GET", `/api/v1/assignments/${assignmentId}`, {
      cookie: cookie(USER_A),
    });
    assert.equal(reread.status, 200);
    assert.equal(reread.data.template.id, TEMPLATE_A_OTHER);
    assert.equal(reread.data.template.version, 1);

    const html = await request(base, "GET", `/api/v1/assignments/${assignmentId}/html`, {
      cookie: cookie(USER_A),
    });
    assert.equal(html.status, 200);
    assert.match(html.contentType, /text\/html/);
  });
});
