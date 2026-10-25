// STAGE 1: CORS origin policy.
//
// Browser origins are allowlisted through ALLOWED_ORIGINS (comma separated).
// Local development and tests keep the historical permissive default so the
// existing Vite proxy/localhost workflows are not disrupted. In production an
// empty allowlist FAILS CLOSED for browser origins: reflecting arbitrary
// origins while credentials:true is unsafe, and a misconfiguration must not
// silently turn into "any website can call the API with the user's cookie".
//
// Non-browser callers (no Origin header: curl, health checks, server-to-server)
// are not part of the browser CORS model and continue to pass.

export function corsAllowList(env = process.env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isProduction(env = process.env) {
  return env.NODE_ENV === "production";
}

export function corsOrigin(origin, env = process.env) {
  // Same-origin/non-browser requests do not carry an Origin header.
  if (!origin) return true;

  const allow = corsAllowList(env);
  if (allow.length > 0) return allow.includes(origin);

  // No allowlist: permissive outside production, fail closed in production.
  return !isProduction(env);
}

export function corsOptions(env = process.env) {
  return {
    origin: (origin, callback) => callback(null, corsOrigin(origin, env)),
    credentials: true,
  };
}
