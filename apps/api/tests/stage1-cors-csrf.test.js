import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "0";
process.env.JWT_SECRET = "stage1-cors-csrf-test-secret-0123456789abcdef";

const { default: app } = await import("../src/index.js");
const { corsAllowList, corsOptions, corsOrigin } = await import("../src/lib/cors.js");
const {
  cookieAuthenticated,
  csrfProtection,
  isCsrfOriginAllowed,
  isSameOrigin,
  parseCookieHeader,
  requestOrigin,
} = await import("../src/lib/csrf.js");
const { signToken } = await import("../src/lib/auth.js");

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  try {
    server.closeAllConnections?.();
  } catch {
    /* older node */
  }
  await new Promise((resolve) => server.close(resolve));
});

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

function runCsrf(middleware, req) {
  const res = mockResponse();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe("STAGE 1 production CORS policy", () => {
  it("parses comma-separated allowlists and trims blanks", () => {
    assert.deepEqual(
      corsAllowList({ ALLOWED_ORIGINS: " https://a.example, ,https://b.example " }),
      ["https://a.example", "https://b.example"],
    );
  });

  it("keeps the permissive dev/test default but fails closed in production", () => {
    assert.equal(corsOrigin("https://any.example", { NODE_ENV: "test", ALLOWED_ORIGINS: "" }), true);
    assert.equal(corsOrigin("https://any.example", { NODE_ENV: "production", ALLOWED_ORIGINS: "" }), false);
    assert.equal(corsOrigin(undefined, { NODE_ENV: "production", ALLOWED_ORIGINS: "" }), true);
  });

  it("honors the explicit allowlist in production", () => {
    const env = { NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example" };
    assert.equal(corsOrigin("https://app.example", env), true);
    assert.equal(corsOrigin("https://evil.example", env), false);
  });

  it("passes the same decision through corsOptions", async () => {
    const options = corsOptions({ NODE_ENV: "production", ALLOWED_ORIGINS: "" });
    const decision = await new Promise((resolve) => options.origin("https://evil.example", (_err, ok) => resolve(ok)));
    assert.equal(decision, false);
  });

  it("blocks browser preflights in production when ALLOWED_ORIGINS is empty", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOrigins = process.env.ALLOWED_ORIGINS;
    process.env.NODE_ENV = "production";
    delete process.env.ALLOWED_ORIGINS;
    try {
      const blocked = await fetch(`${base}/api/v1/assignments`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(blocked.headers.get("access-control-allow-origin"), null);

      process.env.ALLOWED_ORIGINS = "https://app.example";
      const allowed = await fetch(`${base}/api/v1/assignments`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");
      assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = previousOrigins;
    }
  });
});

describe("STAGE 1 cookie CSRF protection", () => {
  const token = signToken({ id: "usr_csrf", email: "csrf@example.com" });
  const cookie = `markly_token=${encodeURIComponent(token)}`;
  const env = { NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example" };

  it("parses only the named cookie", () => {
    assert.deepEqual(parseCookieHeader(`a=1; markly_token=${token}; b=2`), { markly_token: token });
    assert.deepEqual(parseCookieHeader("a=1"), {});
  });

  it("recognizes valid cookie auth and ignores invalid cookies", () => {
    assert.equal(cookieAuthenticated({ headers: { cookie } }), true);
    assert.equal(cookieAuthenticated({ headers: { cookie: "markly_token=not-a-token" } }), false);
    assert.equal(cookieAuthenticated({ headers: {} }), false);
  });

  it("lets a valid Bearer token bypass the ambient-cookie check", () => {
    assert.equal(cookieAuthenticated({ headers: { cookie, authorization: `Bearer ${token}` } }), false);
  });

  it("allows an allowlisted Origin for cookie mutations", () => {
    const middleware = csrfProtection({ env });
    const { res, nextCalled } = runCsrf(middleware, {
      method: "POST",
      headers: { cookie, origin: "https://app.example" },
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it("allows a same-origin request without an allowlist", () => {
    const req = {
      method: "PATCH",
      headers: { cookie, host: "api.example.com", origin: "https://api.example.com" },
    };
    assert.equal(isSameOrigin(req, "https://api.example.com"), true);
    assert.equal(isCsrfOriginAllowed(req, { NODE_ENV: "production", ALLOWED_ORIGINS: "" }), true);
    const { nextCalled } = runCsrf(csrfProtection({ env: { NODE_ENV: "production", ALLOWED_ORIGINS: "" } }), req);
    assert.equal(nextCalled, true);
  });

  it("does not trust a client-supplied X-Forwarded-Host for same-origin checks", () => {
    const req = {
      method: "POST",
      headers: {
        cookie,
        host: "api.example.com",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
      },
    };
    assert.equal(isSameOrigin(req, "https://evil.example"), false);
    const { res, nextCalled } = runCsrf(
      csrfProtection({ env: { NODE_ENV: "production", ALLOWED_ORIGINS: "" } }),
      req,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("falls back to Referer when Origin is absent", () => {
    const req = {
      method: "DELETE",
      headers: { cookie, referer: "https://app.example/templates/1" },
    };
    assert.equal(requestOrigin(req), "https://app.example");
    const { nextCalled } = runCsrf(csrfProtection({ env }), req);
    assert.equal(nextCalled, true);
  });

  it("rejects cookie mutations with a foreign or missing Origin", () => {
    const middleware = csrfProtection({ env });
    const foreign = runCsrf(middleware, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    assert.equal(foreign.nextCalled, false);
    assert.equal(foreign.res.statusCode, 403);
    assert.equal(foreign.res.body.error, "Cross-site request blocked");

    const missing = runCsrf(middleware, { method: "PUT", headers: { cookie } });
    assert.equal(missing.nextCalled, false);
    assert.equal(missing.res.statusCode, 403);
  });

  it("does not block safe methods or non-cookie credentials", () => {
    const middleware = csrfProtection({ env });
    const safe = runCsrf(middleware, {
      method: "GET",
      headers: { cookie, origin: "https://evil.example" },
    });
    assert.equal(safe.nextCalled, true);

    const bearer = runCsrf(middleware, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(bearer.nextCalled, true);

    const invalidCookie = runCsrf(middleware, {
      method: "POST",
      headers: { cookie: "markly_token=invalid", origin: "https://evil.example" },
    });
    assert.equal(invalidCookie.nextCalled, true, "auth layer must decide invalid credentials");
  });
});
