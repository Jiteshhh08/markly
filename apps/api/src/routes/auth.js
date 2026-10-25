import { Router } from "express";
import {
  clearSessionCookie,
  getProfileByEmail,
  loginUser,
  registerUser,
  setSessionCookie,
  updateProfileForUser,
} from "../lib/auth.js";
import { sendError } from "../lib/errors.js";

export const authRouter = Router();

// Only these product-copy messages may reach the client; anything else
// (driver text, bcrypt failures) stays in the server log.
const SAFE_AUTH_MESSAGES = new Set([
  "Valid email is required",
  "Password must be at least 8 chars",
  "Email already registered",
  "Invalid email or password",
  "No profile fields to update",
  "Name must be a string",
  "Name is too long",
  "Avatar URL must be a string",
  "Avatar URL is too long",
]);

function authError(res, status, err, fallback) {
  const msg = String(err?.message ?? err);
  if (SAFE_AUTH_MESSAGES.has(msg)) return res.status(status).json({ error: msg });
  return sendError(res, status, fallback, msg);
}

authRouter.post("/register", async (req, res) => {
  try {
    const token = await registerUser(req.body ?? {});
    // httpOnly cookie = login survives refresh with zero browser storage.
    // The token is ALSO returned for in-memory Bearer use (dev simplicity).
    setSessionCookie(res, token);
    return res.status(201).json({ token });
  } catch (err) {
    const msg = String(err?.message ?? "");
    const status = msg.includes("already registered") ? 409 : 400;
    return authError(res, status, err, "Couldn't create the account. Please try again.");
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const token = await loginUser(req.body ?? {});
    setSessionCookie(res, token);
    return res.json({ token });
  } catch (err) {
    return authError(res, 401, err, "Couldn't log you in. Please try again.");
  }
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// Public profile updates are deliberately narrow: name/avatar only. Role and
// college scope are never accepted from this route, even if a client sends
// them. Registration is similarly role-free.
authRouter.patch("/profile", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  try {
    const user = await updateProfileForUser(req.user.sub, req.body ?? {});
    return res.json({ user });
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (SAFE_AUTH_MESSAGES.has(msg)) return res.status(400).json({ error: msg });
    return sendError(res, 400, "Couldn't update the profile. Please try again.", msg);
  }
});

authRouter.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  // Enrich token claims (sub+email only) with the CURRENT persisted profile.
  // Role and college scope are read from MongoDB, never from the token, so a
  // privilege change takes effect on the next request without re-issuing a
  // token. Never fails the request: claims alone are enough for identity;
  // role/scope simply fall back to the ordinary-user defaults.
  let profile = null;
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState === 1) {
      const { User } = await import("../models/index.js");
      profile = await User.findOne({
        email: String(req.user.email ?? "").toLowerCase().trim(),
      }).lean();
    }
    if (!profile) profile = getProfileByEmail(req.user.email);
  } catch {
    profile = null;
  }
  const role = ["user", "college_admin", "platform_admin"].includes(profile?.role)
    ? profile.role
    : "user";
  const collegeAdminOf = Array.isArray(profile?.collegeAdminOf)
    ? profile.collegeAdminOf.map(String)
    : [];
  const tenantIds = Array.isArray(profile?.tenantIds) ? profile.tenantIds.map(String) : [];
  return res.json({
    user: {
      ...req.user,
      name: profile?.name ?? "",
      avatarUrl: profile?.avatarUrl ?? profile?.avatar ?? "",
      role,
      collegeAdminOf,
      tenantIds,
      preferences: profile?.preferences
        ? {
            collegeId: profile.preferences.collegeId ?? null,
            departmentId: profile.preferences.departmentId ?? null,
            preferredTemplateId: profile.preferences.preferredTemplateId ?? null,
            preferredTemplateVersion: profile.preferences.preferredTemplateVersion ?? null,
            setupCompletedAt: profile.preferences.setupCompletedAt ?? null,
            updatedAt: profile.preferences.updatedAt ?? null,
          }
        : null,
    },
  });
});
