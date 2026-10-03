// Canonical Markly API client — the ONLY fetch wrapper the app uses.
//
// Contract:
// - base URL from VITE_API_URL with an empty-string-safe fallback (STAGE 1:
//   `??` let an empty baked var produce relative URLs against the Vercel
//   origin). `||` + trim treats ""/whitespace as unset.
// - `credentials: "include"` on every request: the httpOnly `markly_token`
//   cookie is the canonical browser credential and the only thing that
//   survives a browser refresh (nothing auth-related lives in browser storage).
// - Single in-memory Bearer store. Written ONLY by AuthContext (login/
//   refresh/logout); read ONLY here to attach `Authorization`. Components
//   never touch tokens — they ask AuthContext for status/user/actions.
// - Returns the raw Response (callers keep their .ok/.status/.json() logic).
//   Transport failures throw a friendly Error (no status); HTTP errors are
//   left on the Response so callers distinguish 401/403/404/500.
// - 401 reconciliation is centralized: on an HTTP 401 (and only 401) the
//   single `onUnauthorized` hook fires so AuthContext can transition state.
//   Network errors and 5xx never touch auth state. The hook never throws and
//   never opens UI — UI prompts stay with explicit user actions, so there is
//   no infinite login loop. Auth endpoints themselves pass
//   `{ reconcileAuth: false }` and reconcile explicitly.

function readEnvBase() {
  try {
    const raw =
      typeof import.meta !== "undefined" && import.meta.env
        ? import.meta.env.VITE_API_URL
        : undefined;
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim().replace(/\/$/, "");
  } catch {
    // Plain node (tests): import.meta.env is undefined — fall through.
  }
  if (typeof process !== "undefined" && process.env && process.env.VITE_API_URL) {
    const raw = String(process.env.VITE_API_URL).trim();
    if (raw !== "") return raw.replace(/\/$/, "");
  }
  return "http://127.0.0.1:4000";
}

export const API_BASE = readEnvBase();

export function resolveApiUrl(path) {
  if (typeof path !== "string") return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

// --- single Bearer store (AuthContext is the only writer) ---
let authToken = "";

export function setAuthToken(token) {
  authToken = token ?? "";
}

export function getAuthToken() {
  return authToken;
}

export function clearAuthToken() {
  authToken = "";
}

export function authHeaders(extra = {}) {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

// --- centralized 401 hook (AuthContext sets it once) ---
let onUnauthorizedHook = null;

export function setAuthHooks({ onUnauthorized } = {}) {
  onUnauthorizedHook = typeof onUnauthorized === "function" ? onUnauthorized : null;
}

function notifyUnauthorized() {
  if (!onUnauthorizedHook) return;
  try {
    onUnauthorizedHook();
  } catch {
    // Reconciliation must never break the request path.
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

export async function apiFetch(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, reconcileAuth = true, ...init } = options;
  const headers = authHeaders(init.headers ?? {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller-supplied signal (e.g. a shorter timeout) still works: whichever
  // fires first wins; clearing the timer below is harmless either way.
  const signal = init.signal ?? controller.signal;
  try {
    const res = await fetch(resolveApiUrl(url), {
      credentials: "include",
      ...init,
      headers,
      signal,
    });
    if (res.status === 401 && reconcileAuth) notifyUnauthorized();
    return res;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("The request timed out. Please try again.");
    throw new Error("Couldn't reach the Markly service. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}
