import { Router } from "express";
import { clearSessionCookie, getProfileByEmail, loginUser, registerUser, setSessionCookie } from "../lib/auth.js";
import { sendError } from "../lib/errors.js";

export const authRouter = Router();

// Only these product-copy messages may reach the client; anything else
// (driver text, bcrypt failures) stays in the server log.
const SAFE_AUTH_MESSAGES = new Set([
  "Valid email is required",
  "Password must be at least 8 chars",
  "Email already registered",
  "Invalid email or password",
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

authRouter.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  // Enrich token claims (sub+email only) with the stored profile so clients
  // can display the user's real name. Never fails the request: claims alone
  // are enough for identity, profile fields just go empty.
  let profile = null;
  try {
    profile = getProfileByEmail(req.user.email);
    if (!profile) {
      // Memory is cold (e.g. API restart) but Mongo may still hold the profile.
      const mongoose = (await import("mongoose")).default;
      if (mongoose.connection.readyState === 1) {
        const { User } = await import("../models/index.js");
        profile = await User.findOne({ email: String(req.user.email ?? "").toLowerCase().trim() }).lean();
      }
    }
  } catch {
    profile = null;
  }
  return res.json({
    user: {
      ...req.user,
      name: profile?.name ?? "",
      avatarUrl: profile?.avatarUrl ?? profile?.avatar ?? "",
    },
  });
});
