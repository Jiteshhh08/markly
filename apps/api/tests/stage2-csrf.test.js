import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Import in test mode so index.js does not start its own listener. The CSRF
// middleware reads NODE_ENV per request, so the suite switches to production
// below and still exercises the real mounted middleware.
process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage2-csrf-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";
delete process.env.ALLOWED_ORIGINS;

import { connectStage2TestDb, disconnectStage2TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
// index.js calls dotenv.config() during import, so clear any allowlist loaded
// from the developer's .env AFTER that import. Tests set their own values.
delete process.env.ALLOWED_ORIGINS;
const { Template, User } = await import("../src/models/index.js");
const { startServer, stopServer, cookieFor, bearerFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage2_csrf_test";

let db;
let server;
let base;
let user;
let cookie;
let bearer;

before(async () => {
  db = await connectStage2TestDb(TEST_DB);
  await db.dropDatabase();
  process.env.NODE_ENV = "production";
  user = await User.create({
    id: "usr_stage2_csrf_owner",
    email: "stage2-csrf-owner@example.com",
    role: "user",
  });
  cookie = cookieFor(user);
  bearer = bearerFor(user);
  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await db?.dropDatabase().catch(() => {});
  await disconnectStage2TestDb();
  process.env.NODE_ENV = "test";
});

function templateBody(name) {
  return { name, footer: { text: "csrf probe" } };
}

describe("STAGE 2 CSRF protection on actual template mutation routes", () => {
  it("blocks cookie-authenticated template mutations from a foreign or missing Origin", async () => {
    const foreign = await request(base, "POST", "/api/v1/templates", {
      cookie,
      headers: { origin: "https://evil.example" },
      body: templateBody("Stage2 CSRF Foreign Origin"),
    });
    assert.equal(foreign.status, 403, JSON.stringify(foreign.data));
    assert.match(foreign.data.error, /Cross-site request blocked/);

    const missing = await request(base, "POST", "/api/v1/templates", {
      cookie,
      body: templateBody("Stage2 CSRF Missing Origin"),
    });
    assert.equal(missing.status, 403, JSON.stringify(missing.data));

    assert.equal(
      await Template.countDocuments({ name: /^Stage2 CSRF (Foreign|Missing)/ }),
      0,
      "blocked requests must never reach the mutation",
    );
  });

  it("does not trust a spoofed X-Forwarded-Host for the same-origin decision", async () => {
    const blocked = await request(base, "POST", "/api/v1/templates", {
      cookie,
      headers: {
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
      },
      body: templateBody("Stage2 CSRF Forwarded Host"),
    });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
    assert.equal(await Template.countDocuments({ name: "Stage2 CSRF Forwarded Host" }), 0);
  });

  it("allows a genuine same-origin cookie mutation", async () => {
    const allowed = await request(base, "POST", "/api/v1/templates", {
      cookie,
      headers: { origin: base },
      body: templateBody("Stage2 CSRF Same Origin"),
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
    assert.equal(
      await Template.countDocuments({ name: "Stage2 CSRF Same Origin", version: 1 }),
      1,
    );
  });

  it("allows an allowlisted production frontend origin", async () => {
    process.env.ALLOWED_ORIGINS = "http://allowed.example";
    try {
      const allowed = await request(base, "POST", "/api/v1/templates", {
        cookie,
        headers: { origin: "http://allowed.example" },
        body: templateBody("Stage2 CSRF Allowlisted Origin"),
      });
      assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("preserves legitimate Bearer mutations without an ambient cookie", async () => {
    const allowed = await request(base, "POST", "/api/v1/templates", {
      auth: bearer,
      headers: { origin: "https://evil.example" },
      body: templateBody("Stage2 CSRF Bearer Only"),
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));

    const both = await request(base, "POST", "/api/v1/templates", {
      cookie,
      auth: bearer,
      headers: { origin: "https://evil.example" },
      body: templateBody("Stage2 CSRF Bearer With Cookie"),
    });
    assert.equal(both.status, 201, JSON.stringify(both.data));
  });

  it("still treats an invalid Bearer plus a valid cookie as an ambient cookie mutation", async () => {
    const blocked = await request(base, "POST", "/api/v1/templates", {
      cookie,
      auth: "Bearer not-a-real-token",
      headers: { origin: "https://evil.example" },
      body: templateBody("Stage2 CSRF Invalid Bearer"),
    });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
  });

  it("does not block safe reads or non-production requests", async () => {
    const read = await request(base, "GET", "/api/v1/templates", {
      cookie,
      headers: { origin: "https://evil.example" },
    });
    assert.equal(read.status, 200, JSON.stringify(read.data));

    process.env.NODE_ENV = "test";
    try {
      const open = await request(base, "POST", "/api/v1/templates", {
        cookie,
        headers: { origin: "https://evil.example" },
        body: templateBody("Stage2 CSRF Non Production"),
      });
      assert.equal(open.status, 201, JSON.stringify(open.data));
    } finally {
      process.env.NODE_ENV = "production";
    }
  });
});
