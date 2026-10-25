import mongoose from "mongoose";

// Multi-tenant models (Phase 1; persistence is optional until MONGODB_URI is set).
// Changing templates must never mutate historical assignments (template snapshots by reference + version).
//
// STAGE 1 (multi-college): Tenant is the college entity and Department is the
// branch entity. They are reused rather than duplicated. The additional fields
// are additive; legacy documents without them remain readable.

const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;

const userSchema = new Schema(
  {
    id: String,
    email: { type: String, index: true },
    name: String,
    passwordHash: String,
    avatarUrl: String,
    tenantIds: [String],
    // STAGE 1: roles are additive. Public registration never accepts this field.
    // Authorization always reads the persisted user, never a JWT role claim.
    role: {
      type: String,
      enum: ["user", "college_admin", "platform_admin"],
      default: "user",
      index: true,
    },
    // College ids this user may administer. Platform admins do not need entries.
    collegeAdminOf: { type: [String], default: [] },
    // STAGE 4 will expose editing; STAGE 1 only persists the shape.
    preferences: {
      collegeId: { type: String, default: null },
      departmentId: { type: String, default: null },
      preferredTemplateId: { type: String, default: null },
      updatedAt: Date,
    },
    migrationStage1: Mixed,
  },
  { timestamps: true },
);

export const User = model("User", userSchema);

const tenantSchema = new Schema(
  {
    id: { type: String, index: true, unique: true, sparse: true },
    name: String,
    slug: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    metadata: Mixed,
    migrationStage1: Mixed,
  },
  { timestamps: true },
);

export const Tenant = model("Tenant", tenantSchema);

const departmentSchema = new Schema(
  {
    id: { type: String, index: true, unique: true, sparse: true },
    tenantId: { type: String, index: true },
    name: String,
    slug: String,
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    defaultTemplateId: { type: String, default: null },
    metadata: Mixed,
    migrationStage1: Mixed,
  },
  { timestamps: true },
);

// Slugs are unique within a college when present. Legacy departments without a
// slug are intentionally not blocked by this partial index.
departmentSchema.index(
  { tenantId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: "string" } } },
);

export const Department = model("Department", departmentSchema);

const templateSchema = new Schema(
  {
    // Stable runtime id. `_id` is a Mongo implementation detail; this is the
    // id stored in assignment snapshots and used by renderers.
    id: { type: String, index: true },
    version: { type: Number, default: 1, min: 1 },
    tenantId: { type: String, index: true },
    departmentId: { type: String, index: true },
    name: String,
    // platform = global catalogue; college = shared within one college;
    // private = owner only; legacy = unknown ownership (platform-admin review).
    scope: {
      type: String,
      enum: ["platform", "college", "private", "legacy"],
      default: "legacy",
      index: true,
    },
    ownerUserId: { type: String, index: true, default: null },
    // active is the existing published state. `published` is accepted as an
    // alias so new admin code can use explicit lifecycle language.
    status: {
      type: String,
      enum: ["draft", "active", "published", "archived"],
      default: "draft",
      index: true,
    },
    page: Mixed,
    pageSettings: Mixed,
    typography: Mixed,
    requiredSections: [String],
    studentMetadataFields: [String],
    assets: Mixed,
    watermark: Mixed,
    header: Mixed,
    footer: Mixed,
    headerFooter: Mixed,
    facultyTable: Mixed,
    // Template-level limits: which layout controls users may change, which
    // elements are locked, and which block types are allowed.
    layoutPolicy: Mixed,
    seedKey: { type: String, index: true },
    isSeed: { type: Boolean, default: false },
    legacyUnscoped: { type: Boolean, default: false },
    needsReview: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    publishedAt: Date,
    archivedAt: Date,
    migrationStage1: Mixed,
  },
  // STAGE 2: templates are configuration documents whose runtime shape is
  // owned by the store/seed, not by a narrow Mongoose projection. strict:false
  // preserves every runtime field (including future additive fields) instead
  // of silently dropping it on persistence. minimize:false keeps explicit
  // empty objects so a persisted template round-trips without invented data.
  { timestamps: true, strict: false, minimize: false },
);

templateSchema.index(
  { id: 1, version: 1 },
  { unique: true, partialFilterExpression: { id: { $type: "string" } } },
);
templateSchema.index({ tenantId: 1, departmentId: 1, scope: 1, status: 1 });

export const Template = model("Template", templateSchema);

const assignmentSchema = new Schema(
  {
    userId: { type: String, index: true },
    // Full durable record (Phase 9+: the in-memory store is only a hot cache).
    recordId: { type: String, index: true, sparse: true },
    data: Mixed,
    tenantId: String,
    departmentId: String,
    subjectId: String,
    templateId: { type: String, index: true },
    templateVersion: Number,
    documentSchemaVersion: Number,
    documentRevision: Number,
    input: Mixed,
    generatedContent: Mixed,
    generationId: String,
    sources: [Mixed],
    status: { type: String, default: "completed" },
    migrationStage1: Mixed,
  },
  { timestamps: true },
);

// Actual history/catalogue query shape. Kept additive so existing docs remain valid.
assignmentSchema.index({ userId: 1, createdAt: -1 });

export const Assignment = model("Assignment", assignmentSchema);

export const Generation = model(
  "Generation",
  new Schema(
    {
      status: String,
      provider: String,
      model: String,
      promptVersion: String,
      research: Mixed,
      validation: Mixed,
      error: Mixed,
    },
    { timestamps: true },
  ),
);

export const Document = model(
  "Document",
  new Schema({ assignmentId: String, kind: String, uri: String }, { timestamps: true }),
);

export const Source = model(
  "Source",
  new Schema(
    { url: String, title: String, domain: String, retrievedAt: Date, snippet: String, relevance: Mixed },
    { timestamps: true },
  ),
);

export const PromptVersion = model(
  "PromptVersion",
  new Schema({ version: String, template: String }, { timestamps: true }),
);

// STAGE 1: append-only administrative audit trail. Metadata must never contain
// secrets, password hashes, tokens, or full private template payloads.
export const AuditLog = model(
  "AuditLog",
  new Schema(
    {
      actorId: { type: String, index: true },
      actorEmail: String,
      action: { type: String, index: true },
      entityType: { type: String, index: true },
      entityId: { type: String, index: true },
      collegeId: { type: String, index: true },
      metadata: Mixed,
    },
    { timestamps: true },
  ),
);
