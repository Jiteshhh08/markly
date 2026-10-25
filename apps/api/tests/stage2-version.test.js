import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage2-version-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import JSZip from "jszip";
import { connectStage2TestDb, disconnectStage2TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { Assignment, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { saveRecord } = await import("../src/lib/assignmentStore.js");
const { startServer, stopServer, cookieFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage2_version_test";
const TEMPLATE_RE = /^stage2-version-/;

let db;
let server;
let base;
let stub;
let pdfDir;
let platformAdmin;
let collegeAdmin;
let ordinaryA;
let ordinaryB;
let generateCalls = 0;

const originalAiUrl = process.env.AI_SERVICE_URL;
const originalPdfCommand = process.env.PDF_COMPILE_CMD;
const originalPdfDocker = process.env.PDF_DOCKER;

function stubContent() {
  return {
    experimentNumber: 7,
    title: "Explore subqueries in SQL",
    aim: "Explore subqueries in SQL",
    objectives: ["Understand single-row subqueries with IN and EXISTS"],
    theory: ["A subquery is a query nested inside another query for filtering."],
    steps: [
      {
        number: 1,
        title: "Set up tables",
        description: ["Create the student and enrollment tables first."],
        code: null,
        language: null,
      },
    ],
    conclusion: "Subqueries let us compose complex filters from simple parts.",
    metadata: {},
  };
}

function startStubAi() {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/generate" && req.method === "POST") {
        generateCalls += 1;
        return send(200, {
          content: stubContent(),
          sources: [],
          provider: "stub",
          model: "stub-1",
          promptVersion: "stage2",
          validation: { ok: true },
          researchProvider: "none",
        });
      }
      if (req.url === "/v1/regenerate-section" && req.method === "POST") {
        return send(200, { value: "Regenerated" });
      }
      return send(404, { error: "stub: unknown route" });
    });
  });
}

function cookie(user) {
  return cookieFor(user);
}

function makeFakePdfTools() {
  const dir = mkdtempSync(join(tmpdir(), "stage2-pdf-"));
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
      "const markers = [...tex.matchAll(/STAGE2V[0-9]+FACULTY/g)].map((m) => m[0]);",
      'fs.writeFileSync(path.join(dir, "doc.pdf"), `%PDF-1.4\\n% ${markers.join(",") || "NO_MARKER"}\\n%%EOF\\n`);',
      "",
    ].join("\n"),
  );
  process.env.PDF_DOCKER = `node "${docker}"`;
  process.env.PDF_COMPILE_CMD = `node "${compiler}" {dir}`;
  return dir;
}

async function waitForJob(id, user) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const polled = await request(base, "GET", `/api/v1/jobs/${id}`, {
      cookie: cookie(user),
    });
    assert.equal(polled.status, 200, JSON.stringify(polled.data));
    if (polled.data.job.status === "completed" || polled.data.job.status === "failed") {
      return polled.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${id} did not finish`);
}

before(async () => {
  db = await connectStage2TestDb(TEST_DB);
  await db.dropDatabase();

  await Tenant.create([
    { id: "college-a", name: "College A" },
    { id: "college-b", name: "College B" },
  ]);
  await Department.create([
    { id: "dept-a1", tenantId: "college-a", name: "A Branch 1" },
    { id: "dept-a2", tenantId: "college-a", name: "A Branch 2" },
    { id: "dept-b1", tenantId: "college-b", name: "B Branch 1" },
  ]);

  platformAdmin = await User.create({
    id: "usr_stage2_version_platform",
    email: "stage2-version-platform@example.com",
    name: "Platform admin",
    role: "platform_admin",
  });
  collegeAdmin = await User.create({
    id: "usr_stage2_version_college_admin",
    email: "stage2-version-college-admin@example.com",
    name: "College A admin",
    role: "college_admin",
    collegeAdminOf: ["college-a"],
  });
  ordinaryA = await User.create({
    id: "usr_stage2_version_ordinary_a",
    email: "stage2-version-ordinary-a@example.com",
    name: "Ordinary A",
    role: "user",
    tenantIds: ["college-a"],
    preferences: { collegeId: "college-a", departmentId: "dept-a1" },
  });
  ordinaryB = await User.create({
    id: "usr_stage2_version_ordinary_b",
    email: "stage2-version-ordinary-b@example.com",
    name: "Ordinary B",
    role: "user",
    tenantIds: ["college-b"],
    preferences: { collegeId: "college-b", departmentId: "dept-b1" },
  });

  stub = startStubAi();
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${stub.address().port}`;
  pdfDir = makeFakePdfTools();

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await new Promise((resolve) => stub.close(resolve));
  rmSync(pdfDir, { recursive: true, force: true });
  await db?.dropDatabase().catch(() => {});
  await disconnectStage2TestDb();

  if (originalAiUrl === undefined) delete process.env.AI_SERVICE_URL;
  else process.env.AI_SERVICE_URL = originalAiUrl;
  if (originalPdfCommand === undefined) delete process.env.PDF_COMPILE_CMD;
  else process.env.PDF_COMPILE_CMD = originalPdfCommand;
  if (originalPdfDocker === undefined) delete process.env.PDF_DOCKER;
  else process.env.PDF_DOCKER = originalPdfDocker;
});

describe("STAGE 2 immutable template identity and exact-version resolution", () => {
  it("renames without changing identity and never collides same-named college templates", async () => {
    const first = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(platformAdmin),
      body: {
        name: "Stage2 Version Shared Duplicate",
        scope: "college",
        tenantId: "college-a",
        departmentId: "dept-a1",
        status: "active",
        footer: { text: "college A v1" },
      },
    });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const idA = first.data.template.id;

    const second = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(platformAdmin),
      body: {
        name: "Stage2 Version Shared Duplicate",
        scope: "college",
        tenantId: "college-b",
        departmentId: "dept-b1",
        status: "active",
        footer: { text: "college B v1" },
      },
    });
    assert.equal(second.status, 201, JSON.stringify(second.data));
    const idB = second.data.template.id;

    assert.notEqual(idA, idB, "same name in different colleges must not share an id");
    assert.equal(first.data.template.tenantId, "college-a");
    assert.equal(second.data.template.tenantId, "college-b");

    const renamed = await request(base, "PUT", `/api/v1/templates/${idA}`, {
      cookie: cookie(platformAdmin),
      body: { name: "Stage2 Version Shared Renamed" },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.template.id, idA, "renaming must preserve the stable id");
    assert.equal(renamed.data.template.version, 2);
    assert.equal(renamed.data.template.name, "Stage2 Version Shared Renamed");
    assert.equal(renamed.data.template.status, "active");
    assert.equal(renamed.data.template.tenantId, "college-a");

    const originalV1 = await Template.findOne({ id: idA, version: 1 }).lean();
    const renamedV2 = await Template.findOne({ id: idA, version: 2 }).lean();
    assert.equal(originalV1.name, "Stage2 Version Shared Duplicate");
    assert.equal(originalV1.status, "active");
    assert.equal(renamedV2.name, "Stage2 Version Shared Renamed");
    assert.equal(renamedV2.status, "active");

    const untouched = await request(base, "GET", `/api/v1/templates/${idB}`, {
      cookie: cookie(platformAdmin),
    });
    assert.equal(untouched.status, 200);
    assert.equal(untouched.data.template.version, 1);
    assert.equal(untouched.data.template.name, "Stage2 Version Shared Duplicate");
  });

  it("pins the generation version and renders HTML, DOCX, LaTeX and PDF from that exact version after v2 exists", async () => {
    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(ordinaryA),
      body: {
        name: "Stage2 Version Export Template",
        footer: { text: "STAGE2 V1 FOOTER" },
        facultyTable: {
          title: "STAGE2V1FACULTY",
          columns: ["Name", "Signature"],
          rows: [["", ""]],
        },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const templateId = created.data.template.id;
    assert.match(templateId, TEMPLATE_RE);

    const generated = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: cookie(ordinaryA),
      body: {
        aim: "Explore subqueries in SQL",
        subject: "DBMS",
        experimentNumber: 7,
        templateId,
        templateVersion: 1,
      },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.data));
    const assignmentId = generated.data.id;
    assert.equal(generated.data.template.id, templateId);
    assert.equal(generated.data.template.version, 1);

    const persisted = await Assignment.findOne({ recordId: assignmentId }).lean();
    assert.ok(persisted);
    assert.equal(persisted.data.template.version, 1);

    const updated = await request(base, "PUT", `/api/v1/templates/${templateId}`, {
      cookie: cookie(ordinaryA),
      body: {
        footer: { text: "STAGE2 V2 FOOTER" },
        facultyTable: {
          title: "STAGE2V2FACULTY",
          columns: ["Name", "Signature"],
          rows: [["", ""]],
        },
      },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.template.version, 2);

    const html = await request(base, "GET", `/api/v1/assignments/${assignmentId}/html`, {
      cookie: cookie(ordinaryA),
    });
    assert.equal(html.status, 200);
    assert.match(html.text, /STAGE2 V1 FOOTER/);
    assert.match(html.text, /STAGE2V1FACULTY/);
    assert.doesNotMatch(html.text, /STAGE2 V2 FOOTER/);
    assert.doesNotMatch(html.text, /STAGE2V2FACULTY/);

    const docx = await request(base, "GET", `/api/v1/assignments/${assignmentId}/docx`, {
      cookie: cookie(ordinaryA),
    });
    assert.equal(docx.status, 200);
    const zip = await JSZip.loadAsync(docx.buffer);
    const footerEntries = zip.file(/word\/footer.*\.xml/);
    assert.ok(footerEntries.length > 0, "DOCX must contain a footer part");
    const footerXml = await footerEntries[0].async("string");
    assert.match(footerXml, /STAGE2 V1 FOOTER/);
    assert.doesNotMatch(footerXml, /STAGE2 V2 FOOTER/);
    const documentXml = await zip.file("word/document.xml").async("string");
    assert.match(documentXml, /STAGE2V1FACULTY/);
    assert.doesNotMatch(documentXml, /STAGE2V2FACULTY/);

    const latex = await request(base, "GET", `/api/v1/assignments/${assignmentId}/latex`, {
      cookie: cookie(ordinaryA),
    });
    assert.equal(latex.status, 200);
    assert.match(latex.data.latex, /STAGE2V1FACULTY/);
    assert.doesNotMatch(latex.data.latex, /STAGE2V2FACULTY/);

    const pdf = await request(base, "POST", `/api/v1/assignments/${assignmentId}/pdf`, {
      cookie: cookie(ordinaryA),
    });
    assert.equal(pdf.status, 200, pdf.text);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.buffer.toString("utf8"), /STAGE2V1FACULTY/);
    assert.doesNotMatch(pdf.buffer.toString("utf8"), /STAGE2V2FACULTY/);
  });

  it("pins a background job to the version selected at enqueue time", async () => {
    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(ordinaryA),
      body: {
        name: "Stage2 Version Job Template",
        footer: { text: "STAGE2 JOB V1 FOOTER" },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const templateId = created.data.template.id;

    const enqueued = await request(base, "POST", "/api/v1/jobs", {
      cookie: cookie(ordinaryA),
      body: {
        type: "generate",
        input: {
          aim: "Explore subqueries in SQL",
          subject: "DBMS",
          templateId,
          templateVersion: 1,
        },
      },
    });
    assert.equal(enqueued.status, 202, JSON.stringify(enqueued.data));
    assert.equal(enqueued.data.job.template.id, templateId);
    assert.equal(enqueued.data.job.template.version, 1);

    const updated = await request(base, "PUT", `/api/v1/templates/${templateId}`, {
      cookie: cookie(ordinaryA),
      body: { footer: { text: "STAGE2 JOB V2 FOOTER" } },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.template.version, 2);

    const completed = await waitForJob(enqueued.data.job.id, ordinaryA);
    assert.equal(completed.job.status, "completed", JSON.stringify(completed.job));
    assert.ok(completed.assignment);

    const record = await request(
      base,
      "GET",
      `/api/v1/assignments/${completed.assignment.id}`,
      { cookie: cookie(ordinaryA) },
    );
    assert.equal(record.status, 200);
    assert.equal(record.data.template.id, templateId);
    assert.equal(record.data.template.version, 1);

    const html = await request(
      base,
      "GET",
      `/api/v1/assignments/${completed.assignment.id}/html`,
      { cookie: cookie(ordinaryA) },
    );
    assert.equal(html.status, 200);
    assert.match(html.text, /STAGE2 JOB V1 FOOTER/);
    assert.doesNotMatch(html.text, /STAGE2 JOB V2 FOOTER/);
  });

  it("rejects missing/foreign versions with explicit errors and never falls back", async () => {
    const beforeCalls = generateCalls;

    const missingVersion = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: cookie(ordinaryA),
      body: { aim: "Explore subqueries in SQL", templateVersion: 1 },
    });
    assert.equal(missingVersion.status, 400);
    assert.match(missingVersion.data.error, /templateId/i);

    const missingTemplateId = `stage2-version-does-not-exist-${Date.now()}`;
    const missingTemplate = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: cookie(ordinaryA),
      body: {
        aim: "Explore subqueries in SQL",
        templateId: missingTemplateId,
        templateVersion: 1,
      },
    });
    assert.equal(missingTemplate.status, 404);
    assert.match(missingTemplate.data.error, /unavailable/i);

    const missingJob = await request(base, "POST", "/api/v1/jobs", {
      cookie: cookie(ordinaryA),
      body: {
        type: "generate",
        input: {
          aim: "Explore subqueries in SQL",
          templateId: missingTemplateId,
          templateVersion: 1,
        },
      },
    });
    assert.equal(missingJob.status, 404, JSON.stringify(missingJob.data));
    assert.match(missingJob.data.error, /unavailable/i);

    const collegeB = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(platformAdmin),
      body: {
        name: "Stage2 Version College B Only",
        scope: "college",
        tenantId: "college-b",
        departmentId: "dept-b1",
        status: "active",
      },
    });
    assert.equal(collegeB.status, 201, JSON.stringify(collegeB.data));

    const crossCollege = await request(
      base,
      "POST",
      "/api/v1/assignments/generate",
      {
        cookie: cookie(ordinaryA),
        body: {
          aim: "Explore subqueries in SQL",
          templateId: collegeB.data.template.id,
          templateVersion: 1,
        },
      },
    );
    assert.equal(crossCollege.status, 404);
    assert.match(crossCollege.data.error, /unavailable/i);

    const crossCollegeJob = await request(base, "POST", "/api/v1/jobs", {
      cookie: cookie(ordinaryA),
      body: {
        type: "generate",
        input: {
          aim: "Explore subqueries in SQL",
          templateId: collegeB.data.template.id,
          templateVersion: 1,
        },
      },
    });
    assert.equal(crossCollegeJob.status, 404, JSON.stringify(crossCollegeJob.data));
    assert.match(crossCollegeJob.data.error, /unavailable/i);

    assert.equal(generateCalls, beforeCalls, "invalid template resolution must not call the AI service");

    const missingTemplateRecordId = `asg_stage2_missing_template_${Date.now()}`;
    saveRecord({
      id: missingTemplateRecordId,
      status: "completed",
      userId: ordinaryA.id,
      input: { aim: "Explore subqueries in SQL" },
      template: { id: `stage2-version-missing-${Date.now()}`, version: 9 },
      content: stubContent(),
      options: {},
      createdAt: new Date().toISOString(),
    });
    for (const [method, path] of [
      ["GET", `/api/v1/assignments/${missingTemplateRecordId}/html`],
      ["GET", `/api/v1/assignments/${missingTemplateRecordId}/docx`],
      ["GET", `/api/v1/assignments/${missingTemplateRecordId}/latex`],
      ["POST", `/api/v1/assignments/${missingTemplateRecordId}/pdf`],
    ]) {
      const response = await request(base, method, path, { cookie: cookie(ordinaryA) });
      assert.equal(response.status, 409, `${path}: ${response.text}`);
      assert.match(response.data.error, /template version/i);
    }

    const noVersionRecordId = `asg_stage2_missing_version_${Date.now()}`;
    saveRecord({
      id: noVersionRecordId,
      status: "completed",
      userId: ordinaryA.id,
      input: { aim: "Explore subqueries in SQL" },
      template: { id: "tcet-computer-engineering" },
      content: stubContent(),
      options: {},
      createdAt: new Date().toISOString(),
    });
    const noVersion = await request(
      base,
      "GET",
      `/api/v1/assignments/${noVersionRecordId}/html`,
      { cookie: cookie(ordinaryA) },
    );
    assert.equal(noVersion.status, 409);
    assert.match(noVersion.data.error, /does not record a template version/i);
  });

  it("keeps college-admin management scoped to their own college", async () => {
    const own = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(collegeAdmin),
      body: {
        name: "Stage2 Version Admin Own",
        scope: "college",
        tenantId: "college-a",
        departmentId: "dept-a1",
      },
    });
    assert.equal(own.status, 201, JSON.stringify(own.data));

    const foreign = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(collegeAdmin),
      body: {
        name: "Stage2 Version Admin Foreign",
        scope: "college",
        tenantId: "college-b",
        departmentId: "dept-b1",
      },
    });
    assert.equal(foreign.status, 403, JSON.stringify(foreign.data));

    const ordinary = await request(base, "PUT", `/api/v1/templates/${own.data.template.id}`, {
      cookie: cookie(ordinaryB),
      body: { name: "Stage2 Version Admin Hijack" },
    });
    assert.equal(ordinary.status, 403, JSON.stringify(ordinary.data));
  });
});
