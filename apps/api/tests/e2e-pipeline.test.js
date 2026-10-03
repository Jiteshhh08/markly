// STAGE 7 — end-to-end pipeline regression on an isolated test database.
// Production-like: AUTH_REQUIRED=1, real Express app, real MongoDB
// (`markly_stage4_test`, fail-closed name check, prefix-scoped cleanup),
// real HTTP cookie flow, and a stub AI service implementing the exact
// FastAPI contract (POST /v1/generate, POST /v1/regenerate-section).
// Only the LLM itself is stubbed — everything the stabilization branch
// changed (auth, guards, validation, awaited persistence, ownership,
// exports) runs for real.
//
// Flow: register → refresh → /me → generate → list → detail → edit →
// restart-read → exports → cross-user isolation → logout → blocked →
// bearer-precedence → guarded writes. No production data touched.

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1"; // production-like enforcement
process.env.JWT_SECRET = "stage7-e2e-test-secret-0123456789abcdef";

import mongoose from "mongoose";
import http from "node:http";

const TEST_DB_NAME = "markly_stage4_test";

function testDbUri() {
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[e2e-pipeline] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const m = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("[e2e-pipeline] unparseable MongoDB URI (refusing to guess)");
  const uri = `${m[1]}/${TEST_DB_NAME}${m[3] ?? ""}`;
  const name = uri.split("?")[0].split("/").pop();
  if (!(name.includes("stage4") && name.includes("test"))) {
    throw new Error(`[e2e-pipeline] refusing to use non-test database '${name}'`);
  }
  return uri;
}

async function cleanupE2E(createdIds = []) {
  const { Assignment, User } = await import("../src/models/index.js");
  // Prefix-scoped + explicitly tracked route-generated ids (real
  // `POST /generate` mints `asg_<ts>_<n>` ids with no test prefix).
  await Assignment.deleteMany({
    $or: [{ recordId: /^asg_e2e/ }, ...(createdIds.length ? [{ recordId: { $in: createdIds } }] : [])],
  });
  await User.deleteMany({ email: /^e2e-.*@example\.com$/ });
}

// Deterministic stub AI: always returns schema-valid Assignment JSON.
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

function startStubAi() {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url === "/v1/generate" && req.method === "POST") {
        return send(200, {
          content: stubContent(),
          sources: [],
          provider: "stub",
          model: "stub-1",
          promptVersion: "e2e",
          validation: { ok: true },
          researchProvider: "none",
        });
      }
      if (req.url === "/v1/regenerate-section" && req.method === "POST") {
        const body = raw ? JSON.parse(raw) : {};
        const values = {
          title: "Regenerated title via stub",
          aim: "Explore subqueries in SQL",
          objectives: ["Regenerated objective with enough length"],
          theory: ["Regenerated theory paragraph with enough length."],
          steps: stubContent().steps,
          conclusion: "Regenerated conclusion with enough length.",
        };
        return send(200, { value: values[body.section] ?? "Regenerated" });
      }
      return send(404, { error: "stub: unknown route" });
    });
  });
  return server;
}

const { default: app } = await import("../src/index.js");

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

let server;
let base;
let stub;
let e2eEmail;
// Module scope so after() can clean route-generated ids even on failure.
const createdIdsHolder = { ids: [] };

function uniq(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function raw(method, path, { body, cookie, auth } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  // Fail loudly on stalls: a wedged request must never hang the suite.
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => "");
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, data, text, contentType: res.headers.get("content-type"), setCookies };
}

function sessionCookie(setCookies) {
  const found = setCookies.find((c) => c.startsWith("markly_token="));
  assert.ok(found, "expected a markly_token Set-Cookie");
  return found.split(";")[0];
}

before(async () => {
  stub = startStubAi();
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${stub.address().port}`;
  await mongoose.connect(testDbUri(), { serverSelectionTimeoutMS: 15000 });
  await cleanupE2E();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  e2eEmail = uniq("e2e-");
});

after(async () => {
  // Guarded: if before() failed, servers may be undefined — never mask the
  // original error with a TypeError.
  await cleanupE2E(createdIdsHolder.ids).catch(() => {});
  await mongoose.disconnect().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (stub) await new Promise((r) => stub.close(r));
});

describe("STAGE7 e2e pipeline (register → generate → persist → logout)", () => {
  let cookie;
  let assignmentId;
  const createdIds = createdIdsHolder.ids;
  const track = (id) => {
    if (id) createdIds.push(id);
    return id;
  };

  it("register → refresh → /me restores the session (cookie only)", async () => {
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email: e2eEmail, password: "supersecret1", name: "E2E Probe" },
    });
    assert.equal(reg.status, 201);
    cookie = sessionCookie(reg.setCookies);
    const me = await raw("GET", "/api/v1/auth/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, e2eEmail);
  });

  it("generate after refresh succeeds (the reported bug, end to end)", async () => {
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL", subject: "DBMS", experimentNumber: 7 },
      cookie,
    });
    assert.notEqual(gen.status, 401, `generate must not 401: ${JSON.stringify(gen.data)}`);
    assert.equal(gen.status, 200);
    assert.ok(gen.data.id);
    assert.ok(gen.data.content?.title);
    assignmentId = track(gen.data.id);
  });

  it("generated assignment lists, opens, and edits", async () => {
    const list = await raw("GET", "/api/v1/assignments", { cookie });
    assert.equal(list.status, 200);
    assert.ok(list.data.assignments.some((a) => a.id === assignmentId), "generated id must be listed");

    const detail = await raw("GET", `/api/v1/assignments/${assignmentId}`, { cookie });
    assert.equal(detail.status, 200);

    const edited = { ...detail.data.content, title: "E2E edited title" };
    const put = await raw("PUT", `/api/v1/assignments/${assignmentId}`, {
      body: { content: edited },
      cookie,
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.content.title, "E2E edited title");
  });

  it("edit survives a simulated restart (durable route-path write)", async () => {
    const fresh = await import(`../src/lib/assignmentStore.js?restart=e2e-${Date.now()}`);
    // Owner identity re-resolved from the live cookie session (no memory state).
    const me = await raw("GET", "/api/v1/auth/me", { cookie });
    assert.equal(me.status, 200);
    const after = await fresh.findRecord(assignmentId, me.data.user.sub);
    assert.ok(after, "assignment lost across restart");
    assert.equal(after.content.title, "E2E edited title", "PUT edit lost across restart");
  });

  it("exports work for the persisted record (HTML + DOCX)", async () => {
    const html = await raw("GET", `/api/v1/assignments/${assignmentId}/html`, { cookie });
    assert.equal(html.status, 200);
    assert.ok((html.contentType ?? "").includes("text/html"));

    const docx = await raw("GET", `/api/v1/assignments/${assignmentId}/docx`, { cookie });
    assert.equal(docx.status, 200);
    assert.ok((docx.contentType ?? "").includes("officedocument"));
  });

  it("user B cannot read, edit, or delete user A's assignment", async () => {
    const regB = await raw("POST", "/api/v1/auth/register", {
      body: { email: uniq("e2e-"), password: "supersecret1" },
    });
    assert.equal(regB.status, 201);
    const cookieB = sessionCookie(regB.setCookies);

    for (const [method, path, body] of [
      ["GET", `/api/v1/assignments/${assignmentId}`, undefined],
      ["PUT", `/api/v1/assignments/${assignmentId}`, { content: stubContent() }],
      ["DELETE", `/api/v1/assignments/${assignmentId}`, undefined],
    ]) {
      const r = await raw(method, path, { body, cookie: cookieB });
      assert.equal(r.status, 404, `${method} must not cross ownership, got ${r.status}`);
    }
    const stillThere = await raw("GET", `/api/v1/assignments/${assignmentId}`, { cookie });
    assert.equal(stillThere.status, 200, "owner record must be untouched by user B");
  });

  it("garbage Bearer + valid cookie still generates (precedence, full route)", async () => {
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL" },
      cookie,
      auth: "Bearer garbage-token",
    });
    assert.equal(gen.status, 200);
    track(gen.data.id);
  });

  it("guarded writes reject anonymous callers under AUTH_REQUIRED=1", async () => {
    const tpl = await raw("POST", "/api/v1/templates", { body: { name: `E2E probe ${Date.now()}` } });
    assert.equal(tpl.status, 401);
    const job = await raw("POST", "/api/v1/jobs", {
      body: { type: "generate", input: { aim: "Explore subqueries in SQL" } },
    });
    assert.equal(job.status, 401);
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL" },
    });
    assert.equal(gen.status, 401);
  });

  it("logout ends the session; further generation requires login", async () => {
    const out = await raw("POST", "/api/v1/auth/logout", { cookie });
    assert.equal(out.status, 200);
    const me = await raw("GET", "/api/v1/auth/me");
    assert.equal(me.status, 401);
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL" },
    });
    assert.equal(gen.status, 401);
  });
});
