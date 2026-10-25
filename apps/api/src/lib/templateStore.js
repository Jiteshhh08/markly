import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Template } from "../models/index.js";
import { isProduction } from "./cors.js";
import {
  TEMPLATE_SCOPE_LEGACY,
  isArchivedTemplate,
  isLegacyTemplate,
  isPrivateTemplate,
  isPublishedTemplate,
  templateScope,
} from "./templateAccess.js";
import { loadTemplates } from "./templates.js";

// STAGE 2: MongoDB-authoritative versioned template store.
//
// The in-memory maps are a hot cache. They are hydrated from MongoDB once a
// connection is available; persisted documents always win over the built-in
// JSON seed for the same { id, version }. Every production mutation writes the
// new immutable version to MongoDB BEFORE the cache is updated or the request
// is acknowledged. There is no fire-and-forget persistence path.
//
// The synchronous helpers (createTemplate/updateTemplate) are retained for
// existing tests, local tooling and in-memory development. Route code uses the
// *Persisted variants so a successful response means the version is durable.
//
// Identity is the stable `id`; every edit creates a new immutable `version`.
// Renaming never changes the id, and ids include random entropy so identical
// names in different colleges can never collide.

const versions = new Map(); // `${id}@${version}` -> template object
const latest = new Map(); // id -> highest version number
const seedKeys = new Map(); // `${id}@${version}` -> id loaded from the JSON seed

let seededFromFiles = false;
let hydratedFromMongo = false;
let hydratePromise = null;
let degradedWarned = false;

export class TemplateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateConflictError";
    this.status = 409;
  }
}

export class TemplatePersistenceError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "TemplatePersistenceError";
    this.status = 503;
  }
}

function key(id, version) {
  return `${id}@${version}`;
}

function normalizeVersion(value) {
  const n = Number(value ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

// MongoDB rejects field names starting with `$`. The JSON seed carries
// `$comment` metadata that is documentation, not runtime configuration. Strip
// it (recursively) before persistence without inventing any missing fields.
function stripMongoUnsafeKeys(value) {
  if (Array.isArray(value)) return value.map(stripMongoUnsafeKeys);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey.startsWith("$")) continue;
    out[childKey] = stripMongoUnsafeKeys(child);
  }
  return out;
}

function fromMongoDoc(doc) {
  const out = { ...doc };
  delete out._id;
  delete out.__v;
  delete out.createdAt;
  delete out.updatedAt;
  return stripMongoUnsafeKeys(out);
}

function seedFromFiles() {
  if (seededFromFiles) return;
  seededFromFiles = true;
  for (const doc of loadTemplates()) {
    const source = doc?.template;
    if (!source?.id) continue;
    const version = normalizeVersion(source.version);
    if (!version) continue;
    const template = { ...stripMongoUnsafeKeys(source), id: String(source.id), version };
    const templateKey = key(template.id, version);
    seedKeys.set(templateKey, template.id);
    if (!versions.has(templateKey)) {
      versions.set(templateKey, template);
      latest.set(template.id, Math.max(latest.get(template.id) ?? 0, version));
    }
  }
}

function recomputeLatest(id) {
  let highest = 0;
  const prefix = `${id}@`;
  for (const templateKey of versions.keys()) {
    if (!templateKey.startsWith(prefix)) continue;
    const version = Number(templateKey.slice(prefix.length));
    if (Number.isInteger(version) && version > highest) highest = version;
  }
  if (highest > 0) latest.set(id, highest);
  else latest.delete(id);
}

function commit(template) {
  versions.set(key(template.id, template.version), template);
  latest.set(template.id, Math.max(latest.get(template.id) ?? 0, template.version));
}

function rawLatest(id) {
  seedFromFiles();
  const version = latest.get(String(id));
  return version == null ? null : versions.get(key(String(id), version)) ?? null;
}

function assertNewIdentity(id) {
  if (latest.has(id)) {
    throw new TemplateConflictError(
      `Template "${id}" already exists (update it for a new version)`,
    );
  }
}

function slugify(name) {
  return (
    String(name ?? "template")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40) || "template"
  );
}

function newTemplateId(name) {
  // Random suffix, not a timestamp: two same-named templates created in the
  // same millisecond (including in different colleges) must never collide.
  return `${slugify(name)}-${randomUUID().slice(0, 8)}`;
}

function buildTemplate(data = {}) {
  const source = stripMongoUnsafeKeys(data ?? {});
  const id = source.id != null ? String(source.id) : newTemplateId(source.name);
  const template = {
    status: "draft",
    scope: TEMPLATE_SCOPE_LEGACY,
    requiredSections: ["title", "aim", "objectives", "theory", "steps", "conclusion"],
    page: {
      size: "A4",
      margin: { top: "110px", right: "18mm", bottom: "20mm", left: "18mm" },
    },
    typography: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      baseSize: "12pt",
      lineHeight: 1.6,
    },
    header: { image: null, everyPage: true },
    watermark: { image: null, everyPage: true },
    footer: { text: "", showPageNumber: true },
    facultyTable: null,
    ...source,
    id,
    version: 1,
  };
  return clone(template);
}

function buildNextVersion(current, patch = {}) {
  const safePatch = stripMongoUnsafeKeys(patch ?? {});
  const next = {
    ...clone(current),
    ...safePatch,
    id: current.id,
    version: current.version + 1,
  };
  delete next.seedImmutable;
  return clone(next);
}

export async function hydrateTemplatesFromMongo({ force = false } = {}) {
  seedFromFiles();
  if (mongoose.connection.readyState !== 1) {
    return { hydrated: false, count: 0 };
  }
  if (hydratedFromMongo && !force) {
    return { hydrated: true, count: versions.size };
  }

  const docs = await Template.find({}).lean();
  const persistedIds = new Set(
    docs.map((doc) => (doc?.id == null ? null : String(doc.id))).filter(Boolean),
  );

  // MongoDB is authoritative for every template id it contains. Built-in seed
  // versions for that id are only a fallback for ids that do NOT exist in the
  // database; otherwise a deleted/missing version could silently reappear and
  // break exact-version rendering.
  const affectedIds = new Set();
  for (const [templateKey, id] of seedKeys.entries()) {
    if (!persistedIds.has(id)) continue;
    versions.delete(templateKey);
    seedKeys.delete(templateKey);
    affectedIds.add(id);
  }
  for (const id of affectedIds) recomputeLatest(id);

  let count = 0;
  for (const doc of docs) {
    const template = fromMongoDoc(doc);
    if (!template?.id) continue;
    const version = normalizeVersion(template.version);
    if (!version) continue;
    template.id = String(template.id);
    template.version = version;
    versions.set(key(template.id, version), template);
    latest.set(template.id, Math.max(latest.get(template.id) ?? 0, version));
    count += 1;
  }
  hydratedFromMongo = true;
  return { hydrated: true, count };
}

/**
 * Ensure the cache contains persisted templates before a read/mutation.
 * The JSON seed is always available as a built-in fallback; once a Mongo
 * connection exists the persisted documents are loaded and override matching
 * seed versions.
 */
export async function ensureTemplatesLoaded() {
  seedFromFiles();
  if (hydratedFromMongo) return;
  if (mongoose.connection.readyState !== 1) return;

  if (!hydratePromise) {
    hydratePromise = hydrateTemplatesFromMongo().finally(() => {
      hydratePromise = null;
    });
  }
  await hydratePromise;
}

export function listTemplates() {
  seedFromFiles();
  const out = [];
  for (const [id, version] of latest.entries()) {
    const template = versions.get(key(id, version));
    if (template) out.push(clone(template));
  }
  return out;
}

export function getTemplateVersion(id, version) {
  seedFromFiles();
  const templateId = String(id ?? "");
  if (!templateId) return null;
  if (version == null) {
    const highest = latest.get(templateId);
    return highest == null ? null : clone(versions.get(key(templateId, highest)) ?? null);
  }
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  return clone(versions.get(key(templateId, normalized)) ?? null);
}

// Renderer-compatible doc shape { template }.
export function getTemplateDoc(id, version) {
  const template = getTemplateVersion(id, version);
  return template ? { template } : null;
}

export function selectDefaultTemplate() {
  seedFromFiles();
  const all = listTemplates().filter(
    (template) =>
      !isPrivateTemplate(template) &&
      !isLegacyTemplate(template) &&
      !isArchivedTemplate(template) &&
      isPublishedTemplate(template),
  );
  const rank = (template) => {
    const scope = templateScope(template);
    if (scope === "platform") return 0;
    if (scope === "college") return 1;
    return 2;
  };
  all.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(a.id).localeCompare(String(b.id)) ||
      Number(a.version) - Number(b.version),
  );
  return all[0] ?? null;
}

export function getDefaultTemplateDoc() {
  return { template: selectDefaultTemplate() };
}

// Synchronous, memory-only mutation helpers. Retained for existing tests and
// tooling; request routes must use the persisted variants below.
export function createTemplate(data) {
  seedFromFiles();
  const template = buildTemplate(data);
  assertNewIdentity(template.id);
  commit(template);
  return clone(template);
}

export function updateTemplate(id, patch) {
  seedFromFiles();
  const current = rawLatest(id);
  if (!current) return null;
  const next = buildNextVersion(current, patch);
  commit(next);
  return clone(next);
}

function persistenceAvailable() {
  return mongoose.connection.readyState === 1;
}

function persistenceRequired() {
  return isProduction() || process.env.TEMPLATE_PERSISTENCE_REQUIRED === "1";
}

function assertPersistencePolicy() {
  if (persistenceAvailable()) return true;
  if (persistenceRequired()) {
    throw new TemplatePersistenceError(
      "Template storage is unavailable. Please try again.",
    );
  }
  if (!degradedWarned) {
    degradedWarned = true;
    console.warn(
      "[templates] MongoDB not connected — template mutations are MEMORY-ONLY (degraded mode).",
    );
  }
  return false;
}

function isDuplicateKey(err) {
  return (
    err?.code === 11000 ||
    err?.code === 11001 ||
    String(err?.message ?? "").includes("E11000")
  );
}

async function persistNewVersion(template, priorVersions = []) {
  if (!assertPersistencePolicy()) return false;
  try {
    // If a synchronous/in-memory caller created earlier versions, make sure
    // history exists before writing the next immutable version. $setOnInsert
    // never overwrites a durable document.
    for (const prior of priorVersions) {
      await Template.updateOne(
        { id: prior.id, version: prior.version },
        { $setOnInsert: stripMongoUnsafeKeys(prior) },
        { upsert: true },
      );
    }
    await Template.create(stripMongoUnsafeKeys(template));
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new TemplateConflictError(
        `Template "${template.id}" version ${template.version} already exists`,
      );
    }
    throw new TemplatePersistenceError(
      "Template storage is unavailable. Please try again.",
      err,
    );
  }
}

export async function createTemplatePersisted(data) {
  await ensureTemplatesLoaded();
  const template = buildTemplate(data);
  assertNewIdentity(template.id);
  await persistNewVersion(template);
  commit(template);
  return clone(template);
}

export async function updateTemplatePersisted(id, patch) {
  await ensureTemplatesLoaded();
  const current = rawLatest(id);
  if (!current) return null;

  const next = buildNextVersion(current, patch);
  const history = [];
  for (let version = 1; version <= current.version; version += 1) {
    const prior = versions.get(key(current.id, version));
    if (prior) history.push(prior);
  }

  await persistNewVersion(next, history);
  commit(next);
  return clone(next);
}
