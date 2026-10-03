import { Router } from "express";
import { SECTION_NAMES, assignmentContentSchema, generateInputSchema, sectionValueSchemas } from "../schemas.js";
import { generateViaAiService, regenerateSectionViaAiService } from "../lib/aiClient.js";
import { getSubjectProfile } from "../lib/subjects.js";
import { getDefaultTemplateDoc, getTemplateDoc } from "../lib/templateStore.js";
import { findRecord, listRecordsFor, nextAssignmentId, ownerId, persistWithWarning, saveRecord } from "../lib/assignmentStore.js";
import { renderHtml } from "../render/html.js";
import { sendError } from "../lib/errors.js";

export const assignmentsRouter = Router();

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
  // Template lookup from tenant seeds (requested templateId or the active default).
  const seed = (input.templateId && getTemplateDoc(input.templateId)) || getDefaultTemplateDoc();
  const template = seed
    ? { id: seed.template.id, version: seed.template.version, name: seed.template.name }
    : { id: "default-v1", version: 1, note: "No tenant template seeds found" };

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
  const seed = getTemplateDoc(record.template?.id) || getDefaultTemplateDoc();
  res.type("html").send(renderHtml(record.content, seed, record.options));
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
  const record = await findRecord(req.params.id, ownerId(req));
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
    record.content = { ...record.content, [section]: value.data };
    record.updatedAt = new Date().toISOString();
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
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  const parsed = assignmentContentSchema.safeParse(req.body?.content);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid assignment content", parsed.error.flatten());
  }
  record.content = parsed.data;
  record.editedByUser = true;
  record.updatedAt = new Date().toISOString();
  saveRecord(record);
  await persistWithWarning(record, "assignment content update");
  return res.json(record);
});

// Phase 4: DOCX download (deterministic template injection, not LLM output).
assignmentsRouter.get("/:id/docx", async (req, res) => {
  const record = await findRecord(req.params.id, ownerId(req));
  if (!record) return res.status(404).json({ error: "Not found" });
  try {
    const { renderDocx } = await import("../render/docx.js");
    const seed = getTemplateDoc(record.template?.id) || getDefaultTemplateDoc();
    const buf = await renderDocx(record.content, seed, record.options);
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
  if (record.latexOverride) return res.json({ latex: record.latexOverride, edited: true });
  const { renderLatex } = await import("../render/latex.js");
  const seed = getTemplateDoc(record.template?.id) || getDefaultTemplateDoc();
  return res.json({ latex: renderLatex(record.content, seed, record.options), edited: false });
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
    const seed = getTemplateDoc(record.template?.id) || getDefaultTemplateDoc();
    const tex = record.latexOverride ?? renderLatex(record.content, seed, record.options);
    const out = await compileLatexToPdf(tex, seed);
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

