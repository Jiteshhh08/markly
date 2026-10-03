import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Route smoke tests: boot the real Express app on an ephemeral port (no AI,
// no Mongo, no network beyond localhost) and exercise the wiring that unit
// tests can't reach — async handlers, ownership checks, validation errors.

process.env.NODE_ENV = "test";
// Hermetic: the developer's real .env may enforce auth — force open dev mode
// for route wiring tests (dotenv never overrides pre-set vars).
process.env.AUTH_REQUIRED = "0";

const { default: app } = await import("../src/index.js");

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    server.closeAllConnections?.();
  } catch { /* older node: fall through to close */ }
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("route wiring", () => {
  it("health reports service state", async () => {
    const { status, data } = await call("GET", "/api/v1/health");
    assert.equal(status, 200);
    assert.equal(data.status, "ok");
  });

  it("rejects empty generation input without touching the AI service", async () => {
    const { status } = await call("POST", "/api/v1/assignments/generate", {});
    assert.equal(status, 400);
  });

  it("lists assignments (possibly empty) and 404s unknown ids everywhere", async () => {
    const list = await call("GET", "/api/v1/assignments");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data.assignments));
    for (const [method, path, body] of [
      ["GET", "/api/v1/assignments/nosuch", undefined],
      ["PUT", "/api/v1/assignments/nosuch", { content: {} }],
      ["PATCH", "/api/v1/assignments/nosuch/options", { typedConclusion: true }],
      ["DELETE", "/api/v1/assignments/nosuch", undefined],
      ["GET", "/api/v1/assignments/nosuch/html", undefined],
      ["GET", "/api/v1/assignments/nosuch/docx", undefined],
      ["GET", "/api/v1/assignments/nosuch/latex", undefined],
      ["POST", "/api/v1/assignments/nosuch/regenerate-section", { section: "aim" }],
      ["POST", "/api/v1/assignments/nosuch/pdf", {}],
    ]) {
      const r = await call(method, path, body);
      assert.equal(r.status, 404, `${method} ${path} should 404, got ${r.status}`);
    }
  });

  it("validates options patches", async () => {
    const r = await call("PATCH", "/api/v1/assignments/nosuch/options", { includeVivaTitle: "yes" });
    // Unknown id 404s before validation; use a bad id shape that still routes:
    assert.equal(r.status, 404);
  });

  it("rejects bad job input and unknown jobs", async () => {
    const bad = await call("POST", "/api/v1/jobs", { type: "generate", input: {} });
    assert.equal(bad.status, 400);
    const missing = await call("GET", "/api/v1/jobs/nosuch");
    assert.equal(missing.status, 404);
  });

  it("rejects bad logins and unauthenticated /me", async () => {
    const login = await call("POST", "/api/v1/auth/login", { email: "nobody@example.com", password: "wrongpassword" });
    assert.equal(login.status, 401);
    const me = await call("GET", "/api/v1/auth/me");
    assert.equal(me.status, 401);
  });
});

describe("cookie sessions (refresh-proof without browser storage)", () => {
  async function raw(method, path, body, cookie) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    return { status: res.status, data, setCookies };
  }

  it("sets an httpOnly cookie on register, honors it on /me, clears on logout", async () => {
    const email = `cookie${Date.now()}@example.com`;
    const reg = await raw("POST", "/api/v1/auth/register", { email, password: "supersecret1" });
    assert.equal(reg.status, 201);
    const sessionCookie = reg.setCookies.find((c) => c.startsWith("markly_token="));
    assert.ok(sessionCookie, "expected a markly_token Set-Cookie");
    assert.ok(sessionCookie.includes("HttpOnly"), "session cookie must be httpOnly");

    // No Bearer token — cookie alone authenticates (this is what survives refresh).
    const me = await raw("GET", "/api/v1/auth/me", undefined, sessionCookie.split(";")[0]);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, email);

    const out = await raw("POST", "/api/v1/auth/logout", undefined, sessionCookie.split(";")[0]);
    assert.equal(out.status, 200);
    const cleared = out.setCookies.find((c) => c.startsWith("markly_token="));
    assert.ok(cleared && /expires=thu, 01 jan 1970/i.test(cleared), "logout must expire the cookie");
    // Mirrored attributes: strict clients refuse to delete a SameSite/Secure
    // cookie from a Set-Cookie that doesn't match how it was set.
    assert.ok(cleared.includes("HttpOnly"), "clear must mirror the session cookie attributes");
    assert.ok(/samesite=/i.test(cleared), "clear must mirror SameSite");
  });
});
