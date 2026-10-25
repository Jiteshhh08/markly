import { Router } from "express";
import { SECTION_NAMES, assignmentContentSchema, generateInputSchema, sectionValueSchemas } from "../schemas.js";
import { generateViaAiService, regenerateSectionViaAiService } from "../lib/aiClient.js";
import { getSubjectProfile } from "../lib/subjects.js";
import {
  TemplateResolutionError,
  requestActor,
  resolveAssignmentTemplate,
  resolveTemplateForGeneration,
} from "../lib/templateResolution.js";
import { findRecord, listRecordsFor, nextAssignmentId, ownerId, persistWithWarning, saveRecord } from "../lib/assignmentStore.js";
import {
  currentDocumentRevision,
  documentSaveSchema,
  syncDocumentBlocksForContent,
  withDocumentBlocks,
} from "../lib/documentBlocks.js";
import { normalizeAndValidateDocument } from "../lib/documentModel.js";
import { renderHtml } from "../render/html.js";
import { sendError } from "../lib/errors.js";

export const assignmentsRouter = Router();

// STAGE 5: serialize document saves per assignment. Revision checks make a
// stale client fail with 409; this lock also closes the small in-process race
// where two simultaneous requests could both read the same revision before
// either committed.
const documentSaveQueues = new Map();

async function withDocumentSaveLock(assignmentId, task) {
  const previous = documentSaveQueues.get(assignmentId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  documentSaveQueues.set(assignmentId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (documentSaveQueues.get(assignmentId) === queued) {
      documentSaveQueues.delete(assignmentId);
    }
  }
}

// Resolve the exact immutable template version stored on an assignment.
// Missing identity/version or a deleted historical version is an explicit
// error; exports never fall back to the latest or a server default.
async function exactTemplateFor(record, res) {
  try {
    return await resolveAssignmentTemplate(record);
  } catch (err) {
    if (err instanceof TemplateResolutionError) {
      sendError(res, err.status, err.message);
      return null;
    }
    sendError(res, 503, "Template resolution is unavailable. Please try again.", err);
    return null;
  }
}

// Records live in the shared assignment store (Mongo persistence is best-effort; see index.js).

/**
 * POST /api/v1/assignments/generate
 * Body: { aim*, description?, subject?, experimentNumber?, technology?, difficulty?, ... }
 * Flow: validate -> subject profile lookup -> tenant template lookup -> AI service -> validate -> return.
 */
assignmentsRouter.post("/generate", async (req, res) => {
  const parsed = generateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid input", parsed.error.flatten());
  }
  const input = parsed.data;
  const profile = getSubjectProfile(input.subject);
  // Presentation flags stay Node-side (rendering only); the AI service gets content input alone.
  const { includeVivaTitle, typedConclusion, ...aiInput } = input;
  const options = { includeVivaTitle: includeVivaTitle ?? false, typedConclusion: typedConclusion ?? true };

  if (input.templateVersion != null && !input.templateId) {
    return sendError(res, 400, "templateVersion requires templateId");
  }

  // Resolve and pin the exact template version BEFORE calling the AI service.
  // An explicit templateId never falls back to a default or another college.
  let resolvedTemplate;
  try {
    const actor = await requestActor(req);
    resolvedTemplate = await resolveTemplateForGeneration({
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      actor,
    });
  } catch (err) {
    if (err instanceof TemplateResolutionError) {
      return sendError(res, err.status, err.message);
    }
    return sendError(res, 503, "Template resolution is unavailable. Please try again.", err);
  }
  const template = resolvedTemplate.snapshot;

  const aiBase = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8001";
  try {
    const result = await generateViaAiService(aiInput, aiBase);
    const content = assignmentContentSchema.safeParse(result.content);
    if (!content.success) {
      return sendError(res, 502, "AI service returned invalid Assignment JSON", content.error.flatten());
    }
    const id = nextAssignmentId();
    const record = {
      id,
      status: "completed",
      userId: ownerId(req),
      input,
      subjectProfile: profile,
      template,
      options,
      content: content.data,
      sources: result.sources ?? [],
      provenance: {
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        validation: result.validation,
        researchProvider: result.researchProvider ?? "none",
      },
      createdAt: new Date().toISOString(),
    };
    saveRecord(record);
    // Authoritative durable write (awaited): the response commits only after
    // Mongo acknowledges it. Degraded mode is logged, never silent.
    await persistWithWarning(record, "assignment");

    return res.json(record);
  } catch (err) {
    console.error(`[api] generation failed for aim "${input.aim.slice(0, 80)}":`, String(err));
    return sendError(res, 502, "Generation failed");
  }
});

// Phase 9: generation history (durable + scoped to the requester).
// Summaries carry enough for correct cards (title/aim/subject/tech/exp);
// the drawer lazy-loads the full record (with content) on open.
assignmentsRouter.get("/", async (_req, res) => {
  const items = (await listRecordsFor(ownerId(_req))).map((r) => ({
    id: r.id,
    status: r.status,
    title: r.content?.title,
    aim: r.content?.aim,
    subject: r.input?.subject ?? "DBMS",
    technology: r.input?.technology ?? "",
    experimentNumber: r.content?.experimentNumber ?? null,
    template: r.template,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  res.json({ assignments: items });
});

assignmentsRouter.get("/:id", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  return res.json(record);
});

// STAGE 5: fetch the editable canonical document. Legacy assignments are
// projected into blocks on READ; this route never writes them back.
assignmentsRouter.get("/:id/document", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  try {
    return res.json({ document: normalizeAndValidateDocument(record) });
  } catch (err) {
    return sendError(res, 500, "The document could not be read. Please try again.", err);
  }
});

// STAGE 5: save the editable body with optimistic concurrency. Only the
// revision + blocks are accepted; template identity, ownership, content and
// presentation metadata remain server-owned and cannot be overwritten here.
assignmentsRouter.put("/:id/document", async (req, res) => {
  const parsed = documentSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid document", parsed.error.flatten());
  }

  return withDocumentSaveLock(req.params.id, async () => {
    const record = await findRecord(req.params.id, ownerId(req));
    if (!record) return res.status(404).json({ error: "Not found" });

    const revision = currentDocumentRevision(record);
    if (parsed.data.revision !== revision) {
      return res.status(409).json({
        error: "This document changed since you opened it. Reload the latest version and reapply your edits.",
        code: "document_conflict",
        revision,
      });
    }

    const updated = withDocumentBlocks(record, parsed.data.blocks, {
      revision: revision + 1,
    });
    // Durable write first: a failed write must never look like a successful
    // save, and the previous document stays intact in memory and Mongo.
    const persisted = await persistWithWarning(updated, "assignment document update");
    if (!persisted) {
      return sendError(
        res,
        503,
        "The document could not be saved. Your edits are still in this editor; try again when the service is available.",
      );
    }
    saveRecord(updated);
    return res.json({ document: normalizeAndValidateDocument(updated) });
  });
});

// Delete a record everywhere it lives (memory, Mongo, generated PDF).
assignmentsRouter.delete("/:id", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  try {
    const { deleteRecord } = await import("../lib/assignmentStore.js");
    await deleteRecord(record.id);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, 502, "Delete failed", String(err).slice(0, 300));
  }
});

// Phase 2: printable HTML document (header + 50% watermark on every page).
assignmentsRouter.get("/:id/html", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const resolved = await exactTemplateFor(record, res);
  if (!resolved) return undefined;
  return res.type("html").send(renderHtml(record.content, resolved.doc, record.options));
});

// Presentation options can change after generation (viva heading, typed/handwritten conclusion).
assignmentsRouter.patch("/:id/options", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const { includeVivaTitle, typedConclusion } = req.body ?? {};
  if (includeVivaTitle !== undefined && typeof includeVivaTitle !== "boolean") {
    return res.status(400).json({ error: "includeVivaTitle must be a boolean" });
  }
  if (typedConclusion !== undefined && typeof typedConclusion !== "boolean") {
    return res.status(400).json({ error: "typedConclusion must be a boolean" });
  }
  record.options = {
    includeVivaTitle: includeVivaTitle ?? record.options?.includeVivaTitle ?? false,
    typedConclusion: typedConclusion ?? record.options?.typedConclusion ?? true,
  };
  record.updatedAt = new Date().toISOString();
  saveRecord(record);
  await persistWithWarning(record, "assignment options update");
  return res.json(record);
});

// Phase 3: regenerate one section; everything else stays untouched.
assignmentsRouter.post("/:id/regenerate-section", async (req, res) => {
  let record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const section = req.body?.section;
  if (!SECTION_NAMES.includes(section)) {
    return res.status(400).json({ error: `Invalid section (one of ${SECTION_NAMES.join(", ")})` });
  }
  const aiBase = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8001";
  try {
    const result = await regenerateSectionViaAiService(
      {
        section,
        aim: record.content.aim,
        subject: record.input?.subject ?? "DBMS",
        current: record.content,
        additionalInstructions: req.body?.additionalInstructions ?? null,
      },
      aiBase,
    );
    const value = sectionValueSchemas[section].safeParse(result.value);
    if (!value.success) {
      return sendError(res, 502, "Invalid regenerated section", value.error.flatten());
    }
    const previousContent = record.content;
    record.content = { ...record.content, [section]: value.data };
    // STAGE 5: if this assignment has a saved editable body, replace only the
    // blocks sourced from this section. Manual blocks, styles and ordering of
    // every unrelated section stay untouched.
    const nextBlocks = syncDocumentBlocksForContent(record, previousContent, record.content);
    if (nextBlocks) {
      record = withDocumentBlocks(record, nextBlocks);
    } else {
      record.updatedAt = new Date().toISOString();
    }
    saveRecord(record);
    await persistWithWarning(record, "assignment section regeneration");
    return res.json(record);
  } catch (err) {
    console.error(`[api] section regeneration failed for ${record.id}:`, String(err));
    return sendError(res, 502, "Regeneration failed");
  }
});

// Phase 3: save user-edited content (full re-validation).
assignmentsRouter.put("/:id", async (req, res) => {
  let record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const parsed = assignmentContentSchema.safeParse(req.body?.content);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid assignment content", parsed.error.flatten());
  }
  const previousContent = record.content;
  record.content = parsed.data;
  record.editedByUser = true;
  // Keep a saved studio document coherent with explicit section edits while
  // preserving manual blocks in every section that did not change.
  const nextBlocks = syncDocumentBlocksForContent(record, previousContent, parsed.data);
  if (nextBlocks) {
    record = withDocumentBlocks(record, nextBlocks);
  } else {
    record.updatedAt = new Date().toISOString();
  }
  saveRecord(record);
  await persistWithWarning(record, "assignment content update");
  return res.json(record);
});

// Phase 4: DOCX download (deterministic template injection, not LLM output).
assignmentsRouter.get("/:id/docx", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const resolved = await exactTemplateFor(record, res);
  if (!resolved) return undefined;
  try {
    const { renderDocx } = await import("../render/docx.js");
    const buf = await renderDocx(record.content, resolved.doc, record.options);
    res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("content-disposition", `attachment; filename="assignment-${record.id}.docx"`);
    return res.send(Buffer.from(buf));
  } catch (err) {
    return sendError(res, 502, "DOCX rendering failed", String(err).slice(0, 500));
  }
});

// Phase 4: view LaTeX source (editable in the frontend via Monaco).
assignmentsRouter.get("/:id/latex", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const resolved = await exactTemplateFor(record, res);
  if (!resolved) return undefined;
  if (record.latexOverride) return res.json({ latex: record.latexOverride, edited: true });
  const { renderLatex } = await import("../render/latex.js");
  return res.json({
    latex: renderLatex(record.content, resolved.doc, record.options),
    edited: false,
  });
});

// Phase 4: save user-edited LaTeX (treated as untrusted input to the compiler).
assignmentsRouter.put("/:id/latex", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const latex = req.body?.latex;
  if (typeof latex !== "string" || latex.length < 10 || latex.length > 200000) {
    return res.status(400).json({ error: "Invalid LaTeX (must be 10..200000 chars)" });
  }
  record.latexOverride = latex;
  record.updatedAt = new Date().toISOString();
  saveRecord(record);
  await persistWithWarning(record, "assignment latex update");
  return res.json({ ok: true });
});

// Phase 4: compile to PDF inside an isolated container; failures are explicit.
assignmentsRouter.post("/:id/pdf", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const resolved = await exactTemplateFor(record, res);
  if (!resolved) return undefined;
  try {
    const [{ renderLatex }, { compileLatexToPdf, checkCompiler }] = await Promise.all([
      import("../render/latex.js"),
      import("../lib/compile.js"),
    ]);
    const preflight = await checkCompiler();
    if (!preflight.ok) {
      console.error(`[api] pdf preflight failed for ${record.id}:`, preflight.error);
      return res.status(502).json({ error: "The PDF service is unavailable right now. Please try again later." });
    }
    const tex = record.latexOverride ?? renderLatex(record.content, resolved.doc, record.options);
    const out = await compileLatexToPdf(tex, resolved.doc);
    if (!out.ok) {
      console.error(`[api] pdf compile failed for ${record.id}:`, out.error, out.log);
      return res.status(502).json({ error: "The PDF couldn't be built. Please try again." });
    }
    try {
      const { join } = await import("node:path");
      const { assetsDir } = await import("../lib/storage.js");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(assetsDir, "generated", `assignment-${record.id}.pdf`), out.pdf);
    } catch {
      // Non-fatal: streaming the PDF below is what matters.
    }
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="assignment-${record.id}.pdf"`);
    return res.send(Buffer.from(out.pdf));
  } catch (err) {
    return sendError(res, 502, "PDF pipeline failed", String(err).slice(0, 500));
  }
});

