import mongoose from "mongoose";

// STAGE 1 authorization primitives.
//
// SECURITY RULE: admin authorization is based on the CURRENT persisted User
// document, never on a role claim copied into a JWT. Tokens carry only `sub`
// and `email`; a forged `role` claim is ignored.

export const ROLE_USER = "user";
export const ROLE_COLLEGE_ADMIN = "college_admin";
export const ROLE_PLATFORM_ADMIN = "platform_admin";
export const ROLES = Object.freeze([ROLE_USER, ROLE_COLLEGE_ADMIN, ROLE_PLATFORM_ADMIN]);

export function normalizeRole(value) {
  return ROLES.includes(value) ? value : ROLE_USER;
}

export function actorFromUserDoc(doc) {
  if (!doc) return null;
  const id = doc.id ?? (doc._id ? String(doc._id) : null);
  if (!id) return null;
  return {
    id,
    email: String(doc.email ?? "").toLowerCase().trim(),
    name: doc.name ?? "",
    role: normalizeRole(doc.role),
    collegeAdminOf: Array.isArray(doc.collegeAdminOf)
      ? doc.collegeAdminOf.map(String)
      : [],
    preferences: doc.preferences
      ? {
          collegeId: doc.preferences.collegeId ?? null,
          departmentId: doc.preferences.departmentId ?? null,
          preferredTemplateId: doc.preferences.preferredTemplateId ?? null,
        }
      : null,
  };
}

// Reads the user from MongoDB. Deliberately does not consult the in-memory auth
// cache or JWT claims: a role change must take effect without issuing new tokens.
export async function loadActorById(userId) {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  if (mongoose.connection.readyState !== 1) return null;

  const { User } = await import("../models/index.js");
  let doc = await User.findOne({ id }).lean();
  if (!doc && mongoose.Types.ObjectId.isValid(id)) {
    doc = await User.findById(id).lean();
  }
  return actorFromUserDoc(doc);
}

export async function loadActor(req) {
  if (!req?.user?.sub) return null;
  return loadActorById(req.user.sub);
}

export function isPlatformAdmin(actor) {
  return actor?.role === ROLE_PLATFORM_ADMIN;
}

export function isCollegeAdmin(actor) {
  return actor?.role === ROLE_COLLEGE_ADMIN;
}

export function isOrdinaryUser(actor) {
  return !actor || normalizeRole(actor.role) === ROLE_USER;
}

export function isCollegeAdminOf(actor, collegeId) {
  if (!collegeId) return false;
  return isCollegeAdmin(actor) && actor.collegeAdminOf.includes(String(collegeId));
}

export function canAccessCollege(actor, collegeId) {
  return isPlatformAdmin(actor) || isCollegeAdminOf(actor, collegeId);
}

// Always requires a valid token. This is intentionally stronger than
// requireAuthIfEnabled(), which is allowed to be open in local development.
export function requireAuthenticated(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  return next();
}

async function ensurePersistedActor(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Authorization is temporarily unavailable" });
    return null;
  }
  let actor;
  try {
    actor = await loadActor(req);
  } catch (err) {
    console.error("[authz] failed to load persisted actor:", String(err).slice(0, 300));
    res.status(503).json({ error: "Authorization is temporarily unavailable" });
    return null;
  }
  if (!actor) {
    // A valid token for a deleted/unknown user is not authorization.
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  req.actor = actor;
  return actor;
}

export async function requirePersistedActor(req, res, next) {
  const actor = await ensurePersistedActor(req, res);
  if (!actor) return;
  next();
}

export function requireRole(...roles) {
  const allowed = new Set(roles.map(normalizeRole));
  return async (req, res, next) => {
    const actor = req.actor ?? (await ensurePersistedActor(req, res));
    if (!actor) return;
    if (!allowed.has(actor.role)) {
      return res.status(403).json({ error: "You do not have permission to do that" });
    }
    return next();
  };
}

export const requirePlatformAdmin = requireRole(ROLE_PLATFORM_ADMIN);

export function requireCollegeAdmin(getCollegeId) {
  return async (req, res, next) => {
    const actor = req.actor ?? (await ensurePersistedActor(req, res));
    if (!actor) return;

    let collegeId;
    try {
      collegeId =
        typeof getCollegeId === "function"
          ? await getCollegeId(req)
          : getCollegeId ?? req.params?.collegeId ?? req.body?.collegeId;
    } catch {
      collegeId = null;
    }
    if (!collegeId) {
      return res.status(400).json({ error: "College id is required" });
    }
    if (canAccessCollege(actor, collegeId)) return next();
    return res.status(403).json({ error: "You do not have permission to manage this college" });
  };
}

// Alias used by future route modules; keeps intent clear at call sites.
export const requireCollegeScope = requireCollegeAdmin;
