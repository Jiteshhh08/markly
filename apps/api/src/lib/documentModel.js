import { z } from "zod";
import { TEMPLATE_SCOPES } from "./templateAccess.js";

// STAGE 1: canonical document/layout model.
//
// This is deliberately separate from assignmentContentSchema (schemas.js),
// which is the Qwen/Pydantic academic-content contract. The document model
// owns presentation: template snapshot, layout snapshot, ownership and
// presentation flags. It treats `content` as an opaque, already-validated
// snapshot so the AI generation contract never grows layout-only fields.
//
// Legacy records are normalized on READ. Nothing here rewrites Mongo records,
// invents a college/branch, or invents missing template formatting. Missing
// data is surfaced explicitly through the `normalization` flags.

export const DOCUMENT_SCHEMA_VERSION = 1;

const nullableString = z.string().max(128).nullable();
const templateScopeSchema = z.enum(TEMPLATE_SCOPES);

export const documentTemplateSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().min(1).nullable(),
    name: z.string().max(200).nullable().optional(),
    scope: templateScopeSchema.optional(),
    collegeId: nullableString.optional(),
    branchId: nullableString.optional(),
  })
  .strict();

const layoutValue = z.record(z.unknown()).nullable().optional();

export const documentLayoutSchema = z
  .object({
    page: layoutValue,
    typography: layoutValue,
    header: layoutValue,
    footer: layoutValue,
    watermark: layoutValue,
    facultyTable: layoutValue,
    assets: layoutValue,
    requiredSections: z.array(z.string()).optional(),
    studentMetadataFields: z.array(z.string()).optional(),
  })
  .strict();

export const documentPresentationSchema = z
  .object({
    includeVivaTitle: z.boolean(),
    typedConclusion: z.boolean(),
  })
  .strict();

export const documentNormalizationSchema = z
  .object({
    source: z.enum(["current", "legacy", "unknown"]),
    legacy: z.boolean(),
    missingContent: z.boolean(),
    missingTemplate: z.boolean(),
    missingVersion: z.boolean().optional(),
    missingLayout: z.boolean(),
    defaultsApplied: z.array(z.string()).optional(),
  })
  .strict();

export const documentSchema = z
  .object({
    schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
    assignmentId: z.string().min(1).max(128),
    ownerUserId: nullableString.optional(),
    collegeId: nullableString.optional(),
    branchId: nullableString.optional(),
    content: z.record(z.unknown()).nullable(),
    template: documentTemplateSchema.nullable(),
    layout: documentLayoutSchema.nullable(),
    presentation: documentPresentationSchema,
    normalization: documentNormalizationSchema,
  })
  .strict();

const LAYOUT_KEYS = [
  "page",
  "typography",
  "header",
  "footer",
  "watermark",
  "facultyTable",
  "assets",
  "requiredSections",
  "studentMetadataFields",
];

function own(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function pickLayout(template) {
  if (!template) return { layout: null, missingLayout: true };

  const layout = {};
  for (const key of LAYOUT_KEYS) {
    if (own(template, key) && template[key] !== undefined) layout[key] = template[key];
  }
  const hasLayout = Object.keys(layout).length > 0;
  // A template with identity only (no page/typography) has no usable layout.
  const usable = Boolean(layout.page || layout.typography);
  return { layout: hasLayout ? layout : null, missingLayout: !usable };
}

function contentSnapshot(record) {
  if (own(record, "content") && record.content !== undefined) {
    return { content: record.content ?? null, source: "current" };
  }
  if (own(record?.data, "content") && record.data.content !== undefined) {
    return { content: record.data.content ?? null, source: "current" };
  }
  if (own(record, "generatedContent") && record.generatedContent !== undefined) {
    return { content: record.generatedContent ?? null, source: "legacy" };
  }
  if (own(record?.data, "generatedContent") && record.data.generatedContent !== undefined) {
    return { content: record.data.generatedContent ?? null, source: "legacy" };
  }
  return { content: null, source: "unknown" };
}

function templateSnapshot(record, templateDoc) {
  const source = record?.template;
  if (!source || typeof source !== "object" || !source.id) {
    return { template: null, layout: null, missingTemplate: true, missingVersion: true, missingLayout: true };
  }

  const docTemplate = templateDoc?.template ?? templateDoc ?? null;
  const version = Number.isInteger(source.version) ? source.version : null;
  const sameSnapshot =
    Boolean(docTemplate) &&
    String(docTemplate.id) === String(source.id) &&
    version !== null &&
    Number(docTemplate.version) === version;

  const template = {
    id: String(source.id),
    version,
  };
  if (own(source, "name") || own(docTemplate, "name")) {
    template.name = source.name ?? docTemplate?.name ?? null;
  }
  const scope = templateScopeSchema.safeParse(source.scope).success
    ? source.scope
    : templateScopeSchema.safeParse(docTemplate?.scope).success && sameSnapshot
      ? docTemplate.scope
      : undefined;
  if (scope) template.scope = scope;

  const collegeId = source.collegeId ?? source.tenantId ?? (sameSnapshot ? docTemplate.tenantId ?? docTemplate.collegeId : null) ?? null;
  const branchId = source.branchId ?? source.departmentId ?? (sameSnapshot ? docTemplate.departmentId ?? docTemplate.branchId : null) ?? null;
  template.collegeId = collegeId;
  template.branchId = branchId;

  // Layout is only safe to attach when the snapshot identifies the exact
  // template version. Never substitute the current/latest template silently.
  const picked = sameSnapshot ? pickLayout(docTemplate) : { layout: null, missingLayout: true };
  return {
    template,
    layout: picked.layout,
    missingTemplate: false,
    missingVersion: version === null,
    missingLayout: picked.missingLayout,
  };
}

function presentationSnapshot(record) {
  const options = record?.options && typeof record.options === "object" ? record.options : null;
  const input = record?.input && typeof record.input === "object" ? record.input : null;
  const defaultsApplied = [];

  let includeVivaTitle;
  if (typeof options?.includeVivaTitle === "boolean") includeVivaTitle = options.includeVivaTitle;
  else if (typeof input?.includeVivaTitle === "boolean") includeVivaTitle = input.includeVivaTitle;
  else {
    includeVivaTitle = false;
    defaultsApplied.push("presentation.includeVivaTitle");
  }

  let typedConclusion;
  if (typeof options?.typedConclusion === "boolean") typedConclusion = options.typedConclusion;
  else if (typeof input?.typedConclusion === "boolean") typedConclusion = input.typedConclusion;
  else {
    typedConclusion = true;
    defaultsApplied.push("presentation.typedConclusion");
  }

  return {
    presentation: { includeVivaTitle, typedConclusion },
    defaultsApplied,
  };
}

/**
 * Normalize a current or legacy assignment record into the canonical document
 * shape. The input is never mutated. Missing ownership/template/layout data is
 * preserved as null + an explicit normalization flag rather than invented.
 *
 * @param {object} record assignment record (current shape or legacy Mongo doc)
 * @param {object|null} templateDoc optional { template } snapshot from the store
 */
export function normalizeDocument(record, templateDoc = null) {
  const assignmentId = String(record?.id ?? record?.recordId ?? record?.data?.id ?? "").trim();
  if (!assignmentId) throw new Error("normalizeDocument requires an assignment id");

  const content = contentSnapshot(record ?? {});
  const template = templateSnapshot(record ?? {}, templateDoc);
  const { presentation, defaultsApplied } = presentationSnapshot(record ?? {});

  const missingContent = content.content === null;
  const legacy = content.source !== "current" || template.missingTemplate || template.missingVersion || missingContent;

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    assignmentId,
    ownerUserId: record?.userId ?? record?.data?.userId ?? null,
    collegeId: record?.collegeId ?? record?.tenantId ?? null,
    branchId: record?.branchId ?? record?.departmentId ?? null,
    content: content.content,
    template: template.template,
    layout: template.layout,
    presentation,
    normalization: {
      source: content.source,
      legacy,
      missingContent,
      missingTemplate: template.missingTemplate,
      missingVersion: template.missingVersion,
      missingLayout: template.missingLayout,
      ...(defaultsApplied.length ? { defaultsApplied } : {}),
    },
  };
}

export function parseDocument(value) {
  return documentSchema.safeParse(value);
}

export function normalizeAndValidateDocument(record, templateDoc = null) {
  return documentSchema.parse(normalizeDocument(record, templateDoc));
}
