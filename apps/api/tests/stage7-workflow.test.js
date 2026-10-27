// STAGE 7 — complete multi-college assignment workflow over real HTTP + Mongo.
//
// This is the cross-stage regression that the narrower Stage 1-6 suites cannot
// provide on their own: one user journey through registration, preferences,
// branch-default template resolution, generation, the visual editor, all four
// exports, administrator publishing, ownership/college isolation, logout and a
// REAL API process restart.
//
// Production-like: AUTH_REQUIRED=1, real Express app, real MongoDB
// (`markly_stage7_workflow_test`, fail-closed name check, drop only that
// database), real cookie/session flow. Only the LLM and the TeX compiler are
// stubbed. PDF assertions are structural (the fake compiler records markers
// from the generated LaTeX); no claim of real PDF compilation or pixel-level
// visual comparison is made.

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage7-workflow-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import {
  connectStage7TestDb,
  disconnectStage7TestDb,
  stage7TestDbUri,
} from "./helpers/testDb.js";
import { cookieFor, request, startServer, stopServer } from "./helpers/stage2Http.js";

const { default: app } = await import("../src/index.js");
const { Assignment, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { assetsDir } = await import("../src/lib/storage.js");

const TEST_DB = "markly_stage7_workflow_test";
const PREFIX = "stage7-workflow";

const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;
const BRANCH_A2 = `${PREFIX}-branch-a2`;
const BRANCH_B1 = `${PREFIX}-branch-b1`;

const USER_A_EMAIL = "stage7-workflow-user-a@example.com";
const USER_A_PASSWORD = "stage7-password-a";
const USER_B_EMAIL = "stage7-workflow-user-b@example.com";
const USER_B_PASSWORD = "stage7-password-b";

const PLATFORM_ADMIN = {
  id: "usr_stage7_workflow_platform",
  email: "stage7-workflow-platform@example.com",
  name: "Stage 7 platform admin",
  role: "platform_admin",
};
const COLLEGE_ADMIN_A = {
  id: "usr_stage7_workflow_college_admin_a",
  email: "stage7-workflow-college-admin-a@example.com",
  name: "Stage 7 College A admin",
  role: "college_admin",
  collegeAdminOf: [COLLEGE_A],
};
const COLLEGE_ADMIN_B = {
  id: "usr_stage7_workflow_college_admin_b",
  email: "stage7-workflow-college-admin-b@example.com",
  name: "Stage 7 College B admin",
  role: "college_admin",
  collegeAdminOf: [COLLEGE_B],
};

const PLATFORM_COOKIE = cookieFor(PLATFORM_ADMIN);
const COLLEGE_ADMIN_A_COOKIE = cookieFor(COLLEGE_ADMIN_A);
const COLLEGE_ADMIN_B_COOKIE = cookieFor(COLLEGE_ADMIN_B);

const SERVER_HELPER = fileURLToPath(new URL("./helpers/stage7Server.mjs", import.meta.url));
const originalAiUrl = process.env.AI_SERVICE_URL;
const originalPdfCommand = process.env.PDF_COMPILE_CMD;
const originalPdfDocker = process.env.PDF_DOCKER;

let db;
let server;
let base;
let aiStub;
let pdfDir;
let freshApi = null;
const pdfArtifacts = new Set();

let userAId;
let userACookie;
let userBId;
let userBCookie;
let templateId;
let assignmentV1Id;
let assignmentV2Id;

function stubContent() {
  return {
    experimentNumber: 7,
    title: "STAGE7 WORKFLOW TITLE",
    aim: "STAGE7 ORIGINAL AIM",
    objectives: ["STAGE7 ORIGINAL OBJECTIVE"],
    theory: ["STAGE7 ORIGINAL THEORY PARAGRAPH"],
    steps: [
      {
        number: 1,
        title: "STAGE7 ORIGINAL STEP",
        description: ["STAGE7 ORIGINAL STEP DESCRIPTION"],
        code: "SELECT * FROM stage7_students;",
        language: "sql",
      },
    ],
    conclusion: "STAGE7 ORIGINAL CONCLUSION",
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
        return send(200, {
          content: stubContent(),
          sources: [],
          provider: "stub",
          model: "stage7-stub",
          promptVersion: "stage7",
          validation: { ok: true },
          researchProvider: "none",
        });
      }
      if (req.url === "/v1/regenerate-section" && req.method === "POST") {
        return send(200, { value: "STAGE7 REGENERATED VALUE" });
      }
      return send(404, { error: "stage7 stub: unknown route" });
    });
  });
}

function makeFakePdfTools() {
  const dir = mkdtempSync(join(tmpdir(), "stage7-pdf-"));
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
      "const markers = [...tex.matchAll(/STAGE7[A-Z0-9 _-]*/g)].map((m) => m[0].trim()).filter(Boolean);",
      'fs.writeFileSync(path.join(dir, "doc.pdf"), "%PDF-1.4\\n% " + (markers.join("|") || "NO_MARKER") + "\\n%%EOF\\n");',
      "",
    ].join("\n"),
  );
  process.env.PDF_DOCKER = `node "${docker}"`;
  process.env.PDF_COMPILE_CMD = `node "${compiler}" {dir}`;
  return dir;
}

function sessionCookie(response) {
  const raw = response.setCookies.find((entry) => entry.startsWith("markly_token="));
  assert.ok(raw, `expected a markly_token cookie, got ${JSON.stringify(response.setCookies)}`);
  return raw.split(";")[0];
}

function assertContains(haystack, marker, label) {
  assert.ok(haystack.includes(marker), `${label}: missing ${JSON.stringify(marker)}`);
}

function assertNotContains(haystack, marker, label) {
  assert.ok(!haystack.includes(marker), `${label}: unexpectedly contains ${JSON.stringify(marker)}`);
}

function assignmentPath(id, suffix = "") {
  return `/api/v1/assignments/${id}${suffix}`;
}

async function getDocument(id, cookie = userACookie) {
  return request(base, "GET", assignmentPath(id, "/document"), { cookie });
}

async function putDocument(id, body, cookie = userACookie) {
  return request(base, "PUT", assignmentPath(id, "/document"), { body, cookie });
}

async function pdfRequest(targetBase, id, cookie = userACookie) {
  pdfArtifacts.add(id);
  const res = await fetch(`${targetBase}${assignmentPath(id, "/pdf")}`, {
    method: "POST",
    headers: { cookie },
    signal: AbortSignal.timeout(30000),
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
    contentType: res.headers.get("content-type") ?? "",
    buffer,
    text,
    data,
  };
}

async function exportAll(id, cookie = userACookie) {
  return {
    html: await request(base, "GET", assignmentPath(id, "/html"), { cookie }),
    docx: await request(base, "GET", assignmentPath(id, "/docx"), { cookie }),
    latex: await request(base, "GET", assignmentPath(id, "/latex"), { cookie }),
    pdf: await pdfRequest(base, id, cookie),
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

function editedDocumentBlocks(document) {
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  for (const id of [
    "legacy-title",
    "legacy-experiment-number",
    "legacy-aim-heading",
    "legacy-aim",
    "legacy-conclusion-heading",
    "legacy-conclusion",
  ]) {
    assert.ok(byId.has(id), `legacy projection must contain ${id}`);
  }

  const title = byId.get("legacy-title");
  const experiment = byId.get("legacy-experiment-number");
  const aimHeading = byId.get("legacy-aim-heading");
  const aim = byId.get("legacy-aim");
  const conclusionHeading = byId.get("legacy-conclusion-heading");
  const conclusion = byId.get("legacy-conclusion");
  const moved = new Set([title, experiment, aimHeading, aim, conclusionHeading, conclusion]);

  return [
    title,
    { ...conclusionHeading, content: { text: "STAGE7 CONCLUSION HEADING" } },
    { ...conclusion, content: { text: "STAGE7 MOVED CONCLUSION BODY" } },
    {
      id: "stage7-added-block",
      type: "paragraph",
      content: { text: "STAGE7 ADDED BLOCK" },
      style: { align: "center", fontSize: 14 },
    },
    experiment,
    aimHeading,
    {
      ...aim,
      content: { text: "STAGE7 EDITED AIM" },
      style: {
        align: "justify",
        fontSize: 16,
        lineHeight: 1.7,
        spacingBefore: 10,
        spacingAfter: 12,
        indent: 18,
      },
    },
    ...document.blocks.filter((block) => !moved.has(block)),
  ];
}

function startFreshApi() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_HELPER], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTH_REQUIRED: "1",
        JWT_SECRET: process.env.JWT_SECRET,
        RATE_LIMIT_PER_MIN: "1000",
        MONGODB_URI: stage7TestDbUri(TEST_DB),
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`fresh API did not start within 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 60000);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/STAGE7_READY (\d+)/);
      if (match) {
        finish(resolve, { child, base: `http://127.0.0.1:${match[1]}`, stdout: () => stdout });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish(reject, err));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(
            `fresh API exited early with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
  });
}

async function stopFreshApi(handle = freshApi) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  const exited = new Promise((resolve) => handle.child.once("exit", resolve));
  try {
    handle.child.kill();
  } catch {
    /* ignore */
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (handle.child.exitCode === null) {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (handle === freshApi) freshApi = null;
}

before(async () => {
  db = await connectStage7TestDb(TEST_DB);
  await db.dropDatabase();

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage 7 College A" },
    { id: COLLEGE_B, name: "Stage 7 College B" },
  ]);
  await Department.create([
    { id: BRANCH_A1, tenantId: COLLEGE_A, name: "Stage 7 A Branch 1" },
    { id: BRANCH_A2, tenantId: COLLEGE_A, name: "Stage 7 A Branch 2" },
    { id: BRANCH_B1, tenantId: COLLEGE_B, name: "Stage 7 B Branch 1" },
  ]);
  await User.create([PLATFORM_ADMIN, COLLEGE_ADMIN_A, COLLEGE_ADMIN_B]);

  aiStub = startStubAi();
  await new Promise((resolve) => aiStub.listen(0, "127.0.0.1", resolve));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${aiStub.address().port}`;
  pdfDir = makeFakePdfTools();

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopFreshApi().catch(() => {});
  await stopServer(server).catch(() => {});
  server = null;

  if (aiStub) {
    try {
      aiStub.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => aiStub.close(resolve));
  }
  for (const id of pdfArtifacts) {
    const path = join(assetsDir, "generated", `assignment-${id}.pdf`);
    if (existsSync(path)) rmSync(path, { force: true });
  }
  if (pdfDir) rmSync(pdfDir, { recursive: true, force: true });
  await db?.dropDatabase().catch(() => {});
  await disconnectStage7TestDb();

  if (originalAiUrl === undefined) delete process.env.AI_SERVICE_URL;
  else process.env.AI_SERVICE_URL = originalAiUrl;
  if (originalPdfCommand === undefined) delete process.env.PDF_COMPILE_CMD;
  else process.env.PDF_COMPILE_CMD = originalPdfCommand;
  if (originalPdfDocker === undefined) delete process.env.PDF_DOCKER;
  else process.env.PDF_DOCKER = originalPdfDocker;
});

describe("STAGE 7 complete multi-college assignment workflow", () => {
  it("registers, saves college/branch preferences, and restores them after refresh and login", async () => {
    const registeredA = await request(base, "POST", "/api/v1/auth/register", {
      body: { email: USER_A_EMAIL, password: USER_A_PASSWORD, name: "Stage 7 User A" },
    });
    assert.equal(registeredA.status, 201, registeredA.text);
    assert.ok(registeredA.data.token);
    userACookie = sessionCookie(registeredA);

    const me = await request(base, "GET", "/api/v1/auth/me", { cookie: userACookie });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.user.email, USER_A_EMAIL);
    assert.equal(me.data.user.role, "user");
    assert.equal(me.data.user.preferences.collegeId, null);
    assert.equal(me.data.user.preferences.departmentId, null);
    userAId = me.data.user.sub;

    const options = await request(base, "GET", "/api/v1/preferences/options", {
      cookie: userACookie,
    });
    assert.equal(options.status, 200, options.text);
    const collegeA = options.data.colleges.find((college) => college.id === COLLEGE_A);
    assert.ok(collegeA, "college A must be offered");
    assert.ok(
      collegeA.branches.some((branch) => branch.id === BRANCH_A1),
      "branch A1 must be offered",
    );

    const saved = await request(base, "PUT", "/api/v1/preferences", {
      cookie: userACookie,
      body: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.setupCompleted, true);
    assert.equal(saved.data.preferences.collegeId, COLLEGE_A);
    assert.equal(saved.data.preferences.departmentId, BRANCH_A1);
    assert.equal(saved.data.college.id, COLLEGE_A);
    assert.equal(saved.data.branch.id, BRANCH_A1);

    // A browser refresh replays the same httpOnly cookie.
    const refreshed = await request(base, "GET", "/api/v1/preferences", {
      cookie: userACookie,
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(refreshed.data.preferences.collegeId, COLLEGE_A);
    assert.equal(refreshed.data.preferences.departmentId, BRANCH_A1);

    const meAfterRefresh = await request(base, "GET", "/api/v1/auth/me", {
      cookie: userACookie,
    });
    assert.equal(meAfterRefresh.status, 200);
    assert.equal(meAfterRefresh.data.user.preferences.collegeId, COLLEGE_A);
    assert.equal(meAfterRefresh.data.user.preferences.departmentId, BRANCH_A1);

    // A fresh login (new session) must read the persisted preference.
    const loggedIn = await request(base, "POST", "/api/v1/auth/login", {
      body: { email: USER_A_EMAIL, password: USER_A_PASSWORD },
    });
    assert.equal(loggedIn.status, 200, loggedIn.text);
    const loginCookie = sessionCookie(loggedIn);
    const afterLogin = await request(base, "GET", "/api/v1/preferences", {
      cookie: loginCookie,
    });
    assert.equal(afterLogin.status, 200, afterLogin.text);
    assert.equal(afterLogin.data.preferences.collegeId, COLLEGE_A);
    assert.equal(afterLogin.data.preferences.departmentId, BRANCH_A1);
    userACookie = loginCookie;

    // Invalid cross-college pairings are rejected, not silently saved.
    const mismatch = await request(base, "PUT", "/api/v1/preferences", {
      cookie: userACookie,
      body: { collegeId: COLLEGE_A, departmentId: BRANCH_B1 },
    });
    assert.equal(mismatch.status, 400, mismatch.text);
    assert.match(mismatch.data.error, /does not belong/i);

    const missingBranch = await request(base, "PUT", "/api/v1/preferences", {
      cookie: userACookie,
      body: { collegeId: COLLEGE_A, departmentId: null },
    });
    assert.equal(missingBranch.status, 400, missingBranch.text);

    // Register the second user for the isolation checks later in the journey.
    const registeredB = await request(base, "POST", "/api/v1/auth/register", {
      body: { email: USER_B_EMAIL, password: USER_B_PASSWORD, name: "Stage 7 User B" },
    });
    assert.equal(registeredB.status, 201, registeredB.text);
    userBCookie = sessionCookie(registeredB);
    const meB = await request(base, "GET", "/api/v1/auth/me", { cookie: userBCookie });
    assert.equal(meB.status, 200, meB.text);
    userBId = meB.data.user.sub;

    const savedB = await request(base, "PUT", "/api/v1/preferences", {
      cookie: userBCookie,
      body: { collegeId: COLLEGE_B, departmentId: BRANCH_B1 },
    });
    assert.equal(savedB.status, 200, savedB.text);
  });

  it("publishes a college template and pins the branch default version during generation", async () => {
    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: COLLEGE_ADMIN_A_COOKIE,
      body: {
        name: "Stage 7 College A Template",
        scope: "college",
        tenantId: COLLEGE_A,
        departmentId: BRANCH_A1,
        status: "active",
        page: {
          size: "A4",
          margin: { top: "30mm", right: "18mm", bottom: "20mm", left: "18mm" },
          border: { style: "solid", width: "2px", color: "#123456" },
        },
        typography: { fontFamily: "Georgia, serif", baseSize: "12pt", lineHeight: 1.5 },
        footer: { text: "STAGE7 V1 FOOTER", showPageNumber: true },
        facultyTable: {
          title: "STAGE7V1FACULTY",
          columns: ["Name", "Signature"],
          rows: [["", ""]],
        },
      },
    });
    assert.equal(created.status, 201, created.text);
    templateId = created.data.template.id;
    assert.equal(created.data.template.version, 1);
    assert.equal(created.data.template.scope, "college");
    assert.equal(created.data.template.tenantId, COLLEGE_A);
    assert.equal(created.data.template.departmentId, BRANCH_A1);
    assert.equal(created.data.template.status, "active");

    const defaultSet = await request(
      base,
      "PUT",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/default-template`,
      {
        cookie: COLLEGE_ADMIN_A_COOKIE,
        body: { templateId, templateVersion: 1 },
      },
    );
    assert.equal(defaultSet.status, 200, defaultSet.text);
    assert.equal(defaultSet.data.branch.defaultTemplateId, templateId);
    assert.equal(defaultSet.data.branch.defaultTemplateVersion, 1);

    const options = await request(base, "GET", "/api/v1/preferences/options", {
      cookie: userACookie,
    });
    assert.equal(options.status, 200, options.text);
    const branch = options.data.colleges
      .find((college) => college.id === COLLEGE_A)
      .branches.find((item) => item.id === BRANCH_A1);
    assert.equal(branch.defaultTemplateId, templateId);
    assert.equal(branch.defaultTemplateVersion, 1);
    assert.ok(
      branch.templates.some((template) => template.id === templateId && template.version === 1),
      "the branch catalogue must offer the configured v1 template",
    );

    const generated = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: userACookie,
      body: {
        aim: "STAGE7 WORKFLOW AIM",
        subject: "DBMS",
        experimentNumber: 7,
      },
    });
    assert.equal(generated.status, 200, generated.text);
    assignmentV1Id = generated.data.id;
    assert.equal(generated.data.template.id, templateId);
    assert.equal(generated.data.template.version, 1);
    assert.equal(generated.data.userId, userAId);
    assert.equal(generated.data.content.title, "STAGE7 WORKFLOW TITLE");

    const durable = await Assignment.findOne({ recordId: assignmentV1Id }).lean();
    assert.ok(durable, "generation must be durable before the response");
    assert.equal(durable.data.template.id, templateId);
    assert.equal(durable.data.template.version, 1);
    assert.equal(durable.data.document, undefined, "legacy projection must not be persisted on generation");
  });

  it("edits, reorders, formats, saves and reloads the document", async () => {
    const opened = await getDocument(assignmentV1Id);
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.data.document.revision, 0);
    assert.equal(opened.data.document.schemaVersion, 2);

    const blocks = editedDocumentBlocks(opened.data.document);
    const saved = await putDocument(assignmentV1Id, { revision: 0, blocks });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.document.revision, 1);
    assert.deepEqual(
      saved.data.document.blocks.map((block) => block.id),
      blocks.map((block) => block.id),
      "saved block order must be returned exactly",
    );

    const reloaded = await getDocument(assignmentV1Id);
    assert.equal(reloaded.status, 200, reloaded.text);
    assert.equal(reloaded.data.document.revision, 1);
    assert.deepEqual(reloaded.data.document.blocks, saved.data.document.blocks);

    const editedAim = reloaded.data.document.blocks.find((block) => block.id === "legacy-aim");
    assert.equal(editedAim.content.text, "STAGE7 EDITED AIM");
    assert.deepEqual(editedAim.style, {
      align: "justify",
      fontSize: 16,
      lineHeight: 1.7,
      spacingBefore: 10,
      spacingAfter: 12,
      indent: 18,
    });
    const added = reloaded.data.document.blocks.find(
      (block) => block.id === "stage7-added-block",
    );
    assert.equal(added.content.text, "STAGE7 ADDED BLOCK");
    assert.deepEqual(added.style, { align: "center", fontSize: 14 });

    const detail = await request(base, "GET", assignmentPath(assignmentV1Id), {
      cookie: userACookie,
    });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.data.documentRevision, 1);
    assert.deepEqual(detail.data.document.blocks, reloaded.data.document.blocks);
    assert.equal(detail.data.template.version, 1);

    const stale = await putDocument(assignmentV1Id, { revision: 0, blocks });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.data.code, "document_conflict");
    assert.equal(stale.data.revision, 1);

    const durable = await Assignment.findOne({ recordId: assignmentV1Id }).lean();
    assert.equal(durable.documentRevision, 1);
    assert.equal(durable.document.revision, 1);
    assert.equal(
      durable.document.blocks.find((block) => block.id === "legacy-aim").content.text,
      "STAGE7 EDITED AIM",
    );
  });

  it("publishes v2, repoints the branch default, and keeps the old assignment pinned to v1 in every export", async () => {
    const updated = await request(base, "PUT", `/api/v1/templates/${templateId}`, {
      cookie: COLLEGE_ADMIN_A_COOKIE,
      body: {
        footer: { text: "STAGE7 V2 FOOTER", showPageNumber: true },
        facultyTable: {
          title: "STAGE7V2FACULTY",
          columns: ["Name", "Signature"],
          rows: [["", ""]],
        },
      },
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.data.template.id, templateId);
    assert.equal(updated.data.template.version, 2);
    assert.equal(updated.data.template.status, "active");

    const v1 = await Template.findOne({ id: templateId, version: 1 }).lean();
    const v2 = await Template.findOne({ id: templateId, version: 2 }).lean();
    assert.ok(v1 && v2, "both immutable versions must be durable");
    assert.equal(v1.footer.text, "STAGE7 V1 FOOTER");
    assert.equal(v2.footer.text, "STAGE7 V2 FOOTER");

    const versions = await request(base, "GET", `/api/v1/templates/${templateId}/versions`, {
      cookie: COLLEGE_ADMIN_A_COOKIE,
    });
    assert.equal(versions.status, 200, versions.text);
    assert.deepEqual(
      versions.data.versions.map((entry) => entry.version),
      [1, 2],
    );

    const repointed = await request(
      base,
      "PUT",
      `/api/v1/admin/colleges/${COLLEGE_A}/branches/${BRANCH_A1}/default-template`,
      {
        cookie: COLLEGE_ADMIN_A_COOKIE,
        body: { templateId, templateVersion: 2 },
      },
    );
    assert.equal(repointed.status, 200, repointed.text);
    assert.equal(repointed.data.branch.defaultTemplateVersion, 2);

    // The existing assignment keeps its snapshot and its exact v1 export.
    const pinned = await request(base, "GET", assignmentPath(assignmentV1Id), {
      cookie: userACookie,
    });
    assert.equal(pinned.status, 200, pinned.text);
    assert.equal(pinned.data.template.version, 1);

    const exported = await exportAll(assignmentV1Id);
    assert.equal(exported.html.status, 200, exported.html.text);
    assert.equal(exported.docx.status, 200, exported.docx.text);
    assert.equal(exported.latex.status, 200, exported.latex.text);
    assert.equal(exported.pdf.status, 200, exported.pdf.text);

    // HTML: saved content/order, explicit layout styles and v1 template geometry.
    for (const marker of [
      "STAGE7 EDITED AIM",
      "STAGE7 MOVED CONCLUSION BODY",
      "STAGE7 ADDED BLOCK",
      "STAGE7 V1 FOOTER",
      "STAGE7V1FACULTY",
    ]) {
      assertContains(exported.html.text, marker, "HTML v1");
    }
    for (const marker of ["STAGE7 V2 FOOTER", "STAGE7V2FACULTY", "STAGE7 ORIGINAL AIM"]) {
      assertNotContains(exported.html.text, marker, "HTML v1");
    }
    assert.ok(
      exported.html.text.indexOf("STAGE7 MOVED CONCLUSION BODY") <
        exported.html.text.indexOf("STAGE7 EDITED AIM"),
      "HTML must preserve the reordered block sequence",
    );
    assertContains(
      exported.html.text,
      'style="text-align: justify; font-size: 16px; line-height: 1.7; margin-top: 10px; margin-bottom: 12px; margin-left: 18px"',
      "HTML block formatting",
    );
    assertContains(
      exported.html.text,
      'style="text-align: center; font-size: 14px"',
      "HTML added block formatting",
    );
    assertContains(exported.html.text, "padding: 30mm 18mm 20mm 18mm", "HTML page margins");
    assertContains(exported.html.text, "#123456", "HTML page border");

    // DOCX: same body order/styles plus the v1 footer and faculty table.
    const docx = await docxParts(exported.docx);
    const docxText = [docx.documentXml, docx.headerXml, docx.footerXml].join("\n");
    for (const marker of [
      "STAGE7 EDITED AIM",
      "STAGE7 MOVED CONCLUSION BODY",
      "STAGE7 ADDED BLOCK",
      "STAGE7V1FACULTY",
      "STAGE7 V1 FOOTER",
    ]) {
      assertContains(docxText, marker, "DOCX v1");
    }
    for (const marker of ["STAGE7 V2 FOOTER", "STAGE7V2FACULTY", "STAGE7 ORIGINAL AIM"]) {
      assertNotContains(docxText, marker, "DOCX v1");
    }
    assert.ok(
      docx.documentXml.indexOf("STAGE7 MOVED CONCLUSION BODY") <
        docx.documentXml.indexOf("STAGE7 EDITED AIM"),
      "DOCX must preserve the reordered block sequence",
    );
    assertContains(docx.documentXml, 'w:jc w:val="both"', "DOCX justify alignment");
    assertContains(docx.documentXml, 'w:sz w:val="24"', "DOCX 16px/12pt font size");
    assertContains(docx.documentXml, 'w:line="408"', "DOCX 1.7 line height");
    assertContains(docx.documentXml, 'w:before="150"', "DOCX spacing before");
    assertContains(docx.documentXml, 'w:after="180"', "DOCX spacing after");
    assertContains(docx.documentXml, 'w:left="270"', "DOCX indent");
    assertContains(docx.documentXml, 'w:pgSz w:w="11906" w:h="16838"', "DOCX page size");
    assertContains(docx.documentXml, 'w:color="123456"', "DOCX page border");

    // LaTeX: same body order/styles and the v1 template identity.
    const latex = exported.latex.data;
    assert.equal(latex.source, "generated");
    assert.equal(latex.template.id, templateId);
    assert.equal(latex.template.version, 1);
    for (const marker of [
      "STAGE7 EDITED AIM",
      "STAGE7 MOVED CONCLUSION BODY",
      "STAGE7 ADDED BLOCK",
      "STAGE7V1FACULTY",
      "STAGE7 V1 FOOTER",
    ]) {
      assertContains(latex.latex, marker, "LaTeX v1");
    }
    for (const marker of ["STAGE7 V2 FOOTER", "STAGE7V2FACULTY", "STAGE7 ORIGINAL AIM"]) {
      assertNotContains(latex.latex, marker, "LaTeX v1");
    }
    assert.ok(
      latex.latex.indexOf("STAGE7 MOVED CONCLUSION BODY") <
        latex.latex.indexOf("STAGE7 EDITED AIM"),
      "LaTeX must preserve the reordered block sequence",
    );
    assertContains(latex.latex, "\\fontsize{12pt}{20.4pt}\\selectfont", "LaTeX font size");
    assertContains(latex.latex, "\\vspace*{7.5pt}", "LaTeX spacing before");
    assertContains(latex.latex, "\\vspace{9pt}", "LaTeX spacing after");
    assertContains(latex.latex, "\\begin{adjustwidth}{13.5pt}{0pt}", "LaTeX indent");
    assertContains(latex.latex, "\\fancyfoot[C]{STAGE7 V1 FOOTER\\quad\\thepage}", "LaTeX footer");
    assertContains(latex.latex, "\\definecolor{docborder}{HTML}{123456}", "LaTeX border");

    // PDF: the fake compiler proves which exact LaTeX source was sent. This is
    // structural verification, not real TeX compilation.
    assert.match(exported.pdf.contentType, /application\/pdf/);
    assert.equal(exported.pdf.headers["x-markly-latex-source"], "generated");
    const pdfText = exported.pdf.buffer.toString("utf8");
    assert.match(pdfText, /^%PDF-1\.4/);
    for (const marker of [
      "STAGE7 EDITED AIM",
      "STAGE7 MOVED CONCLUSION BODY",
      "STAGE7 ADDED BLOCK",
      "STAGE7V1FACULTY",
      "STAGE7 V1 FOOTER",
    ]) {
      assertContains(pdfText, marker, "PDF v1");
    }
    for (const marker of ["STAGE7 V2 FOOTER", "STAGE7V2FACULTY", "STAGE7 ORIGINAL AIM"]) {
      assertNotContains(pdfText, marker, "PDF v1");
    }
    assert.ok(
      pdfText.indexOf("STAGE7 MOVED CONCLUSION BODY") <
        pdfText.indexOf("STAGE7 EDITED AIM"),
      "PDF source must preserve the reordered block sequence",
    );

    // New generations use the new branch default; the old record is unchanged.
    const regenerated = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: userACookie,
      body: { aim: "STAGE7 WORKFLOW AIM V2", subject: "DBMS", experimentNumber: 8 },
    });
    assert.equal(regenerated.status, 200, regenerated.text);
    assignmentV2Id = regenerated.data.id;
    assert.equal(regenerated.data.template.id, templateId);
    assert.equal(regenerated.data.template.version, 2);

    const v2Html = await request(base, "GET", assignmentPath(assignmentV2Id, "/html"), {
      cookie: userACookie,
    });
    assert.equal(v2Html.status, 200, v2Html.text);
    assertContains(v2Html.text, "STAGE7 V2 FOOTER", "HTML v2");
    assertContains(v2Html.text, "STAGE7V2FACULTY", "HTML v2");
    assertNotContains(v2Html.text, "STAGE7 V1 FOOTER", "HTML v2");

    const stillPinned = await request(base, "GET", assignmentPath(assignmentV1Id), {
      cookie: userACookie,
    });
    assert.equal(stillPinned.data.template.version, 1);
  });

  it("isolates private assignments/templates across users and administrative resources across colleges", async () => {
    const privateTemplate = await request(base, "POST", "/api/v1/templates", {
      cookie: userBCookie,
      body: {
        name: "Stage 7 User B Private Template",
        footer: { text: "STAGE7 B PRIVATE FOOTER" },
      },
    });
    assert.equal(privateTemplate.status, 201, privateTemplate.text);
    const privateId = privateTemplate.data.template.id;
    assert.equal(privateTemplate.data.template.scope, "private");
    assert.equal(privateTemplate.data.template.ownerUserId, userBId);

    const ownerRead = await request(base, "GET", `/api/v1/templates/${privateId}`, {
      cookie: userBCookie,
    });
    assert.equal(ownerRead.status, 200, ownerRead.text);

    const otherRead = await request(base, "GET", `/api/v1/templates/${privateId}`, {
      cookie: userACookie,
    });
    assert.equal(otherRead.status, 404, otherRead.text);

    const otherUse = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: userACookie,
      body: { aim: "STAGE7 PRIVATE TEMPLATE ATTEMPT", subject: "DBMS", templateId: privateId },
    });
    assert.equal(otherUse.status, 404, otherUse.text);

    const catalogue = await request(base, "GET", "/api/v1/templates", {
      cookie: userACookie,
    });
    assert.equal(catalogue.status, 200, catalogue.text);
    assert.ok(
      !catalogue.data.templates.some((template) => template.id === privateId),
      "another user's private template must not appear in the catalogue",
    );

    // Cross-user assignment isolation covers every read/write/export route.
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["GET", "/document", undefined],
      ["GET", "/html", undefined],
      ["GET", "/docx", undefined],
      ["GET", "/latex", undefined],
      ["PUT", "/document", { revision: 1, blocks: [] }],
      ["POST", "/pdf", undefined],
      ["DELETE", "", undefined],
    ]) {
      const denied = await request(base, method, assignmentPath(assignmentV1Id, suffix), {
        cookie: userBCookie,
        body,
      });
      assert.equal(denied.status, 404, `${method} ${suffix}: ${denied.text}`);
    }

    const listB = await request(base, "GET", "/api/v1/assignments", {
      cookie: userBCookie,
    });
    assert.equal(listB.status, 200, listB.text);
    assert.ok(
      !listB.data.assignments.some((assignment) => assignment.id === assignmentV1Id),
      "another user's assignment must not appear in the list",
    );

    const listA = await request(base, "GET", "/api/v1/assignments", {
      cookie: userACookie,
    });
    assert.equal(listA.status, 200, listA.text);
    assert.ok(listA.data.assignments.some((assignment) => assignment.id === assignmentV1Id));
    assert.ok(listA.data.assignments.some((assignment) => assignment.id === assignmentV2Id));

    // Cross-college template access is indistinguishable from not-found.
    const crossCollegeTemplate = await request(
      base,
      "GET",
      `/api/v1/templates/${templateId}`,
      { cookie: userBCookie },
    );
    assert.equal(crossCollegeTemplate.status, 404, crossCollegeTemplate.text);

    const crossCollegeGenerate = await request(base, "POST", "/api/v1/assignments/generate", {
      cookie: userBCookie,
      body: { aim: "STAGE7 CROSS COLLEGE ATTEMPT", subject: "DBMS", templateId },
    });
    assert.equal(crossCollegeGenerate.status, 404, crossCollegeGenerate.text);

    // College administrators are confined to their own college.
    for (const [method, path, body] of [
      ["GET", `/api/v1/admin/colleges/${COLLEGE_B}`, undefined],
      ["GET", `/api/v1/admin/colleges/${COLLEGE_B}/branches`, undefined],
      ["GET", `/api/v1/admin/colleges/${COLLEGE_B}/branches/${BRANCH_B1}/templates`, undefined],
      [
        "PUT",
        `/api/v1/admin/colleges/${COLLEGE_B}/branches/${BRANCH_B1}/default-template`,
        { templateId, templateVersion: 2 },
      ],
    ]) {
      const denied = await request(base, method, path, {
        cookie: COLLEGE_ADMIN_A_COOKIE,
        body,
      });
      assert.equal(denied.status, 403, `${method} ${path}: ${denied.text}`);
    }

    const reverseDenied = await request(
      base,
      "GET",
      `/api/v1/admin/colleges/${COLLEGE_A}`,
      { cookie: COLLEGE_ADMIN_B_COOKIE },
    );
    assert.equal(reverseDenied.status, 403, reverseDenied.text);

    const collegesA = await request(base, "GET", "/api/v1/admin/colleges", {
      cookie: COLLEGE_ADMIN_A_COOKIE,
    });
    assert.equal(collegesA.status, 200, collegesA.text);
    assert.deepEqual(
      collegesA.data.colleges.map((college) => college.id),
      [COLLEGE_A],
      "a college admin catalogue must only contain their college",
    );

    const dashboardA = await request(base, "GET", "/api/v1/admin/dashboard", {
      cookie: COLLEGE_ADMIN_A_COOKIE,
    });
    assert.equal(dashboardA.status, 200, dashboardA.text);
    assert.equal(dashboardA.data.stats.colleges, 1);

    const collegesPlatform = await request(base, "GET", "/api/v1/admin/colleges", {
      cookie: PLATFORM_COOKIE,
    });
    assert.equal(collegesPlatform.status, 200, collegesPlatform.text);
    const platformCollegeIds = collegesPlatform.data.colleges.map((college) => college.id);
    assert.ok(platformCollegeIds.includes(COLLEGE_A));
    assert.ok(platformCollegeIds.includes(COLLEGE_B));

    const ordinaryAdminAttempt = await request(base, "GET", "/api/v1/admin/dashboard", {
      cookie: userACookie,
    });
    assert.equal(ordinaryAdminAttempt.status, 403, ordinaryAdminAttempt.text);
  });

  it("clears the cookie on logout, rejects unauthorized requests, and restores the session on login", async () => {
    const logout = await request(base, "POST", "/api/v1/auth/logout", {
      cookie: userACookie,
    });
    assert.equal(logout.status, 200, logout.text);
    const cleared = logout.setCookies.find((entry) => entry.startsWith("markly_token="));
    assert.ok(cleared, "logout must send a clearing cookie");
    assert.match(cleared, /^markly_token=;/);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);

    // A browser that applied the clearing cookie sends no session at all.
    for (const [method, path, body] of [
      ["GET", "/api/v1/assignments", undefined],
      ["GET", "/api/v1/preferences", undefined],
      ["GET", "/api/v1/templates", undefined],
      ["GET", "/api/v1/admin/dashboard", undefined],
      ["GET", assignmentPath(assignmentV1Id, "/html"), undefined],
      ["POST", "/api/v1/assignments/generate", { aim: "STAGE7 ANON ATTEMPT", subject: "DBMS" }],
    ]) {
      const denied = await request(base, method, path, { body });
      assert.equal(denied.status, 401, `${method} ${path}: ${denied.text}`);
    }

    const invalidToken = await request(base, "GET", "/api/v1/assignments", {
      cookie: "markly_token=not-a-valid-jwt",
    });
    assert.equal(invalidToken.status, 401, invalidToken.text);

    const restored = await request(base, "POST", "/api/v1/auth/login", {
      body: { email: USER_A_EMAIL, password: USER_A_PASSWORD },
    });
    assert.equal(restored.status, 200, restored.text);
    userACookie = sessionCookie(restored);

    const me = await request(base, "GET", "/api/v1/auth/me", { cookie: userACookie });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.user.email, USER_A_EMAIL);
    assert.equal(me.data.user.preferences.collegeId, COLLEGE_A);
    assert.equal(me.data.user.preferences.departmentId, BRANCH_A1);

    const preferences = await request(base, "GET", "/api/v1/preferences", {
      cookie: userACookie,
    });
    assert.equal(preferences.status, 200, preferences.text);
    assert.equal(preferences.data.preferences.collegeId, COLLEGE_A);
    assert.equal(preferences.data.preferences.departmentId, BRANCH_A1);
    assert.equal(preferences.data.branch.defaultTemplateVersion, 2);

    const assignments = await request(base, "GET", "/api/v1/assignments", {
      cookie: userACookie,
    });
    assert.equal(assignments.status, 200, assignments.text);
    assert.ok(assignments.data.assignments.some((item) => item.id === assignmentV1Id));
    assert.ok(assignments.data.assignments.some((item) => item.id === assignmentV2Id));
  });

  it("serves users, preferences, template versions and assignments after a real API process restart", async () => {
    await stopServer(server);
    server = null;

    freshApi = await startFreshApi();
    const freshBase = freshApi.base;

    const health = await request(freshBase, "GET", "/api/v1/health");
    assert.equal(health.status, 200, health.text);

    // 1. Users: the password hash and identity survive, so a cold process can
    // authenticate the same account.
    const login = await request(freshBase, "POST", "/api/v1/auth/login", {
      body: { email: USER_A_EMAIL, password: USER_A_PASSWORD },
    });
    assert.equal(login.status, 200, login.text);
    const cookie = sessionCookie(login);

    const me = await request(freshBase, "GET", "/api/v1/auth/me", { cookie });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.user.sub, userAId);
    assert.equal(me.data.user.email, USER_A_EMAIL);

    // 2. Preferences: college/branch and the v2 default are reloaded.
    const preferences = await request(freshBase, "GET", "/api/v1/preferences", {
      cookie,
    });
    assert.equal(preferences.status, 200, preferences.text);
    assert.equal(preferences.data.preferences.collegeId, COLLEGE_A);
    assert.equal(preferences.data.preferences.departmentId, BRANCH_A1);
    assert.equal(preferences.data.branch.defaultTemplateId, templateId);
    assert.equal(preferences.data.branch.defaultTemplateVersion, 2);

    // 3. Templates: the latest version and both immutable history rows exist.
    const latestTemplate = await request(freshBase, "GET", `/api/v1/templates/${templateId}`, {
      cookie,
    });
    assert.equal(latestTemplate.status, 200, latestTemplate.text);
    assert.equal(latestTemplate.data.template.version, 2);

    const versions = await request(
      freshBase,
      "GET",
      `/api/v1/templates/${templateId}/versions`,
      { cookie: COLLEGE_ADMIN_A_COOKIE },
    );
    assert.equal(versions.status, 200, versions.text);
    assert.deepEqual(
      versions.data.versions.map((entry) => entry.version),
      [1, 2],
    );

    // 4. Assignments: both records, their pinned versions and the saved block
    // revision survive. The old assignment still exports its exact v1.
    const assignments = await request(freshBase, "GET", "/api/v1/assignments", {
      cookie,
    });
    assert.equal(assignments.status, 200, assignments.text);
    assert.ok(assignments.data.assignments.some((item) => item.id === assignmentV1Id));
    assert.ok(assignments.data.assignments.some((item) => item.id === assignmentV2Id));

    const oldAssignment = await request(freshBase, "GET", assignmentPath(assignmentV1Id), {
      cookie,
    });
    assert.equal(oldAssignment.status, 200, oldAssignment.text);
    assert.equal(oldAssignment.data.template.id, templateId);
    assert.equal(oldAssignment.data.template.version, 1);
    assert.equal(oldAssignment.data.documentRevision, 1);
    const aim = oldAssignment.data.document.blocks.find((block) => block.id === "legacy-aim");
    assert.equal(aim.content.text, "STAGE7 EDITED AIM");
    assert.equal(aim.style.align, "justify");

    const newAssignment = await request(freshBase, "GET", assignmentPath(assignmentV2Id), {
      cookie,
    });
    assert.equal(newAssignment.status, 200, newAssignment.text);
    assert.equal(newAssignment.data.template.version, 2);

    const html = await request(freshBase, "GET", assignmentPath(assignmentV1Id, "/html"), {
      cookie,
    });
    assert.equal(html.status, 200, html.text);
    assertContains(html.text, "STAGE7 EDITED AIM", "restart HTML");
    assertContains(html.text, "STAGE7 V1 FOOTER", "restart HTML");
    assertNotContains(html.text, "STAGE7 V2 FOOTER", "restart HTML");

    const latex = await request(freshBase, "GET", assignmentPath(assignmentV1Id, "/latex"), {
      cookie,
    });
    assert.equal(latex.status, 200, latex.text);
    assert.equal(latex.data.template.version, 1);
    assertContains(latex.data.latex, "STAGE7 MOVED CONCLUSION BODY", "restart LaTeX");

    const pdf = await pdfRequest(freshBase, assignmentV1Id, cookie);
    assert.equal(pdf.status, 200, pdf.text);
    const pdfText = pdf.buffer.toString("utf8");
    assertContains(pdfText, "STAGE7V1FACULTY", "restart PDF");
    assertNotContains(pdfText, "STAGE7V2FACULTY", "restart PDF");

    await stopFreshApi();
  });
});
