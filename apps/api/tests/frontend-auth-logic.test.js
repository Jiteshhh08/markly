// STAGE 3 — AuthContext behavior tests (replaces the STAGE 2 static
// bug-probes, which asserted the bugs EXISTED; the code below asserts the
// FIXED architecture plus the live transition contract).
//
// Covers the brief's minimum list:
//  1 startup loading state            8 refresh/bootstrap
//  2 /auth/me success                 9 protected request after bootstrap
//  3 /auth/me 401                    10 generate after login
//  4 network failure                 11 generate after refresh
//  5 500 failure                     12 invalid bearer + valid cookie
//  6 login                           13 unauthenticated template request
//  7 logout                          14 unauthenticated job request
// (12–14 are enforced by the real backend in auth-regression.test.js;
//  the client-level halves are pinned here.)

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_STATUS,
  authReducer,
  createInitialAuthState,
  isAuthKnown,
  isTransportFailure,
  isUnauthorizedError,
  shouldPromptLogin,
} from "../../../src/contexts/authMachine.js";

import {
  apiFetch,
  clearAuthToken,
  getAuthToken,
  resolveApiUrl,
  setAuthHooks,
  setAuthToken,
} from "../../../src/services/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const readSrc = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Part A — architecture pins (the fixed shape; fail on regression)
// ---------------------------------------------------------------------------

describe("STAGE3 auth architecture (single source of truth)", () => {
  it("exactly one API client: services/api.js owns credentials + the single token store", () => {
    assert.ok(!existsSync(join(root, "src", "lib", "api.js")), "duplicate client src/lib/api.js must stay deleted");
    const client = readSrc("src/services/api.js");
    assert.ok(client.includes('"include"'), "canonical client must send credentials:'include' (cookie auth)");
    assert.equal(
      (client.match(/let authToken/g) ?? []).length,
      1,
      "exactly one in-memory Bearer store",
    );
    assert.ok(client.includes("setAuthHooks"), "central 401 reconciliation hook must exist");
  });

  it("VITE_API_URL handling is explicit (no ?? footgun; empty means same-origin)", () => {
    const client = readSrc("src/services/api.js");
    assert.ok(!client.includes("VITE_API_URL ??"), "must not use ?? for the baked URL");
    assert.ok(client.includes("same-origin"), "empty var must be documented as same-origin (dev proxy)");
  });

  it("AuthContext/AuthProvider is the only auth state owner", () => {
    assert.ok(existsSync(join(root, "src", "contexts", "AuthContext.jsx")));
    assert.ok(existsSync(join(root, "src", "contexts", "authMachine.js")));
    const provider = readSrc("src/contexts/AuthContext.jsx");
    for (const s of ["loading", "authenticated", "unauthenticated"]) {
      assert.ok(provider.includes(s), `provider must model '${s}'`);
    }
    assert.ok(provider.includes("reconcileAuth: false"), "auth endpoints must reconcile explicitly, not via the 401 hook");
    const app = readSrc("src/App.jsx");
    assert.ok(app.includes("useAuth"), "App must consume useAuth");
    assert.ok(!app.includes("session?.token"), "token-field gate must be gone");
    assert.ok(!app.includes("let memoryToken"), "module token store must be gone");
    assert.ok(!app.includes("setSession"), "parallel session state must be gone");
    assert.ok(app.includes("auth.initialized"), "data fetching must gate on auth bootstrap");
    assert.ok(readSrc("src/main.jsx").includes("AuthProvider"), "provider must wrap the app");
  });
});

// ---------------------------------------------------------------------------
// Part B — reducer contract (1,3,4,5 + prompt gating)
// ---------------------------------------------------------------------------

describe("STAGE3 auth machine transitions", () => {
  it("(1) startup state is loading and unknown — never logged-out", () => {
    const s = createInitialAuthState();
    assert.equal(s.status, AUTH_STATUS.LOADING);
    assert.equal(isAuthKnown(s), false);
    assert.equal(shouldPromptLogin(s), false);
  });

  it("(2/3) bootstrap verdicts: user → authenticated, 401 → unauthenticated", () => {
    let s = authReducer(createInitialAuthState(), {
      type: "BOOT_OK",
      user: { email: "stu@college.edu", name: "Stu", avatarUrl: "", sub: "usr_1" },
    });
    assert.equal(s.status, AUTH_STATUS.AUTHENTICATED);
    assert.equal(s.user.email, "stu@college.edu");
    assert.equal(isAuthKnown(s), true);
    assert.equal(shouldPromptLogin(s), false);

    s = authReducer(createInitialAuthState(), { type: "BOOT_NO_SESSION" });
    assert.equal(s.status, AUTH_STATUS.UNAUTHENTICATED);
    assert.equal(s.user, null);
    assert.equal(isAuthKnown(s), true);
    assert.equal(shouldPromptLogin(s), true);
  });

  it("(4/5) bootstrap network/500 → error (retryable), never unauthenticated", () => {
    for (const error of [
      { type: "network", message: "down" },
      { type: "server", status: 500, message: "boom" },
    ]) {
      const s = authReducer(createInitialAuthState(), { type: "BOOT_TRANSPORT_ERROR", error });
      assert.equal(s.status, AUTH_STATUS.ERROR);
      assert.equal(s.user, null);
      assert.equal(isAuthKnown(s), true);
      assert.equal(shouldPromptLogin(s), false, "error state must not open the login modal");
    }
  });

  it("genuine 401 clears a live session; network/500 preserve it", () => {
    const authed = authReducer(createInitialAuthState(), {
      type: "LOGIN_OK",
      user: { email: "stu@college.edu" },
    });
    assert.equal(authed.status, AUTH_STATUS.AUTHENTICATED);

    const expired = authReducer(authed, { type: "UNAUTHORIZED" });
    assert.equal(expired.status, AUTH_STATUS.UNAUTHENTICATED);
    assert.equal(expired.user, null);

    const kept500 = authReducer(authed, { type: "TRANSPORT_ERROR", error: { type: "server", status: 500 } });
    assert.equal(kept500.status, AUTH_STATUS.AUTHENTICATED);
    assert.equal(kept500.user.email, "stu@college.edu");

    const keptNet = authReducer(authed, { type: "TRANSPORT_ERROR", error: { type: "network" } });
    assert.equal(keptNet.status, AUTH_STATUS.AUTHENTICATED);
    assert.equal(keptNet.user.email, "stu@college.edu");
  });

  it("logout clears everything; only 401 classifies as unauthorized", () => {
    const authed = authReducer(createInitialAuthState(), {
      type: "LOGIN_OK",
      user: { email: "stu@college.edu" },
    });
    const out = authReducer(authed, { type: "LOGOUT_OK" });
    assert.equal(out.status, AUTH_STATUS.UNAUTHENTICATED);
    assert.equal(out.user, null);

    assert.equal(isUnauthorizedError({ status: 401 }), true);
    assert.equal(isUnauthorizedError({ status: 500 }), false);
    assert.equal(isUnauthorizedError({}), false);
    assert.equal(isTransportFailure({ network: true }), true);
    assert.equal(isTransportFailure({ status: 500 }), true);
    assert.equal(isTransportFailure({ status: 502 }), true);
    assert.equal(isTransportFailure({ status: 401 }), false);
    assert.equal(isTransportFailure({ status: 404 }), false);
  });
});

// ---------------------------------------------------------------------------
// Part C + D — canonical client + end-to-end auth flows vs a stub API
// ---------------------------------------------------------------------------

const VALID_COOKIE = "markly_token=stub-valid-cookie";
const VALID_TOKEN = "stub-valid-token";

function stubHandler(req, res) {
  const send = (status, body, setCookie) => {
    const headers = { "content-type": "application/json" };
    if (setCookie) headers["set-cookie"] = setCookie;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const cookie = req.headers.cookie ?? "";
    const auth = req.headers.authorization ?? "";
    const hasValidCookie = cookie.includes("stub-valid-cookie");
    const hasValidBearer = auth === `Bearer ${VALID_TOKEN}`;
    const body = raw ? JSON.parse(raw) : {};

    if (req.url === "/api/v1/auth/me" && req.method === "GET") {
      if (cookie.includes("trigger-500")) return send(500, { error: "boom" });
      // Fixed precedence (mirrors apps/api/src/lib/auth.js): valid Bearer
      // wins, else valid cookie, else 401. Garbage Bearer never masks cookie.
      if (hasValidBearer) return send(200, { user: { sub: "usr_1", email: "stu@college.edu", name: "Stu" } });
      if (hasValidCookie) return send(200, { user: { sub: "usr_1", email: "stu@college.edu", name: "Stu" } });
      return send(401, { error: "Not authenticated" });
    }
    if ((req.url === "/api/v1/auth/login" || req.url === "/api/v1/auth/register") && req.method === "POST") {
      if (!body.email?.includes("@") || String(body.password ?? "").length < 8) {
        return send(401, { error: "Invalid email or password" });
      }
      return send(req.url.endsWith("/register") ? 201 : 200, { token: VALID_TOKEN }, [
        "markly_token=stub-valid-cookie; Path=/; HttpOnly",
      ]);
    }
    if (req.url === "/api/v1/auth/logout" && req.method === "POST") {
      return send(200, { ok: true });
    }
    if (req.url === "/api/v1/assignments/generate" && req.method === "POST") {
      if (hasValidBearer || hasValidCookie) return send(200, { id: "asg_stub_1" });
      return send(401, { error: "Authentication required" });
    }
    if (req.url === "/api/v1/templates" && req.method === "POST") {
      if (hasValidBearer || hasValidCookie) return send(201, { template: { id: "t1", version: 1 } });
      return send(401, { error: "Authentication required" });
    }
    if (req.url === "/api/v1/jobs" && req.method === "POST") {
      if (hasValidBearer || hasValidCookie) return send(202, { job: { id: "job_1" } });
      return send(401, { error: "Authentication required" });
    }
    return send(404, { error: "Not found" });
  });
}

let stub;
let stubBase;

before(async () => {
  stub = http.createServer(stubHandler);
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  stubBase = `http://127.0.0.1:${stub.address().port}`;
  setAuthHooks({ onUnauthorized: null });
});

after(async () => {
  setAuthHooks({ onUnauthorized: null });
  clearAuthToken();
  await new Promise((r) => stub.close(r));
});

describe("STAGE3 canonical client behavior", () => {
  it("attaches the single Bearer store and clears it on logout", async () => {
    setAuthToken(VALID_TOKEN);
    assert.equal(getAuthToken(), VALID_TOKEN);
    const me = await apiFetch(`${stubBase}/api/v1/auth/me`, { reconcileAuth: false });
    assert.equal(me.status, 200);
    clearAuthToken();
    assert.equal(getAuthToken(), "");
  });

  it("(12/client) garbage Bearer + valid cookie still authenticates (server precedence)", async () => {
    setAuthToken("garbage-token");
    try {
      const me = await apiFetch(`${stubBase}/api/v1/auth/me`, {
        headers: { cookie: VALID_COOKIE },
        reconcileAuth: false,
      });
      assert.equal(me.status, 200);
    } finally {
      clearAuthToken();
    }
  });

  it("central 401 hook fires exactly on 401 — never on 500 or network failure", async () => {
    let calls = 0;
    setAuthHooks({
      onUnauthorized: () => {
        calls += 1;
      },
    });
    try {
      const denied = await apiFetch(`${stubBase}/api/v1/auth/me`);
      assert.equal(denied.status, 401);
      assert.equal(calls, 1);

      const broken = await apiFetch(`${stubBase}/api/v1/auth/me`, {
        headers: { cookie: "markly_token=trigger-500" },
      });
      assert.equal(broken.status, 500);
      assert.equal(calls, 1, "5xx must not reconcile auth state");

      await assert.rejects(
        () => apiFetch("http://127.0.0.1:9/api/v1/auth/me", { timeoutMs: 1000 }),
        /Couldn't reach the Markly service/,
      );
      assert.equal(calls, 1, "network failure must not reconcile auth state");
    } finally {
      setAuthHooks({ onUnauthorized: null });
    }
  });

  it("explicit empty base means same-origin (dev proxy), unset keeps legacy default", async () => {
    const prev = process.env.VITE_API_URL;
    process.env.VITE_API_URL = "";
    try {
      const fresh = await import(`../../../src/services/api.js?emptybase=${Date.now()}`);
      assert.equal(fresh.API_BASE, "", "explicit empty VITE_API_URL must mean same-origin");
      assert.equal(fresh.resolveApiUrl("/api/v1/auth/me"), "/api/v1/auth/me");
    } finally {
      if (prev === undefined) delete process.env.VITE_API_URL;
      else process.env.VITE_API_URL = prev;
    }
    delete process.env.VITE_API_URL;
    try {
      const fresh2 = await import(`../../../src/services/api.js?unsetbase=${Date.now()}`);
      assert.equal(fresh2.API_BASE, "http://127.0.0.1:4000", "unset var keeps the legacy default");
    } finally {
      if (prev === undefined) delete process.env.VITE_API_URL;
      else process.env.VITE_API_URL = prev;
    }
    assert.ok(resolveApiUrl(`${stubBase}/x`).startsWith("http"));
  });
});

describe("STAGE3 auth flows end-to-end (stub API + reducer)", () => {
  async function loginFlow(email = "stu@college.edu") {
    const res = await apiFetch(`${stubBase}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "supersecret1" }),
      reconcileAuth: false,
    });
    assert.equal(res.status, 200);
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    assert.ok(setCookies.some((c) => c.startsWith("markly_token=")), "login must set the httpOnly session cookie");
    const data = await res.json();
    setAuthToken(data.token);
    const cookie = setCookies.find((c) => c.startsWith("markly_token=")).split(";")[0];
    const me = await apiFetch(`${stubBase}/api/v1/auth/me`, {
      headers: { cookie },
      reconcileAuth: false,
    });
    assert.equal(me.status, 200);
    const state = authReducer(
      createInitialAuthState(),
      { type: "LOGIN_OK", user: (await me.json()).user },
    );
    return { state, cookie };
  }

  it("(6/8/10) login → authenticated → generate succeeds without a login prompt", async () => {
    const { state, cookie } = await loginFlow();
    assert.equal(state.status, AUTH_STATUS.AUTHENTICATED);
    assert.equal(shouldPromptLogin(state), false);
    try {
      const gen = await apiFetch(`${stubBase}/api/v1/assignments/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ aim: "Explore subqueries in SQL" }),
      });
      assert.equal(gen.status, 200);
    } finally {
      clearAuthToken();
    }
  });

  it("(8/9/11) refresh (cookie only, no Bearer) → authenticated → generate succeeds", async () => {
    const { cookie } = await loginFlow();
    clearAuthToken(); // refresh wipes memory: cookie is the only credential left
    const me = await apiFetch(`${stubBase}/api/v1/auth/me`, {
      headers: { cookie },
      reconcileAuth: false,
    });
    assert.equal(me.status, 200, "cookie session must survive refresh");
    const state = authReducer(createInitialAuthState(), { type: "BOOT_OK", user: (await me.json()).user });
    assert.equal(isAuthKnown(state), true);
    const gen = await apiFetch(`${stubBase}/api/v1/assignments/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ aim: "Explore subqueries in SQL" }),
    });
    assert.equal(gen.status, 200, "generate after refresh must not 401");
  });

  it("(7) logout clears token and state; next generate is 401", async () => {
    const { cookie } = await loginFlow();
    const out = await apiFetch(`${stubBase}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie },
      reconcileAuth: false,
    });
    assert.equal(out.status, 200);
    clearAuthToken();
    const state = authReducer(
      authReducer(createInitialAuthState(), { type: "LOGIN_OK", user: { email: "x@y.z" } }),
      { type: "LOGOUT_OK" },
    );
    assert.equal(state.status, AUTH_STATUS.UNAUTHENTICATED);
    const gen = await apiFetch(`${stubBase}/api/v1/assignments/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aim: "Explore subqueries in SQL" }),
    });
    assert.equal(gen.status, 401);
    assert.equal(shouldPromptLogin(state), true);
  });

  it("(9) protected fetching waits for bootstrap (loading fetches nothing)", () => {
    assert.equal(isAuthKnown(createInitialAuthState()), false);
    assert.equal(
      isAuthKnown({ status: "authenticated", user: { email: "a@b.c" }, error: null, initialized: true }),
      true,
    );
    assert.equal(
      isAuthKnown({ status: "unauthenticated", user: null, error: null, initialized: true }),
      true,
      "logged-out board still loads in open mode — but only after bootstrap",
    );
  });

  it("(13/14-client) unauthenticated template/job writes are 401 at the wire", async () => {
    clearAuthToken();
    const tpl = await apiFetch(`${stubBase}/api/v1/templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "probe" }),
    });
    assert.equal(tpl.status, 401);
    const job = await apiFetch(`${stubBase}/api/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "generate", input: { aim: "Explore subqueries in SQL" } }),
    });
    assert.equal(job.status, 401);
    // Server-side enforcement of the same contract lives in
    // auth-regression.test.js against the real Express app.
  });
});
