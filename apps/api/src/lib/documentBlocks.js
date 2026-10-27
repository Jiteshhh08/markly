import { z } from "zod";

// STAGE 5: editable document blocks.
//
// The academic content in `assignment.content` stays the AI/section-
// regeneration contract. This module owns the editable presentation body:
// a flat, ordered list of validated blocks. It deliberately has no absolute
// positioning or arbitrary HTML: every block can be represented by the Stage 6
// HTML, DOCX and LaTeX renderers.

export const DOCUMENT_SCHEMA_VERSION = 2;

export const DOCUMENT_BLOCK_TYPES = Object.freeze([
  "title",
  "experimentNumber",
  "heading",
  "subheading",
  "paragraph",
  "bulletList",
  "numberedList",
  "code",
  "spacer",
  "pageBreak",
]);

export const DOCUMENT_ALIGNMENTS = Object.freeze(["left", "center", "right", "justify"]);

export const DOCUMENT_SOURCE_SECTIONS = Object.freeze([
  "title",
  "experimentNumber",
  "aim",
  "objectives",
  "theory",
  "steps",
  "conclusion",
]);

const idSchema = z.string().trim().min(1).max(128);
const text = (max) => z.string().max(max);

const styleSchema = z
  .object({
    align: z.enum(DOCUMENT_ALIGNMENTS).optional(),
    fontSize: z.number().int().min(8).max(48).optional(),
    lineHeight: z.number().min(0.8).max(3).optional(),
    spacingBefore: z.number().int().min(0).max(120).optional(),
    spacingAfter: z.number().int().min(0).max(120).optional(),
    indent: z.number().int().min(0).max(120).optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    section: z.enum(DOCUMENT_SOURCE_SECTIONS).optional(),
    stepNumber: z.number().int().min(1).max(999).optional(),
  })
  .strict();

const titleContent = z.object({ text: text(300) }).strict();
const experimentContent = z.object({ text: text(120) }).strict();
const headingContent = z.object({ text: text(300) }).strict();
const paragraphContent = z.object({ text: text(20000) }).strict();
const listContent = z.object({ items: z.array(text(2000)).max(100) }).strict();
const codeContent = z
  .object({
    text: text(50000),
    language: z.string().max(32).nullable().optional(),
  })
  .strict();
const spacerContent = z
  .object({ height: z.number().int().min(8).max(240).optional() })
  .strict();
const pageBreakContent = z.object({}).strict();

function blockSchema(type, content) {
  return z
    .object({
      id: idSchema,
      type: z.literal(type),
      content,
      style: styleSchema.optional(),
      source: sourceSchema.optional(),
    })
    .strict();
}

export const documentBlockSchema = z.discriminatedUnion("type", [
  blockSchema("title", titleContent),
  blockSchema("experimentNumber", experimentContent),
  blockSchema("heading", headingContent),
  blockSchema("subheading", headingContent),
  blockSchema("paragraph", paragraphContent),
  blockSchema("bulletList", listContent),
  blockSchema("numberedList", listContent),
  blockSchema("code", codeContent),
  blockSchema("spacer", spacerContent),
  blockSchema("pageBreak", pageBreakContent),
]);

export const documentBlocksSchema = z
  .array(documentBlockSchema)
  .max(500)
  .superRefine((blocks, ctx) => {
    const seen = new Set();
    blocks.forEach((block, index) => {
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `duplicate block id: ${block.id}`,
        });
      }
      seen.add(block.id);
    });
  });

export const documentSaveSchema = z
  .object({
    revision: z.number().int().min(0),
    schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION).optional(),
    blocks: documentBlocksSchema,
  })
  .strict();

export function currentDocumentRevision(record) {
  const stored = record?.document;
  if (Number.isInteger(stored?.revision) && stored.revision >= 0) return stored.revision;
  if (Number.isInteger(record?.documentRevision) && record.documentRevision >= 0) {
    return record.documentRevision;
  }
  return 0;
}

export function storedDocumentBlocks(record) {
  const blocks = record?.document?.blocks;
  if (!Array.isArray(blocks)) return null;
  const parsed = documentBlocksSchema.safeParse(blocks);
  return parsed.success ? parsed.data : null;
}

function safeText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function source(section, stepNumber) {
  return stepNumber == null ? { section } : { section, stepNumber };
}

function textBlock(id, type, value, section, extra = {}) {
  const valueText = safeText(value);
  if (!valueText.trim()) return null;
  return {
    id,
    type,
    content: { text: valueText },
    source: source(section),
    ...extra,
  };
}

function listBlock(id, type, items, section, stepNumber) {
  const values = Array.isArray(items) ? items.map(safeText) : [];
  if (!values.length) return null;
  return {
    id,
    type,
    content: { items: values },
    source: source(section, stepNumber),
  };
}

function codeBlock(id, value, language, section, stepNumber) {
  const valueText = safeText(value);
  if (!valueText) return null;
  return {
    id,
    type: "code",
    content: { text: valueText, language: language ? safeText(language) : null },
    source: source(section, stepNumber),
  };
}

/**
 * Deterministically convert legacy academic content into editable blocks.
 * This is a READ projection: callers must not persist it just because a legacy
 * assignment was opened. Every generated block carries source metadata so a
 * later section regeneration can replace only its own section.
 */
export function blocksFromContent(content) {
  if (!content || typeof content !== "object") return [];
  const blocks = [];
  const push = (value) => {
    if (value) blocks.push(value);
  };

  push(textBlock("legacy-title", "title", content.title, "title"));
  if (content.experimentNumber != null && content.experimentNumber !== "") {
    push(
      textBlock(
        "legacy-experiment-number",
        "experimentNumber",
        `Experiment No. ${safeText(content.experimentNumber)}`,
        "experimentNumber",
      ),
    );
  }

  if (safeText(content.aim).trim()) {
    push({
      id: "legacy-aim-heading",
      type: "heading",
      content: { text: "Aim" },
      source: source("aim"),
    });
    push(textBlock("legacy-aim", "paragraph", content.aim, "aim"));
  }

  if (Array.isArray(content.objectives) && content.objectives.length) {
    push({
      id: "legacy-objectives-heading",
      type: "heading",
      content: { text: "Objectives" },
      source: source("objectives"),
    });
    push(listBlock("legacy-objectives", "bulletList", content.objectives, "objectives"));
  }

  if (Array.isArray(content.theory) && content.theory.length) {
    push({
      id: "legacy-theory-heading",
      type: "heading",
      content: { text: "Theory" },
      source: source("theory"),
    });
    content.theory.forEach((paragraph, index) => {
      push(
        textBlock(
          `legacy-theory-${index + 1}`,
          "paragraph",
          paragraph,
          "theory",
        ),
      );
    });
  }

  if (Array.isArray(content.steps) && content.steps.length) {
    push({
      id: "legacy-steps-heading",
      type: "heading",
      content: { text: "Steps" },
      source: source("steps"),
    });
    content.steps.forEach((step, index) => {
      const number = Number.isInteger(step?.number) ? step.number : index + 1;
      push({
        id: `legacy-step-${number}-heading`,
        type: "subheading",
        content: { text: `Step ${number}: ${safeText(step?.title)}` },
        source: source("steps", number),
      });
      push(
        listBlock(
          `legacy-step-${number}-description`,
          "bulletList",
          step?.description,
          "steps",
          number,
        ),
      );
      push(
        codeBlock(
          `legacy-step-${number}-code`,
          step?.code,
          step?.language,
          "steps",
          number,
        ),
      );
    });
  }

  if (safeText(content.conclusion).trim()) {
    push({
      id: "legacy-conclusion-heading",
      type: "heading",
      content: { text: "Conclusion" },
      source: source("conclusion"),
    });
    push(textBlock("legacy-conclusion", "paragraph", content.conclusion, "conclusion"));
  }

  return blocks;
}

/**
 * Build the generated block set for one academic section. Regeneration uses
 * this to replace only blocks whose `source.section` matches.
 */
export function blocksForSection(section, value) {
  const blocks = [];
  const push = (item) => {
    if (item) blocks.push(item);
  };

  if (section === "title") {
    push(textBlock("gen-title", "title", value, "title"));
  } else if (section === "experimentNumber") {
    if (value != null && value !== "") {
      push(
        textBlock(
          "gen-experiment-number",
          "experimentNumber",
          `Experiment No. ${safeText(value)}`,
          "experimentNumber",
        ),
      );
    }
  } else if (section === "aim") {
    push({
      id: "gen-aim-heading",
      type: "heading",
      content: { text: "Aim" },
      source: source("aim"),
    });
    push(textBlock("gen-aim", "paragraph", value, "aim"));
  } else if (section === "objectives") {
    push({
      id: "gen-objectives-heading",
      type: "heading",
      content: { text: "Objectives" },
      source: source("objectives"),
    });
    push(listBlock("gen-objectives", "bulletList", value, "objectives"));
  } else if (section === "theory") {
    push({
      id: "gen-theory-heading",
      type: "heading",
      content: { text: "Theory" },
      source: source("theory"),
    });
    (Array.isArray(value) ? value : []).forEach((paragraph, index) => {
      push(textBlock(`gen-theory-${index + 1}`, "paragraph", paragraph, "theory"));
    });
  } else if (section === "steps") {
    push({
      id: "gen-steps-heading",
      type: "heading",
      content: { text: "Steps" },
      source: source("steps"),
    });
    (Array.isArray(value) ? value : []).forEach((step, index) => {
      const number = Number.isInteger(step?.number) ? step.number : index + 1;
      push({
        id: `gen-step-${number}-heading`,
        type: "subheading",
        content: { text: `Step ${number}: ${safeText(step?.title)}` },
        source: source("steps", number),
      });
      push(
        listBlock(
          `gen-step-${number}-description`,
          "bulletList",
          step?.description,
          "steps",
          number,
        ),
      );
      push(
        codeBlock(
          `gen-step-${number}-code`,
          step?.code,
          step?.language,
          "steps",
          number,
        ),
      );
    });
  } else if (section === "conclusion") {
    push({
      id: "gen-conclusion-heading",
      type: "heading",
      content: { text: "Conclusion" },
      source: source("conclusion"),
    });
    push(textBlock("gen-conclusion", "paragraph", value, "conclusion"));
  }

  return blocks;
}

/**
 * Replace only blocks belonging to `section`, keeping every unrelated manual
 * block (and its style/order) intact. The replacement is inserted where the
 * section's first block used to be; if the section was absent it is appended.
 */
export function replaceSectionBlocks(blocks, section, replacement) {
  const current = Array.isArray(blocks) ? blocks : [];
  const replacementBlocks = Array.isArray(replacement) ? replacement : [];
  const firstIndex = current.findIndex((block) => block?.source?.section === section);
  const remaining = current.filter((block) => block?.source?.section !== section);
  if (firstIndex < 0) return [...remaining, ...replacementBlocks];
  const insertion = Math.min(firstIndex, remaining.length);
  remaining.splice(insertion, 0, ...replacementBlocks);
  return remaining;
}

/**
 * Keep the saved document blocks consistent with an explicit academic-content
 * save (the existing section editor). Only sections whose content changed are
 * regenerated; manual blocks and unrelated sections stay exactly as they were.
 */
export function syncDocumentBlocksForContent(record, previousContent, nextContent) {
  const stored = storedDocumentBlocks(record);
  if (!stored) return null;
  let blocks = stored;
  let changed = false;
  for (const section of DOCUMENT_SOURCE_SECTIONS) {
    const previousValue = previousContent?.[section];
    const nextValue = nextContent?.[section];
    if (JSON.stringify(previousValue) === JSON.stringify(nextValue)) continue;
    blocks = replaceSectionBlocks(blocks, section, blocksForSection(section, nextValue));
    changed = true;
  }
  return changed ? blocks : null;
}

/**
 * Return a new assignment record with a persisted document revision. The
 * original record is never mutated; callers only save after the durable write
 * succeeds.
 */
export function withDocumentBlocks(record, blocks, { revision, updatedAt } = {}) {
  const parsed = documentBlocksSchema.parse(blocks);
  const now = updatedAt ?? new Date().toISOString();
  const nextRevision =
    Number.isInteger(revision) && revision >= 0 ? revision : currentDocumentRevision(record) + 1;
  return {
    ...record,
    document: {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      revision: nextRevision,
      blocks: parsed,
      updatedAt: now,
    },
    documentSchemaVersion: DOCUMENT_SCHEMA_VERSION,
    documentRevision: nextRevision,
    updatedAt: now,
  };
}
