import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Dynamic API responses must never be cached. This is a regression test for
// the browser bug where an unauthenticated /auth/me 401 was stored, then
// revalidated (304) after login and the UI kept treating the session as logged
// out.
process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "0";
process.env.JWT_SECRET = "stage3-cache-control-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { User } = await import("../src/models/index.js");
const { cookieFor, startServer, stopServer } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage3_cache_control_test";
const PREFIX = "stage3-cache";

let server;
let base;

function assertNoStore(res) {
  const cacheControl = res.headers.get("cache-control") ?? "";
  assert.match(cacheControl, /no-store/, "Cache-Control must forbid storage");
  assert.match(cacheControl, /no-cache/, "Cache-Control must forbid reuse");
  assert.equal(res.headers.get("pragma"), "no-cache");
}

before(async () => {
  const db = await connectStage3TestDb(TEST_DB);
  await db.dropDatabase();
  await User.create({
    id: `${PREFIX}-user`,
    email: `${PREFIX}-user@example.com`,
    name: "Stage3 Cache User",
    role: "user",
  });
  ({ server, base } = await startServer(app));
});

after(async () => {
  await User.deleteMany({ email: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
  await stopServer(server);
  await disconnectStage3TestDb();
});

describe("STAGE 3 dynamic API cache policy", () => {
  it("marks an unauthenticated auth/me 401 as non-cacheable", async () => {
    const res = await fetch(`${base}/api/v1/auth/me`);
    assert.equal(res.status, 401);
    assertNoStore(res);
  });

  it("marks an authenticated auth/me 200 as non-cacheable", async () => {
    const res = await fetch(`${base}/api/v1/auth/me`, {
      headers: { cookie: cookieFor({ id: `${PREFIX}-user`, email: `${PREFIX}-user@example.com` }) },
    });
    assert.equal(res.status, 200);
    assertNoStore(res);
    const body = await res.json();
    assert.equal(body.user.role, "user");
  });

  it("applies the policy to every dynamic API route, not just auth", async () => {
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    assertNoStore(res);
  });
});
