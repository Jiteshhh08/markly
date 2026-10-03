// STAGE 2 regression — backend authentication lifecycle.
// Hermetic: NODE_ENV=test (index.js never calls main(), so the real
// apps/api/.env MONGODB_URI is never dialed; mongoose stays disconnected).
// No production data touched, no deploys, no live Mongo mutations.
//
// Covers (per brief §6):
//  - valid cookie → authenticated request succeeds
//  - invalid Bearer must NOT override a valid cookie  [BUG, currently fails]
//  - login → refresh (/me with cookie only) succeeds
//  - login → refresh → generate is NOT 401 (backend slice passes;
//    the frontend ensureSession gate is the blocker — see frontend-auth-logic.test.js)
//  - unauthenticated /assignments under AUTH_REQUIRED=1 → 401
//  - unauthenticated /templates and /jobs under AUTH_REQUIRED=1 → 401
//    [BUG, currently open — index.js only mounts requireAuthIfEnabled on /assignments]
//  - expired/invalid token → 401

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
// Non-placeholder so secret() does not throw under AUTH_REQUIRED=1.
// dotenv never overrides pre-set vars, so the real .env JWT_SECRET is ignored here.
process.env.JWT_SECRET = "stage2-regression-test-secret-0123456789abcdef";

const { default: app } = await import("../src/index.js");

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function uniq(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
}

// Raw fetch helper that can send Cookie and/or Authorization independently,
// and captures Set-Cookie (node fetch exposes getSetCookie()).
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

function sessionCookie(setCookies) {
  const found = setCookies.find((c) => c.startsWith("markly_token="));
  assert.ok(found, "expected a markly_token Set-Cookie");
  return found.split(";")[0]; // "markly_token=<jwt>"
}

describe("STAGE2 auth regression (backend slice)", () => {
  it("valid cookie → GET /auth/me succeeds (refresh survival, backend slice)", async () => {
    const email = uniq("cookie-me-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1", name: "Cookie Me" },
    });
    assert.equal(reg.status, 201);
    const cookie = sessionCookie(reg.setCookies);
    assert.ok(reg.data.token, "token also returned for Bearer use");

    // Refresh simulation: no Bearer, cookie only (survives reload, nothing in browser storage).
    const me = await raw("GET", "/api/v1/auth/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, email);
  });

  it("BUG: invalid Bearer must NOT override a valid cookie (auth.js:104-108 Bearer wins unconditionally)", async () => {
    const email = uniq("precedence-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const cookie = sessionCookie(reg.setCookies);

    // Valid cookie + garbage Bearer. Correct: cookie fallback → 200.
    // Current: tokenFromRequest returns the Bearer blindly, verify fails → 401.
    const me = await raw("GET", "/api/v1/auth/me", {
      cookie,
      auth: "Bearer this.is.not.a.valid.token",
    });
    assert.equal(
      me.status,
      200,
      `expected cookie fallback to win over invalid Bearer, got ${me.status} ${JSON.stringify(me.data)}`,
    );
  });

  it("valid Bearer alone still authenticates (Bearer path is live)", async () => {
    const email = uniq("bearer-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const me = await raw("GET", "/api/v1/auth/me", {
      auth: `Bearer ${reg.data.token}`,
    });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, email);
  });

  it("login → refresh → generate is NOT 401 with a valid cookie (backend slice)", async () => {
    const email = uniq("gen-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const cookie = sessionCookie(reg.setCookies);

    // No AI service in tests, so a *valid* authed request surfaces as 400
    // (validation) or 502 (AI down) — but never 401. 401 here would mean the
    // cookie session was dropped between refresh and generate.
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL", subject: "DBMS" },
      cookie,
    });
    assert.notEqual(
      gen.status,
      401,
      `cookie-authenticated generate must not 401, got 401 ${JSON.stringify(gen.data)}`,
    );
  });

  it("unauthenticated assignments access is 401 when AUTH_REQUIRED=1", async () => {
    const list = await raw("GET", "/api/v1/assignments");
    assert.equal(list.status, 401);
    const gen = await raw("POST", "/api/v1/assignments/generate", {
      body: { aim: "Explore subqueries in SQL" },
    });
    assert.equal(gen.status, 401);
  });

  it("BUG: unauthenticated template creation is open when AUTH_REQUIRED=1 (requireAuthIfEnabled not mounted on /templates)", async () => {
    const res = await raw("POST", "/api/v1/templates", {
      body: { name: `Stage2 probe ${Date.now()}` },
    });
    assert.equal(
      res.status,
      401,
      `expected 401 for unauthenticated template write under AUTH_REQUIRED=1, got ${res.status} ${JSON.stringify(res.data)}`,
    );
  });

  it("BUG: unauthenticated job enqueue is open when AUTH_REQUIRED=1 (requireAuthIfEnabled not mounted on /jobs)", async () => {
    const res = await raw("POST", "/api/v1/jobs", {
      body: { type: "generate", input: { aim: "Explore subqueries in SQL" } },
    });
    assert.equal(
      res.status,
      401,
      `expected 401 for unauthenticated job enqueue under AUTH_REQUIRED=1, got ${res.status} ${JSON.stringify(res.data)}`,
    );
  });

  it("authenticated template creation still works when AUTH_REQUIRED=1", async () => {
    const email = uniq("authed-tpl-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const cookie = sessionCookie(reg.setCookies);
    const res = await raw("POST", "/api/v1/templates", {
      body: { name: `Authed probe ${Date.now()}` },
      cookie,
    });
    assert.equal(res.status, 201, `authed template write must succeed, got ${res.status}`);
  });

  it("authenticated job enqueue still works when AUTH_REQUIRED=1", async () => {
    const email = uniq("authed-job-");
    const reg = await raw("POST", "/api/v1/auth/register", {
      body: { email, password: "supersecret1" },
    });
    assert.equal(reg.status, 201);
    const cookie = sessionCookie(reg.setCookies);
    const res = await raw("POST", "/api/v1/jobs", {
      body: { type: "generate", input: { aim: "Explore subqueries in SQL" } },
      cookie,
    });
    assert.equal(res.status, 202, `authed job enqueue must succeed, got ${res.status}`);
  });

  it("expired/invalid token → 401 (genuine auth failure DOES transition)", async () => {
    const bad = await raw("GET", "/api/v1/auth/me", { auth: "Bearer not.a.token" });
    assert.equal(bad.status, 401);
    const none = await raw("GET", "/api/v1/auth/me");
    // Under AUTH_REQUIRED=1 there is no cookie and no Bearer → /me still 401
    // (/me always requires req.user, independent of the flag).
    assert.equal(none.status, 401);
  });
});
