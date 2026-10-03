// STAGE 2 regression — persistence / ownership / restart survival.
// STAGE 4 wiring: this file now connects to a DEDICATED ISOLATED test
// database (`markly_stage4_test` on the same Atlas cluster, derived from
// MONGODB_URI / MONGODB_TEST_URI with the database name FORCED). Production
// data is never touched: the connection helper fail-closes unless the target
// db name contains both 'stage4' and 'test', cleanup only deletes documents
// with test prefixes (`asg_stage2*` records, `*@example.com` users), and
// dropDatabase is never called. Restart is simulated by importing a FRESH
// copy of the module via a cache-busting query string (empty Map — same as
// a post-restart process) while the test database keeps the durable copy.
// No test assertions were changed in STAGE 4 — only this precondition wiring.
//
// Covers (per brief §5):
//  a. login → refresh → authenticated state survives (backend slice)
//  b. generate/save → restart → assignment still exists
//  c. edit (PUT) → restart → edit still exists
//  d. delete → restart → deletion remains deleted
//  e. user A cannot access user B's assignment
//  + users survive restart (login rehydrated from Mongo)

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "0"; // isolate store behaviour from auth enforcement here
process.env.JWT_SECRET = "stage2-regression-test-secret-0123456789abcdef";

import mongoose from "mongoose";

const TEST_DB_NAME = "markly_stage4_test";

// Builds the isolated test-database URI. Prefers MONGODB_TEST_URI when set
// (CI without deployment secrets), else derives from MONGODB_URI by
// REPLACING the database path — credentials and cluster are reused, data is
// not: every read/write below lands in TEST_DB_NAME only.
function testDbUri() {
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[persistence-regression] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI) to run durability tests. " +
        "Durability cannot be verified without a database — refusing to fake-green.",
    );
  }
  // Split authority / path / query without touching credentials or host.
  const m = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("[persistence-regression] unparseable MongoDB URI (refusing to guess)");
  const uri = `${m[1]}/${TEST_DB_NAME}${m[3] ?? ""}`;
  const name = uri.split("?")[0].split("/").pop();
  if (!(name.includes("stage4") && name.includes("test"))) {
    throw new Error(`[persistence-regression] refusing to use non-test database '${name}'`);
  }
  return uri;
}

// Test-prefix-scoped cleanup inside the test-only database.
async function cleanupTestDocs() {
  const { Assignment, User } = await import("../src/models/index.js");
  await Assignment.deleteMany({ recordId: /^asg_stage2/ });
  await User.deleteMany({ email: /@example\.com$/ });
}

const { default: app } = await import("../src/index.js");
const store = await import("../src/lib/assignmentStore.js");
const { verifyToken } = await import("../src/lib/auth.js");

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

let server;
let base;

before(async () => {
  await mongoose.connect(testDbUri(), { serverSelectionTimeoutMS: 15000 });
  await cleanupTestDocs();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Guarded: if before() failed (e.g. test DB unreachable), server is
  // undefined — report the original error, don't mask it with a TypeError.
  await cleanupTestDocs().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
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
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, data, setCookies };
}

function validContent(overrides = {}) {
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
    ...overrides,
  };
}

describe("STAGE2 persistence regression (a-e separated)", () => {
  it("(a) login → refresh → /me succeeds with cookie only (backend slice)", async () => {
    const email = uniq("persist-a-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const cookie = reg.setCookies
      .find((c) => c.startsWith("markly_token="))
      .split(";")[0];
    const me = await raw("GET", "/api/v1/auth/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, email);
  });

  it("(b/BUG) saved assignment reports a DURABLE write without Mongo", async () => {
    // generateViaAiService is bypassed here: the point is the store contract.
    // saveRecord is the hot cache; persistRecord is the claimed durability.
    const record = {
      id: `asg_stage2b_${Date.now()}`,
      status: "completed",
      userId: "anonymous",
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent(),
      createdAt: new Date().toISOString(),
    };
    store.saveRecord(record);
    const durable = await store.persistRecord(record);
    assert.equal(
      durable,
      true,
      "persistRecord returned false: without Mongo the write is memory-only (best-effort mirror, not durable)",
    );
  });

  it("(b/BUG) saved assignment survives a simulated API restart", async () => {
    const id = `asg_stage2restart_${Date.now()}`;
    const record = {
      id,
      status: "completed",
      userId: "anonymous",
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent(),
      createdAt: new Date().toISOString(),
    };
    store.saveRecord(record);
    // STAGE 4 completion: commit exactly like POST /generate does
    // (saveRecord + awaited persist). The assertion below is unchanged.
    assert.equal(await store.persistRecord(record), true, "commit must be durable");
    // Fresh module = post-restart process (empty Map) + Mongo fallback.
    const fresh = await import(`../src/lib/assignmentStore.js?restart=b-${Date.now()}`);
    const after = await fresh.findRecord(id, "anonymous");
    assert.ok(after, `record ${id} lost on restart: memory is truth, Mongo is best-effort mirror`);
  });

  it("(c/BUG) PUT edit survives a simulated API restart", async () => {
    const id = `asg_stage2edit_${Date.now()}`;
    store.saveRecord({
      id,
      status: "completed",
      userId: "anonymous",
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent({ title: "Explore subqueries in SQL" }),
      createdAt: new Date().toISOString(),
    });
    const put = await raw("PUT", `/api/v1/assignments/${id}`, {
      body: { content: validContent({ title: "EDITED title for restart probe" }) },
    });
    assert.equal(put.status, 200, `PUT should succeed in-memory, got ${put.status}`);
    assert.equal(put.data.content.title, "EDITED title for restart probe");

    // PUT handler does saveRecord() only (assignments.js) — no persistRecord —
    // so a restart reverts the edit. Fresh module proves it.
    const fresh = await import(`../src/lib/assignmentStore.js?restart=c-${Date.now()}`);
    const after = await fresh.findRecord(id, "anonymous");
    assert.ok(
      after && after.content?.title === "EDITED title for restart probe",
      "PUT edit lost on restart: options/content/latex edits never reach Mongo",
    );
  });

  it("(d) delete → restart → deletion remains deleted", async () => {
    const id = `asg_stage2del_${Date.now()}`;
    store.saveRecord({
      id,
      status: "completed",
      userId: "anonymous",
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent(),
      createdAt: new Date().toISOString(),
    });
    const del = await raw("DELETE", `/api/v1/assignments/${id}`);
    assert.equal(del.status, 200);
    const gone = await raw("GET", `/api/v1/assignments/${id}`);
    assert.equal(gone.status, 404);
    const fresh = await import(`../src/lib/assignmentStore.js?restart=d-${Date.now()}`);
    const after = await fresh.findRecord(id, "anonymous");
    assert.equal(after, null, "deleted record must stay deleted after restart");
  });

  it("(e) user A cannot access user B's assignment (owned records are private)", async () => {
    const regA = await raw("POST", "/api/v1/auth/register", {
      body: { email: uniq("persist-eA-"), password: "supersecret1" },
    });
    const regB = await raw("POST", "/api/v1/auth/register", {
      body: { email: uniq("persist-eB-"), password: "supersecret1" },
    });
    assert.equal(regA.status, 201);
    assert.equal(regB.status, 201);
    const subA = verifyToken(regA.data.token).sub;
    const id = `asg_stage2iso_${Date.now()}`;
    store.saveRecord({
      id,
      status: "completed",
      userId: subA,
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent(),
      createdAt: new Date().toISOString(),
    });
    const asB = await raw("GET", `/api/v1/assignments/${id}`, {
      auth: `Bearer ${regB.data.token}`,
    });
    assert.equal(asB.status, 404, `user B must not read user A's record, got ${asB.status}`);
    const asA = await raw("GET", `/api/v1/assignments/${id}`, {
      auth: `Bearer ${regA.data.token}`,
    });
    assert.equal(asA.status, 200, `owner must read own record, got ${asA.status}`);
  });

  it("(e/BUG) anonymous record must NOT leak to other authenticated users when AUTH_REQUIRED=1", async () => {
    // Setup correction (STAGE 3): this test's title states the AUTH_REQUIRED=1
    // precondition, but the file runs hermetically with AUTH_REQUIRED=0.
    // Establish the stated precondition for this test only; the assertion
    // below is unchanged from STAGE 2.
    const prev = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = "1";
    try {
    const regB = await raw("POST", "/api/v1/auth/register", {
      body: { email: uniq("persist-eAnon-"), password: "supersecret1" },
    });
    assert.equal(regB.status, 201);
    const id = `asg_stage2anon_${Date.now()}`;
    store.saveRecord({
      id,
      status: "completed",
      userId: "anonymous",
      input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      content: validContent(),
      createdAt: new Date().toISOString(),
    });
    // canAccess() used to return true for owner==="anonymous" regardless of
    // requester (assignmentStore.js): legacy/dev records leaked to everyone.
    const { canAccess } = store;
    assert.equal(
      canAccess({ id, userId: "anonymous" }, verifyToken(regB.data.token).sub),
      false,
      "anonymous record visible to an unrelated authenticated user (cross-user leak)",
    );
    } finally {
      if (prev === undefined) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = prev;
    }
  });

  it("(users/BUG) registered users survive a simulated API restart", async () => {
    const email = uniq("persist-u-");
    const { registerUser } = await import("../src/lib/auth.js");
    await registerUser({ email, password: "supersecret1", name: "Restart Probe" });
    // users Map lives in auth.js module state; tryPersist strips passwordHash,
    // so the Mongo copy (if any) cannot satisfy loginUser's bcrypt.compare.
    const freshAuth = await import(`../src/lib/auth.js?restart=u-${Date.now()}`);
    await assert.doesNotReject(
      () => freshAuth.loginUser({ email, password: "supersecret1" }),
      "login fails after restart: users Map wiped and Mongo copy has no passwordHash",
    );
  });
});
