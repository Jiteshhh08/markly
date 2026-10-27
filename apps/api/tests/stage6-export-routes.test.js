// STAGE 6 — exports resolve the saved document body and the exact template
// version over real HTTP + Mongo.
//
// These tests complement the renderer-level suite: they prove that every
// export route (HTML, DOCX, LaTeX, PDF) reads the latest successfully saved
// `document.blocks` revision and the assignment's pinned template version,
// never a newer published version or a default template. They also cover the
// LaTeX override lifecycle (save, stale detection, explicit bypass, clear)
// and legacy overrides that predate revision metadata.

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage6-export-routes-test-secret-0123456789";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { connectStage6TestDb, disconnectStage6TestDb } from "./helpers/testDb.js";
import { cookieFor, request, startServer, stopServer } from "./helpers/stage2Http.js";

const { default: app } = await import("../src/index.js");
const { Template } = await import("../src/models/index.js");
const { saveRecord, persistWithWarning } = await import("../src/lib/assignmentStore.js");
const { assetsDir } = await import("../src/lib/storage.js");

const TEST_DB = "markly_stage6_export_routes_test";
const USER = "stage6-export-user";
const COOKIE = cookieFor({ id: USER, email: "stage6-export@example.com" });
const TEMPLATE_ID = "tpl_stage6_exports";

const originalPdfCommand = process.env.PDF_COMPILE_CMD;
const originalPdfDocker = process.env.PDF_DOCKER;

let server;
let base;
let pdfDir;
let seq = 0;
const pdfArtifacts = new Set();

function nextId(label) {
  seq += 1;
  return `asg_stage6_routes_${label}_${Date.now()}_${seq}`;
}

function validContent() {
  return {
    experimentNumber: 7,
    title: "STAGE6 ROUTE CONTENT TITLE",
    aim: "STAGE6 ROUTE CONTENT AIM",
    objectives: ["STAGE6 ROUTE CONTENT OBJECTIVE"],
    theory: ["STAGE6 ROUTE CONTENT THEORY"],
    steps: [
      {
        number: 1,
        title: "STAGE6 ROUTE CONTENT STEP",
        description: ["STAGE6 ROUTE CONTENT DESCRIPTION"],
        code: "STAGE6 ROUTE CONTENT CODE",
        language: "sql",
      },
    ],
    conclusion: "STAGE6 ROUTE CONTENT CONCLUSION",
    metadata: {},
  };
}

function routeBlocks(marker) {
  return [
    { id: "route-title", type: "title", content: { text: "STAGE6 ROUTE TITLE" } },
    { id: "route-heading", type: "heading", content: { text: "STAGE6 ROUTE HEADING" } },
    {
      id: "route-paragraph",
      type: "paragraph",
      content: { text: marker },
      style: {
        align: "justify",
        fontSize: 16,
        lineHeight: 1.7,
        spacingBefore: 10,
        spacingAfter: 12,
        indent: 18,
      },
    },
    {
      id: "route-code",
      type: "code",
      content: { text: "def route():\n    return 'STAGE6 ROUTE CODE'", language: "python" },
    },
    { id: "route-break", type: "pageBreak", content: {} },
    { id: "route-after", type: "paragraph", content: { text: "STAGE6 ROUTE AFTER BREAK" } },
  ];
}

function templateDoc(version) {
  const v1 = version === 1;
  return {
    id: TEMPLATE_ID,
    version,
    name: `Stage 6 Export Template v${version}`,
    scope: "platform",
    status: "active",
    page: {
      size: "A4",
      margin: { top: "30mm", right: "18mm", bottom: "20mm", left: "18mm" },
      border: { style: "solid", width: "2px", color: v1 ? "#123456" : "#654321" },
    },
    typography: {
      fontFamily: v1 ? "Georgia, serif" : "Arial, sans-serif",
      baseSize: "12pt",
      lineHeight: 1.5,
    },
    header: { image: "/assets/tcet-header.png", alt: `STAGE6 V${version} HEADER` },
    watermark: { image: "/assets/tcet-watermark.png", alt: `STAGE6 V${version} WATERMARK` },
    assets: v1
      ? { logo: "/assets/tcet-header.png", logoAlt: "STAGE6 V1 LOCKED LOGO" }
      : { logo: "/assets/tcet-watermark.png", logoAlt: "STAGE6 V2 LOCKED LOGO" },
    footer: { text: `STAGE6V${version}FOOTER`, showPageNumber: true },
    facultyTable: {
      title: `STAGE6V${version}FACULTY`,
      columns: ["Name", "Signature"],
      rows: [["", ""]],
    },
  };
}

async function seedAssignment({
  id = nextId("export"),
  templateVersion = 1,
  template = { id: TEMPLATE_ID, version: templateVersion },
  revision = 2,
  blocks = routeBlocks("STAGE6 ROUTE SAVED BODY"),
  extra = {},
} = {}) {
  const now = new Date().toISOString();
  const record = {
    id,
    userId: USER,
    status: "completed",
    input: { aim: "Explore subqueries in SQL", subject: "DBMS" },
    content: validContent(),
    options: { includeVivaTitle: false, typedConclusion: true },
    template,
    document: { schemaVersion: 2, revision, blocks, updatedAt: now },
    documentSchemaVersion: 2,
    documentRevision: revision,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  saveRecord(record);
  const durable = await persistWithWarning(record, "stage6 export route seed");
  assert.equal(durable, true, "the Stage 6 test database must be reachable");
  return record;
}

function makeFakePdfTools() {
  const dir = mkdtempSync(join(tmpdir(), "stage6-pdf-"));
  const docker = join(dir, "docker-stub.cjs");
  const compiler = join(dir, "compiler.cjs");
  writeFileSync(docker, "process.exit(0);\n");
  writeFileSync(
    compiler,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const dir = process.argv[2] || process.cwd();",
      'const tex = fs.readFileSync(path.join(dir, "doc.tex"), "utf8");',
      "const markers = [...tex.matchAll(/STAGE6[A-Z0-9 _-]*/g)].map((m) => m[0].trim()).filter(Boolean);",
      'fs.writeFileSync(path.join(dir, "doc.pdf"), "%PDF-1.4\\n% " + (markers.join("|") || "NO_MARKER") + "\\n%%EOF\\n");',
      "",
    ].join("\n"),
  );
  process.env.PDF_DOCKER = `node "${docker}"`;
  process.env.PDF_COMPILE_CMD = `node "${compiler}" {dir}`;
  return dir;
}

async function pdfRequest(id, options = {}) {
  pdfArtifacts.add(id);
  const hasBody = options.bypassStaleOverride !== undefined;
  const res = await fetch(`${base}/api/v1/assignments/${id}/pdf`, {
    method: "POST",
    headers: {
      cookie: COOKIE,
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(options) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString("utf8");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    buffer,
    text,
    data,
  };
}

async function docxParts(response) {
  const zip = await JSZip.loadAsync(response.buffer);
  const readAll = async (pattern) => {
    const files = zip.file(pattern) ?? [];
    return (await Promise.all(files.map((file) => file.async("string")))).join("\n");
  };
  return {
    zip,
    documentXml: (await zip.file("word/document.xml")?.async("string")) ?? "",
    headerXml: await readAll(/word\/header.*\.xml/),
    footerXml: await readAll(/word\/footer.*\.xml/),
  };
}

function assertContains(haystack, marker, label) {
  assert.ok(haystack.includes(marker), `${label}: missing ${JSON.stringify(marker)}`);
}

function assertNotContains(haystack, marker, label) {
  assert.ok(!haystack.includes(marker), `${label}: unexpectedly contains ${JSON.stringify(marker)}`);
}

async function exportAll(id) {
  return {
    html: await request(base, "GET", `/api/v1/assignments/${id}/html`, { cookie: COOKIE }),
    docx: await request(base, "GET", `/api/v1/assignments/${id}/docx`, { cookie: COOKIE }),
    latex: await request(base, "GET", `/api/v1/assignments/${id}/latex`, { cookie: COOKIE }),
    pdf: await pdfRequest(id),
  };
}

before(async () => {
  await connectStage6TestDb(TEST_DB);
  const mongoose = (await import("mongoose")).default;
  await mongoose.connection.db.dropDatabase();

  await Template.create([templateDoc(1), templateDoc(2)]);
  pdfDir = makeFakePdfTools();
  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server).catch(() => {});
  for (const id of pdfArtifacts) {
    const path = join(assetsDir, "generated", `assignment-${id}.pdf`);
    if (existsSync(path)) rmSync(path, { force: true });
  }
  rmSync(pdfDir, { recursive: true, force: true });
  await disconnectStage6TestDb();

  if (originalPdfCommand === undefined) delete process.env.PDF_COMPILE_CMD;
  else process.env.PDF_COMPILE_CMD = originalPdfCommand;
  if (originalPdfDocker === undefined) delete process.env.PDF_DOCKER;
  else process.env.PDF_DOCKER = originalPdfDocker;
});

describe("STAGE 6 export routes", () => {
  it("exports the saved blocks with the assignment's exact template version after v2 is published", async () => {
    const versions = await Template.find({ id: TEMPLATE_ID }).sort({ version: 1 }).lean();
    assert.deepEqual(versions.map((doc) => doc.version), [1, 2], "both versions must be durable");

    const v1Id = nextId("pinned_v1");
    const v2Id = nextId("pinned_v2");
    await seedAssignment({ id: v1Id, templateVersion: 1 });
    await seedAssignment({
      id: v2Id,
      templateVersion: 2,
      blocks: routeBlocks("STAGE6 ROUTE V2 BODY"),
    });

    const v1 = await exportAll(v1Id);
    assert.equal(v1.html.status, 200, v1.html.text);
    assert.equal(v1.docx.status, 200);
    assert.equal(v1.latex.status, 200, v1.latex.text);
    assert.equal(v1.pdf.status, 200, v1.pdf.text);

    const v1Docx = await docxParts(v1.docx);
    const v1DocxText = [v1Docx.documentXml, v1Docx.headerXml, v1Docx.footerXml].join("\n");
    for (const [label, output] of [
      ["HTML", v1.html.text],
      ["DOCX", v1DocxText],
      ["LaTeX", v1.latex.data.latex],
      ["PDF", v1.pdf.text],
    ]) {
      assertContains(output, "STAGE6 ROUTE SAVED BODY", label);
      assertContains(output, "STAGE6V1FOOTER", label);
      assertContains(output, "STAGE6V1FACULTY", label);
      assertNotContains(output, "STAGE6V2FOOTER", label);
      assertNotContains(output, "STAGE6V2FACULTY", label);
      assertNotContains(output, "STAGE6 ROUTE V2 BODY", label);
      assertNotContains(output, "STAGE6 ROUTE CONTENT AIM", label);
    }

    // Locked template presentation is present in each format and is not
    // replaced by saved block text.
    assertContains(v1.html.text, 'class="doc-header-img"', "HTML header");
    assertContains(v1.html.text, 'class="doc-logo"', "HTML logo");
    assertContains(v1.html.text, 'class="watermark-img"', "HTML watermark");
    assertContains(v1.html.text, 'class="page-frame"', "HTML page border");
    assertContains(v1.html.text, "#123456", "HTML border colour");
    assertContains(v1.html.text, "width: 84mm", "HTML watermark width");

    assertContains(v1Docx.footerXml, "STAGE6V1FOOTER", "DOCX footer");
    assertContains(v1Docx.headerXml, "<wp:anchor", "DOCX header anchor");
    assertContains(v1Docx.headerXml, "<v:imagedata", "DOCX watermark");
    assertContains(v1Docx.headerXml, 'gain="19661f"', "DOCX watermark washout");
    assertContains(v1Docx.documentXml, 'w:color="123456"', "DOCX page border colour");
    assertContains(v1Docx.documentXml, 'w:pgSz w:w="11906" w:h="16838"', "DOCX page size");
    assert.equal(
      (v1Docx.headerXml.match(/<wp:anchor/g) ?? []).length,
      2,
      "DOCX header must contain the banner and locked logo",
    );
    assert.ok(
      (v1Docx.zip.file(/word\/media\//) ?? []).length >= 2,
      "DOCX must package header/logo and watermark media",
    );

    assertContains(v1.latex.data.latex, "header.jpg", "LaTeX header");
    assertContains(v1.latex.data.latex, "watermark.png", "LaTeX watermark");
    assertContains(v1.latex.data.latex, "logo.jpg", "LaTeX logo");
    assertContains(v1.latex.data.latex, "\\definecolor{docborder}{HTML}{123456}", "LaTeX border");
    assert.equal(v1.pdf.headers["x-markly-latex-source"], "generated");

    // The v2 assignment must render v2, proving the pinned v1 export did not
    // poison the shared template cache.
    const v2Html = await request(base, "GET", `/api/v1/assignments/${v2Id}/html`, {
      cookie: COOKIE,
    });
    assert.equal(v2Html.status, 200);
    assertContains(v2Html.text, "STAGE6V2FOOTER", "v2 HTML footer");
    assertContains(v2Html.text, "STAGE6V2FACULTY", "v2 HTML faculty");
    assertContains(v2Html.text, "#654321", "v2 HTML border colour");
    assertNotContains(v2Html.text, "STAGE6V1FOOTER", "v2 HTML footer");
  });

  it("fails every export explicitly when the pinned template version is missing", async () => {
    const missingId = nextId("missing_version");
    await seedAssignment({
      id: missingId,
      template: { id: `tpl_stage6_missing_${Date.now()}`, version: 9 },
    });

    for (const [method, path] of [
      ["GET", `/api/v1/assignments/${missingId}/html`],
      ["GET", `/api/v1/assignments/${missingId}/docx`],
      ["GET", `/api/v1/assignments/${missingId}/latex`],
      ["POST", `/api/v1/assignments/${missingId}/pdf`],
    ]) {
      const response = await request(base, method, path, { cookie: COOKIE });
      assert.equal(response.status, 409, `${path}: ${response.text}`);
      assert.match(response.data.error, /template version/i, path);
      assert.match(response.data.error, /no longer available/i, path);
    }

    const unavailableId = nextId("unavailable_version");
    await seedAssignment({
      id: unavailableId,
      template: { id: TEMPLATE_ID, version: 99 },
    });
    const unavailable = await request(
      base,
      "GET",
      `/api/v1/assignments/${unavailableId}/html`,
      { cookie: COOKIE },
    );
    assert.equal(unavailable.status, 409);
    assert.match(unavailable.data.error, /no longer available/i);

    const noVersionId = nextId("no_version");
    await seedAssignment({ id: noVersionId, template: { id: TEMPLATE_ID } });
    for (const [method, path] of [
      ["GET", `/api/v1/assignments/${noVersionId}/html`],
      ["GET", `/api/v1/assignments/${noVersionId}/docx`],
      ["GET", `/api/v1/assignments/${noVersionId}/latex`],
      ["POST", `/api/v1/assignments/${noVersionId}/pdf`],
    ]) {
      const response = await request(base, method, path, { cookie: COOKIE });
      assert.equal(response.status, 409, `${path}: ${response.text}`);
      assert.match(response.data.error, /does not record a template version/i, path);
    }
  });

  it("exports only the latest successfully saved revision and rejects stale saves", async () => {
    const id = nextId("saved_revision");
    await seedAssignment({
      id,
      revision: 2,
      blocks: routeBlocks("STAGE6 ROUTE SAVED REV 2"),
    });

    const stale = await request(base, "PUT", `/api/v1/assignments/${id}/document`, {
      cookie: COOKIE,
      body: {
        revision: 1,
        blocks: [
          {
            id: "route-paragraph",
            type: "paragraph",
            content: { text: "STAGE6 ROUTE UNSAVED REV 1" },
          },
        ],
      },
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.data.code, "document_conflict");
    assert.equal(stale.data.revision, 2);

    const beforeSave = await exportAll(id);
    for (const [label, output] of [
      ["HTML", beforeSave.html.text],
      ["DOCX", (await docxParts(beforeSave.docx)).documentXml],
      ["LaTeX", beforeSave.latex.data.latex],
      ["PDF", beforeSave.pdf.text],
    ]) {
      assertContains(output, "STAGE6 ROUTE SAVED REV 2", label);
      assertNotContains(output, "STAGE6 ROUTE UNSAVED REV 1", label);
    }

    const saved = await request(base, "PUT", `/api/v1/assignments/${id}/document`, {
      cookie: COOKIE,
      body: {
        revision: 2,
        blocks: [
          {
            id: "route-paragraph",
            type: "paragraph",
            content: { text: "STAGE6 ROUTE SAVED REV 3" },
          },
        ],
      },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.document.revision, 3);

    const afterSave = await exportAll(id);
    for (const [label, output] of [
      ["HTML", afterSave.html.text],
      ["DOCX", (await docxParts(afterSave.docx)).documentXml],
      ["LaTeX", afterSave.latex.data.latex],
      ["PDF", afterSave.pdf.text],
    ]) {
      assertContains(output, "STAGE6 ROUTE SAVED REV 3", label);
      assertNotContains(output, "STAGE6 ROUTE SAVED REV 2", label);
      assertNotContains(output, "STAGE6 ROUTE UNSAVED REV 1", label);
    }
  });

  it("saves, updates and clears LaTeX overrides while refusing stale PDF exports", async () => {
    const id = nextId("latex_override");
    await seedAssignment({
      id,
      revision: 2,
      blocks: routeBlocks("STAGE6 ROUTE OVERRIDE GENERATED BODY"),
    });

    const generated = await request(base, "GET", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(generated.status, 200, generated.text);
    assert.equal(generated.data.source, "generated");
    assert.equal(generated.data.edited, false);
    assert.equal(generated.data.override, null);
    assert.equal(generated.data.documentRevision, 2);
    assert.deepEqual(generated.data.template, { id: TEMPLATE_ID, version: 1 });
    assertContains(generated.data.latex, "STAGE6 ROUTE OVERRIDE GENERATED BODY", "generated LaTeX");

    const override = [
      "% STAGE6 OVERRIDE MARKER",
      "\\documentclass{article}",
      "\\begin{document}",
      "STAGE6 OVERRIDE BODY",
      "\\end{document}",
      "",
    ].join("\n");
    const saved = await request(base, "PUT", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
      body: { latex: override },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.source, "override");
    assert.equal(saved.data.override.documentRevision, 2);
    assert.equal(saved.data.override.templateId, TEMPLATE_ID);
    assert.equal(saved.data.override.templateVersion, 1);
    assert.equal(saved.data.override.stale, false);
    assert.equal(saved.data.override.legacy, false);

    const overridden = await request(base, "GET", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(overridden.status, 200);
    assert.equal(overridden.data.source, "override");
    assert.equal(overridden.data.edited, true);
    assert.equal(overridden.data.override.stale, false);
    assertContains(overridden.data.latex, "STAGE6 OVERRIDE MARKER", "override LaTeX");
    assertContains(
      overridden.data.generatedLatex,
      "STAGE6 ROUTE OVERRIDE GENERATED BODY",
      "generated comparison",
    );

    const overridePdf = await pdfRequest(id);
    assert.equal(overridePdf.status, 200, overridePdf.text);
    assert.equal(overridePdf.headers["x-markly-latex-source"], "override");
    assertContains(overridePdf.text, "STAGE6 OVERRIDE MARKER", "override PDF");
    assertNotContains(
      overridePdf.text,
      "STAGE6 ROUTE OVERRIDE GENERATED BODY",
      "override PDF",
    );

    const invalid = await request(base, "PUT", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
      body: { latex: "short" },
    });
    assert.equal(invalid.status, 400);

    const revisionBump = await request(base, "PUT", `/api/v1/assignments/${id}/document`, {
      cookie: COOKIE,
      body: {
        revision: 2,
        blocks: routeBlocks("STAGE6 ROUTE OVERRIDE REV 3"),
      },
    });
    assert.equal(revisionBump.status, 200, revisionBump.text);
    assert.equal(revisionBump.data.document.revision, 3);

    const stale = await request(base, "GET", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.data.override.stale, true);
    assert.equal(stale.data.override.legacy, false);
    assert.ok(stale.data.override.reasons.includes("document_revision_changed"));
    assert.equal(stale.data.override.documentRevision, 2);
    assertContains(
      stale.data.generatedLatex,
      "STAGE6 ROUTE OVERRIDE REV 3",
      "stale generated comparison",
    );

    const refused = await pdfRequest(id);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.data.code, "latex_override_stale");
    assert.equal(refused.data.override.stale, true);
    assert.equal(refused.data.documentRevision, 3);

    const bypassed = await pdfRequest(id, { bypassStaleOverride: true });
    assert.equal(bypassed.status, 200, bypassed.text);
    assert.equal(bypassed.headers["x-markly-latex-source"], "override");
    assertContains(bypassed.text, "STAGE6 OVERRIDE MARKER", "bypassed PDF");
    assertNotContains(bypassed.text, "STAGE6 ROUTE OVERRIDE REV 3", "bypassed PDF");

    const replacement = [
      "% STAGE6 OVERRIDE MARKER 2",
      "\\documentclass{article}",
      "\\begin{document}",
      "STAGE6 OVERRIDE BODY 2",
      "\\end{document}",
      "",
    ].join("\n");
    const refreshed = await request(base, "PUT", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
      body: { latex: replacement },
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(refreshed.data.override.documentRevision, 3);
    assert.equal(refreshed.data.override.stale, false);

    const cleared = await request(base, "DELETE", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.data.cleared, true);
    assert.equal(cleared.data.source, "generated");

    const afterClear = await request(base, "GET", `/api/v1/assignments/${id}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(afterClear.status, 200);
    assert.equal(afterClear.data.source, "generated");
    assert.equal(afterClear.data.override, null);
    assertContains(afterClear.data.latex, "STAGE6 ROUTE OVERRIDE REV 3", "cleared LaTeX");

    const generatedPdf = await pdfRequest(id);
    assert.equal(generatedPdf.status, 200, generatedPdf.text);
    assert.equal(generatedPdf.headers["x-markly-latex-source"], "generated");
    assertContains(generatedPdf.text, "STAGE6 ROUTE OVERRIDE REV 3", "generated PDF");
    assertNotContains(generatedPdf.text, "STAGE6 OVERRIDE MARKER", "generated PDF");
  });

  it("keeps legacy overrides usable and flags template-version mismatches as stale", async () => {
    const legacyId = nextId("legacy_override");
    const legacyLatex = [
      "% STAGE6 LEGACY OVERRIDE MARKER",
      "\\documentclass{article}",
      "\\begin{document}",
      "STAGE6 LEGACY OVERRIDE BODY",
      "\\end{document}",
      "",
    ].join("\n");
    await seedAssignment({
      id: legacyId,
      revision: 2,
      extra: { latexOverride: legacyLatex },
    });

    const legacy = await request(base, "GET", `/api/v1/assignments/${legacyId}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(legacy.status, 200, legacy.text);
    assert.equal(legacy.data.source, "override");
    assert.equal(legacy.data.override.legacy, true);
    assert.equal(legacy.data.override.stale, false);
    assert.equal(legacy.data.override.documentRevision, null);

    const legacyPdf = await pdfRequest(legacyId);
    assert.equal(legacyPdf.status, 200, legacyPdf.text);
    assert.equal(legacyPdf.headers["x-markly-latex-source"], "override");
    assertContains(legacyPdf.text, "STAGE6 LEGACY OVERRIDE MARKER", "legacy PDF");

    const mismatchId = nextId("template_mismatch");
    await seedAssignment({
      id: mismatchId,
      revision: 2,
      extra: {
        latexOverride: legacyLatex,
        latexOverrideMeta: {
          documentRevision: 2,
          templateId: TEMPLATE_ID,
          templateVersion: 2,
          savedAt: new Date().toISOString(),
        },
      },
    });

    const mismatch = await request(base, "GET", `/api/v1/assignments/${mismatchId}/latex`, {
      cookie: COOKIE,
    });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.data.override.stale, true);
    assert.ok(mismatch.data.override.reasons.includes("template_version_changed"));

    const mismatchPdf = await pdfRequest(mismatchId);
    assert.equal(mismatchPdf.status, 409, mismatchPdf.text);
    assert.equal(mismatchPdf.data.code, "latex_override_stale");
  });
});
