import mongoose from "mongoose";

// Multi-tenant models (scaffold for Phase 1; persistence is optional until MONGODB_URI is set).
// Changing templates must never mutate historical assignments (template snapshots by reference + version).

const { Schema, model } = mongoose;

export const User = model(
  "User",
  // STAGE 4: id/passwordHash/avatarUrl are additive. Pre-existing User docs
  // without a passwordHash cannot satisfy bcrypt login after a restart —
  // those accounts must re-register (documented limitation, not a migration).
  // No unique index is added here: failing boot on duplicate legacy emails
  // would be worse than the application-level duplicate check in registerUser.
  new Schema(
    { id: String, email: String, name: String, passwordHash: String, avatarUrl: String, tenantIds: [String] },
    { timestamps: true },
  ),
);

export const Tenant = model(
  "Tenant",
  new Schema({ name: String, slug: { type: String, unique: true, sparse: true } }, { timestamps: true }),
);

export const Department = model(
  "Department",
  new Schema({ tenantId: String, name: String }, { timestamps: true }),
);

export const Subject = model(
  "Subject",
  new Schema(
    {
      tenantId: String,
      departmentId: String,
      name: String,
      profile: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true },
  ),
);

export const Template = model(
  "Template",
  new Schema(
    {
      tenantId: String,
      departmentId: String,
      name: String,
      version: { type: Number, default: 1 },
      pageSettings: Schema.Types.Mixed,
      typography: Schema.Types.Mixed,
      requiredSections: [String],
      studentMetadataFields: [String],
      assets: Schema.Types.Mixed,
      watermark: Schema.Types.Mixed,
      headerFooter: Schema.Types.Mixed,
      facultyTable: Schema.Types.Mixed,
      status: { type: String, default: "draft" },
    },
    { timestamps: true },
  ),
);

export const Assignment = model(
  "Assignment",
  new Schema(
    {
      userId: String,
      // Full durable record (Phase 9+: the in-memory store is only a hot cache).
      recordId: { type: String, index: true, sparse: true },
      data: Schema.Types.Mixed,
      tenantId: String,
      departmentId: String,
      subjectId: String,
      templateId: String,
      templateVersion: Number,
      input: Schema.Types.Mixed,
      generatedContent: Schema.Types.Mixed,
      generationId: String,
      sources: [Schema.Types.Mixed],
      status: { type: String, default: "completed" },
    },
    { timestamps: true },
  ),
);

export const Generation = model(
  "Generation",
  new Schema(
    {
      status: String,
      provider: String,
      model: String,
      promptVersion: String,
      research: Schema.Types.Mixed,
      validation: Schema.Types.Mixed,
      error: Schema.Types.Mixed,
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
    { url: String, title: String, domain: String, retrievedAt: Date, snippet: String, relevance: Schema.Types.Mixed },
    { timestamps: true },
  ),
);

export const PromptVersion = model(
  "PromptVersion",
  new Schema({ version: String, template: String }, { timestamps: true }),
);
