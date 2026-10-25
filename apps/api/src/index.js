import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { assignmentsRouter } from "./routes/assignments.js";
import { authRouter } from "./routes/auth.js";
import { examplesRouter } from "./routes/examples.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { templatesRouter } from "./routes/templates.js";
import { authAttach, hydrateUsersFromMongo, requireAuthIfEnabled } from "./lib/auth.js";
import { corsAllowList, corsOptions, isProduction } from "./lib/cors.js";
import { assetsDir, ensureDirs } from "./lib/storage.js";

dotenv.config();

// Surface async route bugs loudly instead of dropping connections silently.
process.on("unhandledRejection", (err) => {
  console.error("[api] UNHANDLED_REJECTION:", err);
});

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
// credentials:true + origin policy: ALLOWED_ORIGINS (comma-separated) locks
// the API to known frontends. Unset = reflect any origin outside production
// (local-dev default); in production an empty allowlist FAILS CLOSED for
// browser origins. Evaluated per request so tests and env changes apply live.
app.use(cors(corsOptions()));
app.use(express.json({ limit: "1mb" }));

// Minimal request logging (Phase 9 observability baseline).
app.use((req, _res, next) => {
  console.log(`[api] ${req.method} ${req.path}`);
  next();
});
app.use(authAttach);

// Tenant artwork (headers, watermarks, logos) served as static files.
ensureDirs();
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
app.use("/api/v1/assignments", requireAuthIfEnabled, assignmentsRouter);
app.use("/api/v1/examples", requireAuthIfEnabled, examplesRouter);
app.use("/api/v1/jobs", requireAuthIfEnabled, jobsRouter);
app.use("/api/v1/templates", requireAuthIfEnabled, templatesRouter);

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
    } catch (err) {
      console.warn("[api] MongoDB connection failed, continuing in-memory:", String(err));
    }
  } else {
    console.warn("[api] MONGODB_URI not set — running in-memory (Phase 1 POC mode)");
  }
  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

if (process.env.NODE_ENV !== "test") {
  void main();
}

export default app;

