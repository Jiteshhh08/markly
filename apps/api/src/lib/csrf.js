import { COOKIE_NAME, verifyToken } from "./auth.js";
import { corsAllowList } from "./cors.js";

// STAGE 1: CSRF protection for cookie-authenticated mutations.
//
// The session cookie is httpOnly but browsers attach it automatically, so a
// cross-site form/fetch could otherwise mutate data as the logged-in user.
// Bearer tokens are not ambient credentials and therefore bypass this check.
//
// This middleware is intentionally reusable and is NOT mounted on legacy
// routes in STAGE 1. It must wrap every future admin mutation route. The rule
// is fail-closed: a cookie-authenticated unsafe request needs an Origin (or
// Referer fallback) that is either in ALLOWED_ORIGINS or same-origin with the
// API host. Missing/foreign origins are rejected with 403.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseCookieHeader(header, name = COOKIE_NAME) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function bearerToken(req) {
  const header = String(req?.headers?.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// True only when the request is authenticated by a VALID cookie and does not
// carry a valid Bearer token. Invalid cookies are left to the auth layer (401),
// but they are not treated as an authenticated mutation here.
export function cookieAuthenticated(req) {
  const cookie = parseCookieHeader(req?.headers?.cookie)[COOKIE_NAME] ?? "";
  if (!cookie || !verifyToken(cookie)) return false;

  const bearer = bearerToken(req);
  if (bearer && verifyToken(bearer)) return false;
  return true;
}

export function requestOrigin(req) {
  const origin = String(req?.headers?.origin ?? "").trim();
  if (origin) return origin;

  const referer = String(req?.headers?.referer ?? "").trim();
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function requestHost(req) {
  // Host only. `X-Forwarded-Host` is client-controllable unless a trusted
  // proxy strips it, so it must not be able to satisfy the same-origin check.
  // Deployments behind a proxy should preserve Host or set ALLOWED_ORIGINS.
  return String(req?.headers?.host ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

export function isSameOrigin(req, origin) {
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === requestHost(req);
  } catch {
    return false;
  }
}

export function isCsrfOriginAllowed(req, env = process.env) {
  const origin = requestOrigin(req);
  if (!origin) return false;

  const allow = corsAllowList(env);
  if (allow.length > 0) return allow.includes(origin);

  // No allowlist configured: same-origin only. This is safe in every
  // environment and keeps direct same-origin API deployments working.
  return isSameOrigin(req, origin);
}

export function csrfProtection({ env = process.env } = {}) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(String(req.method ?? "GET").toUpperCase())) return next();
    if (!cookieAuthenticated(req)) return next();

    if (isCsrfOriginAllowed(req, env)) return next();
    return res.status(403).json({ error: "Cross-site request blocked" });
  };
}
