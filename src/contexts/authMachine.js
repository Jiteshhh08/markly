// Auth state machine — the logic core of AuthContext, kept in plain JS
// (no JSX) so the transition contract is unit-testable under node:test.
//
// Statuses:
//   loading        — bootstrap in flight; NOT logged out. No protected
//                    fetching, no login prompts while here.
//   authenticated  — valid session (user set).
//   unauthenticated— no session (genuine 401 / logged out / never logged in).
//                    Only here may the UI prompt for login.
//   error          — bootstrap/refresh could not reach a verdict (network
//                    failure, 5xx). Retryable; never treated as logged out.
//
// Rules (pinned by tests):
// - Only a genuine 401 moves state toward unauthenticated.
// - Network errors and 5xx NEVER clear an authenticated session and NEVER
//   convert bootstrap into "logged out".
// - Protected data fetching starts when auth is KNOWN (initialized), not
//   when it is authenticated: logged-out users still use the workspace in
//   open dev mode, but nothing fires while status is loading.

export const AUTH_STATUS = {
  LOADING: "loading",
  AUTHENTICATED: "authenticated",
  UNAUTHENTICATED: "unauthenticated",
  ERROR: "error",
};

export function createInitialAuthState() {
  return { status: AUTH_STATUS.LOADING, user: null, error: null, initialized: false };
}

function toUser(payload) {
  if (!payload) return null;
  const email = payload.email ?? "";
  if (!email) return null;
  return {
    email,
    name: payload.name ?? "",
    avatarUrl: payload.avatarUrl ?? "",
    id: payload.sub ?? payload.id ?? "",
  };
}

export function authReducer(state, action) {
  switch (action.type) {
    case "BOOT_OK":
    case "LOGIN_OK": {
      const user = toUser(action.user);
      if (!user) return { ...state, status: AUTH_STATUS.UNAUTHENTICATED, user: null, error: null, initialized: true };
      return { status: AUTH_STATUS.AUTHENTICATED, user, error: null, initialized: true };
    }
    case "BOOT_NO_SESSION":
    case "LOGOUT_OK":
      return { status: AUTH_STATUS.UNAUTHENTICATED, user: null, error: null, initialized: true };
    case "BOOT_TRANSPORT_ERROR":
      // Could not reach a verdict (server/network down). Surface as a
      // retryable error — NOT as logged-out.
      return { status: AUTH_STATUS.ERROR, user: null, error: action.error, initialized: true };
    case "UNAUTHORIZED":
      // Genuine 401 against a live session: the session is gone.
      if (state.status === AUTH_STATUS.AUTHENTICATED) {
        return { status: AUTH_STATUS.UNAUTHENTICATED, user: null, error: { type: "unauthorized" }, initialized: true };
      }
      return state;
    case "TRANSPORT_ERROR": {
      // Network/5xx against a live session: keep the session, record the
      // transient failure. Against no session: leave state alone.
      if (state.status === AUTH_STATUS.AUTHENTICATED) {
        return { ...state, error: action.error };
      }
      return state;
    }
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "RESET_BOOT":
      return createInitialAuthState();
    default:
      return state;
  }
}

// Error classification shared by the provider and tests.
export function isUnauthorizedError(err) {
  return err?.status === 401 || err?.response?.status === 401;
}

export function isTransportFailure(err) {
  if (!err) return false;
  if (err.network === true || err.timeout === true) return true;
  const status = err.status ?? err.response?.status;
  if (status === undefined || status === null) return true; // no status = never reached the API
  return status >= 500;
}

// Auth is KNOWN once bootstrap resolved (any verdict). Protected fetching
// gates on this — never on `authenticated` alone, and never while loading.
export function isAuthKnown(state) {
  return state.initialized === true && state.status !== AUTH_STATUS.LOADING;
}

// Only the unauthenticated verdict may trigger a login prompt. Loading and
// error states must show progress/connectivity UI instead — never the modal.
export function shouldPromptLogin(state) {
  return state.initialized === true && state.status === AUTH_STATUS.UNAUTHENTICATED;
}
