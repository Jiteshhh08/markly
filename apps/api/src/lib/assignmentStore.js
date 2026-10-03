// Shared assignment record store.
// MongoDB is the authoritative source of truth; memory is a hot cache.
// Every record carries userId ("anonymous" for logged-out/dev use); reads are
// scoped so users only ever see legacy/shared records plus their own.
// EVERY mutation path must persist (awaited) via persistWithWarning so a
// restart never silently loses committed work. When Mongo is unavailable the
// write stays memory-only and a structured DEGRADED warning is logged —
// production must never mistake memory for durability.

const store = new Map();
let counter = 0;

export function nextAssignmentId() {
  counter += 1;
  return `asg_${Date.now()}_${counter}`;
}

export function saveRecord(record) {
  store.set(record.id, record);
  return record;
}

export function getRecord(id) {
  return store.get(id) ?? null;
}

export function ownerId(req) {
  return req?.user?.sub ?? "anonymous";
}

export function canAccess(record, requesterId) {
  if (!record) return false;
  const owner = record.userId ?? record.data?.userId;
  // Pre-ownership legacy records carry no owner at all: keep them visible to
  // everyone (migration-friendly — hiding them would orphan existing history).
  if (owner === undefined) return true;
  // Explicitly anonymous records (created logged-out, or while AUTH_REQUIRED=0
  // in open dev mode): shared in open mode, but never visible to an
  // authenticated user once the API enforces auth — otherwise one user's
  // logged-out/dev records leak into every other user's board in production.
  // No records are deleted by this: anonymous callers still see them.
  if (owner === "anonymous") {
    if (process.env.AUTH_REQUIRED === "1") return (requesterId ?? "anonymous") === "anonymous";
    return true;
  }
  return owner === (requesterId ?? "anonymous");
}

// Best-effort durable write (no-op without Mongo). Fire-and-forget safe.
export async function persistRecord(record) {
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return false;
    const { Assignment } = await import("../models/index.js");
    await Assignment.updateOne(
      { recordId: record.id },
      { $set: { recordId: record.id, userId: record.userId ?? "anonymous", data: record } },
      { upsert: true },
    );
    return true;
  } catch {
    return false;
  }
}

// Durable write with explicit degraded-mode signalling. Returns true when
// Mongo acknowledged the write. When Mongo is unavailable the record stays
// memory-only and a structured DEGRADED warning is logged — callers must
// await this on every mutation instead of fire-and-forget persistRecord.
export async function persistWithWarning(record, label) {
  const ok = await persistRecord(record);
  if (!ok) {
    console.warn(
      `[api] DEGRADED: durable write failed for ${label} ${record?.id} — memory-only (a restart will lose it)`,
    );
  }
  return ok;
}

// Memory first, then Mongo (warming the cache). Null when missing OR forbidden.
export async function findRecord(id, requesterId) {
  const mem = store.get(id) ?? null;
  if (mem) return canAccess(mem, requesterId) ? mem : null;
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return null;
    const { Assignment } = await import("../models/index.js");
    const doc = await Assignment.findOne({ recordId: id }).lean();
    const record = doc?.data ?? null;
    if (!record) return null;
    if (!canAccess(record, requesterId)) return null;
    store.set(record.id, record);
    return record;
  } catch {
    return null;
  }
}

function compareNewest(a, b) {
  return String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? ""));
}

// Mongo predicate mirroring canAccess() so list queries are scoped in the
// database instead of full-scanning every assignment on each request.
// canAccess() is still re-applied in JS below as defense-in-depth.
function visibilityFilter(requesterId) {
  const legacy = { userId: { $exists: false } };
  if (!requesterId || requesterId === "anonymous") {
    return { $or: [{ userId: "anonymous" }, legacy] };
  }
  if (process.env.AUTH_REQUIRED === "1") {
    return { $or: [{ userId: requesterId }, legacy] };
  }
  return { $or: [{ userId: requesterId }, { userId: "anonymous" }, legacy] };
}

// Union of memory + Mongo visible to this requester (memory wins on conflict).
export async function listRecordsFor(requesterId) {
  const seen = new Map();
  for (const r of store.values()) {
    if (canAccess(r, requesterId)) seen.set(r.id, r);
  }
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState === 1) {
      const { Assignment } = await import("../models/index.js");
      const docs = await Assignment.find(visibilityFilter(requesterId)).lean();
      for (const d of docs) {
        const r = d?.data;
        if (r?.id && !seen.has(r.id) && canAccess(r, requesterId)) seen.set(r.id, r);
      }
    }
  } catch {
    // Memory results stand on their own.
  }
  return [...seen.values()].sort(compareNewest);
}

// Remove everywhere: memory, Mongo, and the generated PDF file (best-effort each).
export async function deleteRecord(id) {
  store.delete(id);
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState === 1) {
      const { Assignment } = await import("../models/index.js");
      await Assignment.deleteOne({ recordId: id });
    }
  } catch {
    // Non-fatal.
  }
  try {
    const { join } = await import("node:path");
    const { unlinkSync, existsSync } = await import("node:fs");
    const { assetsDir } = await import("./storage.js");
    const pdf = join(assetsDir, "generated", `assignment-${id}.pdf`);
    if (existsSync(pdf)) unlinkSync(pdf);
  } catch {
    // Non-fatal.
  }
}
