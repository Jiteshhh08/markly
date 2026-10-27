import mongoose from "mongoose";
import { AuditLog } from "../models/index.js";
import { isProduction } from "./cors.js";

// STAGE 3: awaited administrative audit trail.
//
// A mutation must not report success while silently pretending it was audited.
// Callers await recordAudit() and surface an explicit error if persistence
// fails. Metadata is reduced to safe, bounded fields; passwords, hashes,
// tokens, cookies, authorization headers and credential-looking keys are never
// copied into the audit collection.
//
// The only exception is the explicit local memory-only mode (no MongoDB in a
// non-production process, already used for degraded template mutations). There
// is no audit store to write to, so the caller is told so via the return value
// and a loud warning instead of waiting on a driver timeout. Production and
// TEMPLATE_PERSISTENCE_REQUIRED=1 always fail closed.

const SECRET_KEY = /pass(word)?|secret|token|credential|authorization|cookie|api[-_]?key|private[-_]?key|hash/i;
const SAFE_METADATA_BYTES = 8_000;

function sanitize(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("$") || key.includes(".")) continue;
      if (SECRET_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitize(child, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 500);
}

export function safeAuditMetadata(metadata) {
  const safe = sanitize(metadata ?? {});
  let json;
  try {
    json = JSON.stringify(safe);
  } catch {
    return { note: "metadata unavailable" };
  }
  if (json.length > SAFE_METADATA_BYTES) {
    return { note: "metadata omitted (too large)" };
  }
  return JSON.parse(json);
}

export async function recordAudit({
  actor,
  action,
  entityType,
  entityId,
  collegeId = null,
  metadata = {},
}) {
  if (!actor?.id) throw new Error("An authenticated actor is required for audit records.");
  if (!action || !entityType || entityId === undefined || entityId === null) {
    throw new Error("Audit records require action, entity type and entity id.");
  }
  if (mongoose.connection.readyState !== 1) {
    const required = isProduction() || process.env.TEMPLATE_PERSISTENCE_REQUIRED === "1";
    if (required) {
      throw new Error("Audit persistence is unavailable.");
    }
    console.warn(
      "[audit] MongoDB not connected — audit record NOT persisted (explicit memory-only dev mode).",
    );
    return null;
  }
  const doc = await AuditLog.create({
    actorId: String(actor.id),
    actorEmail: String(actor.email ?? "").toLowerCase().trim(),
    action: String(action).slice(0, 120),
    entityType: String(entityType).slice(0, 80),
    entityId: String(entityId).slice(0, 200),
    collegeId: collegeId == null ? null : String(collegeId).slice(0, 128),
    metadata: safeAuditMetadata(metadata),
  });
  return doc.toObject ? doc.toObject() : doc;
}

export async function auditOrRespond(res, input, fallbackMessage) {
  try {
    await recordAudit(input);
    return true;
  } catch (err) {
    console.error("[audit] failed to persist administrative action:", String(err).slice(0, 500));
    res.status(500).json({
      error:
        fallbackMessage ??
        "The change was saved, but its audit record could not be written. Please contact an administrator.",
    });
    return false;
  }
}
