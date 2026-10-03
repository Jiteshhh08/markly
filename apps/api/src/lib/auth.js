import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Minimal local auth (Phase 9). Users live in memory in dev; Mongo persistence
// is best-effort when connected. Set AUTH_REQUIRED=1 to enforce tokens on
// write endpoints; otherwise the API runs open for local development.

const users = new Map(); // email -> { id, email, name, passwordHash, tenantIds }

function secret() {
  // A publicly documented placeholder must never become a real signing key:
  // fail closed in production, warn loudly in dev.
  const placeholders = new Set(["", "change-me-in-production", "changeme", "secret", "dev-only-insecure-secret"]);
  const configured = process.env.JWT_SECRET ?? "";
  if (!placeholders.has(configured)) return configured;
  if (process.env.AUTH_REQUIRED === "1") {
    throw new Error("[auth] refusing to run with a placeholder JWT_SECRET while AUTH_REQUIRED=1. Set a strong random value.");
  }
  console.warn("[auth] JWT_SECRET not set (or still the documented placeholder) — using insecure dev default. Set a strong value before deploying.");
  return "dev-only-insecure-secret";
}

export async function registerUser({ email, password, name }) {
  const key = String(email ?? "").toLowerCase().trim();
  if (!key.includes("@")) throw new Error("Valid email is required");
  if (!password || String(password).length < 8) throw new Error("Password must be at least 8 chars");
  if (users.has(key)) throw new Error("Email already registered");
  const passwordHash = await bcrypt.hash(String(password), 10);
  const user = { id: `usr_${Date.now()}`, email: key, name: name ?? "", passwordHash, tenantIds: [] };
  users.set(key, user);
  // Awaited: the account must be durable before the first token is trusted.
  // Still non-fatal without Mongo (dev open mode) — tryPersist swallows there.
  await tryPersist(user);
  return signToken(user);
}

export async function loginUser({ email, password }) {
  const key = String(email ?? "").toLowerCase().trim();
  let user = users.get(key);
  if (!user) {
    // Memory is cold (API restart) — rehydrate from the durable Mongo copy
    // before rejecting. Without this, every restart logged everyone out.
    user = await findPersistedUser(key);
    if (user) users.set(key, user);
  }
  if (!user || !(await bcrypt.compare(String(password ?? ""), user.passwordHash))) {
    throw new Error("Invalid email or password");
  }
  return signToken(user);
}

// Warms the in-memory Map from Mongo at boot (and any other cold start).
// Returns the number of users loaded; never throws (dev without Mongo = 0).
export async function hydrateUsersFromMongo() {
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return 0;
    const { User } = await import("../models/index.js");
    const docs = await User.find({ passwordHash: { $exists: true, $ne: null } }).lean();
    let loaded = 0;
    for (const d of docs) {
      if (!d?.email) continue;
      users.set(String(d.email).toLowerCase().trim(), {
        id: d.id ?? d._id?.toString() ?? `usr_${d.email}`,
        email: String(d.email).toLowerCase().trim(),
        name: d.name ?? "",
        avatarUrl: d.avatarUrl ?? "",
        passwordHash: d.passwordHash,
        tenantIds: d.tenantIds ?? [],
      });
      loaded += 1;
    }
    return loaded;
  } catch {
    return 0;
  }
}

async function findPersistedUser(key) {
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return null;
    const { User } = await import("../models/index.js");
    const d = await User.findOne({ email: key }).lean();
    if (!d?.passwordHash) return null;
    return {
      id: d.id ?? d._id?.toString() ?? `usr_${key}`,
      email: key,
      name: d.name ?? "",
      avatarUrl: d.avatarUrl ?? "",
      passwordHash: d.passwordHash,
      tenantIds: d.tenantIds ?? [],
    };
  } catch {
    return null;
  }
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, secret(), { expiresIn: "7d" });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret());
  } catch {
    return null;
  }
}

// Profile lookup for identity display (name/avatar). Tokens only carry
// sub+email, so the full profile is resolved here from the same store that
// register/login use. Returns null when unknown — callers fall back to claims.
export function getProfileByEmail(email) {
  return users.get(String(email ?? "").toLowerCase().trim()) ?? null;
}

export const COOKIE_NAME = "markly_token";

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs() {
  // Cross-site production (Vercel -> API) needs SameSite=None + Secure;
  // same-origin local dev works with Lax. Toggle with COOKIE_SECURE=1.
  const secure = process.env.COOKIE_SECURE === "1";
  return {
    httpOnly: true,
    path: "/",
    maxAge: 7 * 24 * 3600 * 1000,
    sameSite: secure ? "none" : "lax",
    secure,
  };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieAttrs());
}

export function clearSessionCookie(res) {
  // Must mirror setSessionCookie's attributes: browsers won't delete a
  // SameSite=None; Secure cookie when cleared with Lax defaults, which would
  // resurrect the session on the next refresh (logout that doesn't stick).
  const secure = process.env.COOKIE_SECURE === "1";
  res.clearCookie(COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
  });
}

export function tokenFromRequest(req) {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = parseCookies(req)[COOKIE_NAME] ?? "";
  // Deterministic precedence (STAGE 3): a VALID Bearer wins; otherwise a
  // VALID cookie wins. An invalid/missing Bearer must never mask a valid
  // cookie session (previously Bearer won unconditionally, so any garbage
  // Authorization header logged the user out despite a good cookie).
  // Fallback returns the explicitly supplied credential (even if invalid) so
  // unauthenticated callers still 401 exactly as before — no weakening:
  // an attacker with no valid credential gets null from verifyToken either way.
  if (bearer && verifyToken(bearer)) return bearer;
  if (cookie && verifyToken(cookie)) return cookie;
  return bearer || cookie || "";
}

// Attaches req.user from Bearer token OR httpOnly session cookie; never rejects.
export function authAttach(req, _res, next) {
  const claims = verifyToken(tokenFromRequest(req));
  if (claims) req.user = claims;
  next();
}

// Enforces auth only when AUTH_REQUIRED=1 (production); open otherwise.
export function requireAuthIfEnabled(req, res, next) {
  if (process.env.AUTH_REQUIRED === "1" && !req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  return next();
}

async function tryPersist(user) {
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return;
    const { User } = await import("../models/index.js");
    // STAGE 4: the hash MUST be persisted — stripping it (as before) wrote a
    // Mongo copy that could never satisfy bcrypt login after a restart.
    await User.updateOne({ email: user.email }, { $set: user }, { upsert: true });
  } catch {
    // Non-fatal in local mode.
  }
}
