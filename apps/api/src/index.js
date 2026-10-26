import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { adminRouter } from "./routes/admin.js";
import { assignmentsRouter } from "./routes/assignments.js";
import { authRouter } from "./routes/auth.js";
import { examplesRouter } from "./routes/examples.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { preferencesRouter } from "./routes/preferences.js";
import { templatesRouter } from "./routes/templates.js";
import {
  assertAuthConfiguration,
  authAttach,
  hydrateUsersFromMongo,
  requireAuthIfEnabled,
} from "./lib/auth.js";
import { corsAllowList, corsOptions, isProduction } from "./lib/cors.js";
import { csrfProtection } from "./lib/csrf.js";
import { requirePersistedActor } from "./lib/roles.js";
import { assetsDir, ensureDirs } from "./lib/storage.js";
import { hydrateTemplatesFromMongo } from "./lib/templateStore.js";

dotenv.config();

// Surface async route bugs loudly instead of dropping connections silently.
process.on("unhandledRejection", (err) => {
  console.error("[api] UNHANDLED_REJECTION:", err);
});

const app = express();
// The documented production topology is Caddy on the host proxying to
// 127.0.0.1:4000. Without this, every request appears to come from Caddy and
// all users share one rate-limit bucket. "loopback" trusts X-Forwarded-For
// only from a local reverse proxy, so a direct internet caller cannot spoof
// its address. Override with TRUST_PROXY (a hop count, subnet, or "false")
// when the proxy runs on a Docker bridge network.
const trustProxy = String(process.env.TRUST_PROXY ?? "loopback").trim();
if (trustProxy && !["0", "false"].includes(trustProxy.toLowerCase())) {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}
app.use(helmet({ crossOriginResourcePolicy: false }));
// credentials:true + origin policy: ALLOWED_ORIGINS (comma-separated) locks
// the API to known frontends. Unset = reflect any origin outside production
// (local-dev default); in production an empty allowlist FAILS CLOSED for
// browser origins. Evaluated per request so tests and env changes apply live.
app.use(cors(corsOptions()));
app.use(express.json({ limit: "1mb" }));

// Dynamic API responses are user- and role-specific and must never be stored
// or revalidated by a browser or shared cache. A cached 401 from before login
// otherwise survives a refresh (the browser replays it with If-None-Match and
// the server answers 304), making a valid session look logged out. Static
// /assets keep their normal caching because they are content-addressed files.
app.use("/api/", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Minimal request logging (Phase 9 observability baseline).
app.use((req, _res, next) => {
  console.log(`[api] ${req.method} ${req.path}`);
  next();
});
app.use(authAttach);

// Tenant artwork (headers, watermarks, logos) served as static files.
// Generated assignment PDFs live under assets/generated but are private user
// data: they are served only by the authenticated assignment PDF route, never
// by the public artwork mount. Their names are predictable, so exposing the
// directory would let anyone enumerate and download other users' documents.
ensureDirs();
app.use("/assets/generated", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use("/assets", express.static(assetsDir));

// Basic rate limiting (in-memory window; point at Redis when REDIS_URL is set in production).
const hits = new Map();
app.use("/api/", (req, res, next) => {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const entry = hits.get(key);
  const limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + 60_000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > limit) return res.status(429).json({ error: "Rate limit exceeded" });
  return next();
});

app.use("/api/v1/health", healthRouter);
app.use("/api/v1/auth", authRouter);
// STAGE 3: every user-owned / mutating resource honors AUTH_REQUIRED=1.
// Previously only /assignments was guarded; /templates, /jobs and /examples
// stayed open in production. /health intentionally stays public.
// Cookie-authenticated mutations are CSRF-checked in production. Bearer
// requests bypass the ambient-cookie check; non-production keeps the
// historical open behavior for local development and the existing suites.
app.use(
  "/api/v1/assignments",
  requireAuthIfEnabled,
  csrfProtection({ productionOnly: true }),
  assignmentsRouter,
);
app.use(
  "/api/v1/examples",
  requireAuthIfEnabled,
  csrfProtection({ productionOnly: true }),
  examplesRouter,
);
app.use(
  "/api/v1/jobs",
  requireAuthIfEnabled,
  csrfProtection({ productionOnly: true }),
  jobsRouter,
);
// STAGE 4: preferences are always private to the persisted actor. Unlike the
// other user resources, this router is NEVER open in local mode: a saved
// college/branch must identify a real MongoDB user, and anonymous callers get
// 401 rather than an in-memory preference that disappears on restart.
app.use(
  "/api/v1/preferences",
  requirePersistedActor,
  csrfProtection({ productionOnly: true }),
  preferencesRouter,
);
// STAGE 2: cookie-authenticated template mutations are CSRF-checked in
// production. Bearer requests bypass the ambient-cookie check; non-production
// keeps the historical behavior (and the existing test suite) intact.
app.use(
  "/api/v1/templates",
  requireAuthIfEnabled,
  csrfProtection({ productionOnly: true }),
  templatesRouter,
);
// STAGE 3: admin routes are authenticated and authorized UNCONDITIONALLY.
// requirePersistedActor reads the current MongoDB user (never JWT role claims)
// and therefore still rejects anonymous callers when AUTH_REQUIRED=0. Cookie
// mutations get the same production-only CSRF check as template mutations.
app.use(
  "/api/v1/admin",
  requirePersistedActor,
  csrfProtection({ productionOnly: true }),
  adminRouter,
);

app.get("/", (_req, res) => {
  res.json({ service: "Markly-api", docs: "/api/v1/health" });
});

// Last stop: never leak stacks or internals (Express's default handler renders
// HTML stack pages when NODE_ENV !== "production", and body-parser errors land
// here too). Real details go to the server log only.
const SAFE_CLIENT_MESSAGES = new Set(["Only .pdf uploads are accepted"]);
app.use((err, _req, res, _next) => {
  if (SAFE_CLIENT_MESSAGES.has(err?.message)) {
    return res.status(400).json({ error: err.message });
  }
  const status = err?.status ?? err?.statusCode ?? 500;
  const code = status >= 400 && status < 600 ? status : 500;
  console.error(`[api] unhandled request error (${code}):`, err);
  if (res.headersSent) return;
  res.status(code).json({ error: "Something went wrong. Please try again." });
});

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  // Refuse to start with the documented placeholder JWT_SECRET while auth is
  // enforced; otherwise the process would boot and fail on the first request.
  assertAuthConfiguration();
  if (isProduction() && corsAllowList().length === 0) {
    console.error(
      "[api] NODE_ENV=production but ALLOWED_ORIGINS is unset — browser origins are BLOCKED. " +
        "Set ALLOWED_ORIGINS=https://your-frontend.",
    );
  } else if (process.env.AUTH_REQUIRED === "1" && corsAllowList().length === 0) {
    console.warn(
      "[api] AUTH_REQUIRED=1 but ALLOWED_ORIGINS is unset — CORS reflects any origin outside production. " +
        "Set ALLOWED_ORIGINS=https://your-frontend in production.",
    );
  }
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("[api] connected to MongoDB");
      // STAGE 4: warm the auth Map so logins survive restarts. Pre-existing
      // User docs without a passwordHash are skipped (re-registration needed).
      const warmed = await hydrateUsersFromMongo();
      console.log(`[api] rehydrated ${warmed} user(s) from MongoDB`);
      // STAGE 2: load persisted template versions before accepting requests.
      // The JSON seed remains a built-in fallback for IDs not yet persisted.
      const templates = await hydrateTemplatesFromMongo();
      console.log(`[api] rehydrated ${templates.count} template version(s) from MongoDB`);
    } catch (err) {
      console.warn("[api] MongoDB connection failed, continuing in-memory:", String(err));
    }
  } else {
    console.warn("[api] MONGODB_URI not set — running in-memory (Phase 1 POC mode)");
  }
  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    // Boot failures (including a placeholder JWT_SECRET while auth is
    // enforced) must terminate the process, not leave it alive without a
    // listener. The unhandledRejection handler above only logs.
    console.error("[api] startup failed:", err);
    process.exit(1);
  });
}

export default app;

