import { z } from "zod";

// Input validation (Phase 1). Aim is mandatory; everything else optional/inferred.
export const generateInputSchema = z.object({
  aim: z.string().trim().min(4).max(2000),
  description: z.string().trim().max(4000).optional().nullable(),
  subject: z.string().trim().max(64).default("DBMS"),
  experimentNumber: z.number().int().min(1).max(999).optional().nullable(),
  technology: z.string().trim().max(64).optional().nullable(),
  templateId: z.string().trim().max(64).optional().nullable(),
  // STAGE 2: pin an exact immutable template version for this generation.
  // When omitted with templateId, the latest usable version is resolved once
  // and the exact number is stored on the assignment.
  templateVersion: z.number().int().min(1).optional().nullable(),
  difficulty: z.string().trim().max(32).optional().nullable(),
  additionalInstructions: z.string().trim().max(2000).optional().nullable(),
  // Presentation flags (never affect LLM content, only rendering):
  // - includeVivaTitle: append a "Viva Questions" HEADING ONLY (faculty handwrites the Qs; never generated).
  // - typedConclusion: false renders the compulsory Conclusion heading with blank writing space instead of model text.
  includeVivaTitle: z.boolean().default(false),
  typedConclusion: z.boolean().default(true),
});

const stepSchema = z.object({
  number: z.number().int().min(1),
  title: z.string().min(2).max(200),
  description: z.array(z.string().min(4)).min(1).max(10),
  code: z.string().max(8000).nullable(),
  language: z.string().max(32).nullable(),
});

// Strict mirror of the canonical Assignment JSON (no viva questions, no extras).
export const assignmentContentSchema = z
  .object({
    experimentNumber: z.number().int().min(1).nullable(),
    title: z.string().min(4).max(200),
    aim: z.string().min(4).max(2000),
    objectives: z.array(z.string().min(4).max(500)).min(1).max(10),
    theory: z.array(z.string().min(10).max(2000)).min(1).max(20),
    steps: z.array(stepSchema).min(1).max(15),
    conclusion: z.string().min(10).max(2000),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict()
  .refine(
    (doc) => {
      const blob = [doc.title, doc.aim, ...doc.objectives, ...doc.theory, doc.conclusion]
        .join(" ")
        .toLowerCase();
      return !blob.includes("viva");
    },
    { message: "viva questions are out of scope and must not be generated" },
  )
  .refine(
    (doc) => doc.steps.every((s, i) => s.number === i + 1),
    { message: "steps must be numbered 1..n sequentially" },
  );

// Per-section value schemas for Phase 3 single-section regeneration/editing.
export const sectionValueSchemas = {
  title: z.string().min(4).max(200),
  aim: z.string().min(4).max(2000),
  objectives: z.array(z.string().min(4).max(500)).min(1).max(10),
  theory: z.array(z.string().min(10).max(2000)).min(1).max(20),
  steps: z
    .array(stepSchema)
    .min(1)
    .max(15)
    .refine((steps) => steps.every((s, i) => s.number === i + 1), {
      message: "steps must be numbered 1..n sequentially",
    }),
  conclusion: z.string().min(10).max(2000),
};

export const SECTION_NAMES = Object.keys(sectionValueSchemas);
