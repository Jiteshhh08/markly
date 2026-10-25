// STAGE 5 — visual document editor API + persistence.
//
// The document body is the ordered `document.blocks` array. Academic
// `content` remains the AI/section-regeneration contract. These tests use a
// dedicated isolated test database (`markly_stage5_document_editor_test`),
// seeded records, real HTTP requests and the real Mongo-backed assignment
// store. The restart case imports a fresh copy of the store module (empty
// in-memory Map) and reads the durable copy — the same convention used by the
// existing Stage 2/4 restart regression.

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage5-document-editor-test-secret-0123456789";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { connectStage5TestDb, disconnectStage5TestDb } from "./helpers/testDb.js";
import { cookieFor, request, startServer, stopServer } from "./helpers/stage2Http.js";
import {
  createBlock,
  deleteBlock,
  duplicateBlock,
  insertBlockAt,
  moveBlock,
  updateBlockContent,
} from "../../../src/features/studio/documentEditor.js";

const { default: app } = await import("../src/index.js");
const { saveRecord, persistWithWarning } = await import("../src/lib/assignmentStore.js");
const { Assignment } = await import("../src/models/index.js");

const TEST_DB = "markly_stage5_document_editor_test";
const USER_A = "stage5-user-a";
const USER_B = "stage5-user-b";
const TEMPLATE_ID = "tpl_stage5_editor";

const COOKIE_A = cookieFor({ id: USER_A, email: `${USER_A}@example.com` });
const COOKIE_B = cookieFor({ id: USER_B, email: `${USER_B}@example.com` });

function validContent(overrides = {}) {
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
        code: "SELECT *\n  FROM students\n  WHERE marks > 80;",
        language: "sql",
      },
    ],
    conclusion: "Subqueries let us compose complex filters from simple parts.",
    metadata: {},
    ...overrides,
  };
}

function templateSnapshot() {
  return {
    id: TEMPLATE_ID,
    version: 1,
    name: "Stage 5 Editor Template",
    scope: "platform",
    collegeId: null,
    branchId: null,
  };
}

let seq = 0;
function nextId(label) {
  seq += 1;
  return `asg_stage5_${label}_${Date.now()}_${seq}`;
}

async function seedAssignment({
  id = nextId("doc"),
  userId = USER_A,
  content = validContent(),
  document = null,
} = {}) {
  const now = new Date().toISOString();
  const record = {
    id,
    userId,
    status: "completed",
    input: { aim: content.aim, subject: "DBMS" },
    content,
    options: { includeVivaTitle: false, typedConclusion: true },
    template: templateSnapshot(),
    createdAt: now,
    updatedAt: now,
  };
  if (document) {
    record.document = document;
    record.documentSchemaVersion = document.schemaVersion ?? 2;
    record.documentRevision = document.revision;
  }
  saveRecord(record);
  const durable = await persistWithWarning(record, "stage5 test seed");
  assert.equal(durable, true, "the Stage 5 test database must be reachable");
  return record;
}

function documentPath(id) {
  return `/api/v1/assignments/${id}/document`;
}

function getDocument(id, cookie = COOKIE_A) {
  return request(base, "GET", documentPath(id), { cookie });
}

function putDocument(id, body, cookie = COOKIE_A) {
  return request(base, "PUT", documentPath(id), { body, cookie });
}

function getAssignment(id, cookie = COOKIE_A) {
  return request(base, "GET", `/api/v1/assignments/${id}`, { cookie });
}

async function storedAssignment(id) {
  return Assignment.findOne({ recordId: id }).lean();
}

function blockById(blocks, id) {
  return blocks.find((block) => block.id === id);
}

function blockIds(blocks) {
  return blocks.map((block) => block.id);
}

let server;
let base;
let aiStub;
let previousAiUrl;

before(async () => {
  await connectStage5TestDb(TEST_DB);
  await (await import("mongoose")).default.connection.db.dropDatabase();

  aiStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/regenerate-section" && req.method === "POST") {
        return send(200, {
          value: ["Regenerated theory explains nested query planning in detail."],
        });
      }
      return send(404, { error: "stage5 stub: unknown route" });
    });
  });
  await new Promise((resolve) => aiStub.listen(0, "127.0.0.1", resolve));
  previousAiUrl = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${aiStub.address().port}`;

  const started = await startServer(app);
  server = started.server;
  base = started.base;
});

after(async () => {
  if (previousAiUrl === undefined) delete process.env.AI_SERVICE_URL;
  else process.env.AI_SERVICE_URL = previousAiUrl;
  await stopServer(server).catch(() => {});
  if (aiStub) {
    try {
      aiStub.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => aiStub.close(resolve));
  }
  await disconnectStage5TestDb();
});

describe("STAGE 5 legacy document projection", () => {
  it("opens a legacy assignment without rewriting content or persisting blocks", async () => {
    const content = validContent();
    const id = nextId("legacy");
    await seedAssignment({ id, content });

    const res = await getDocument(id);
    assert.equal(res.status, 200);
    const doc = res.data.document;
    assert.equal(doc.schemaVersion, 2);
    assert.equal(doc.revision, 0);
    assert.equal(doc.normalization.missingBlocks, true);
    assert.deepEqual(doc.content, content, "academic content must survive the read projection");
    assert.ok(doc.blocks.length > 0);
    assert.equal(new Set(blockIds(doc.blocks)).size, doc.blocks.length, "block ids must be unique");

    const code = doc.blocks.find((block) => block.type === "code");
    assert.ok(code, "legacy step code should be projected into a code block");
    assert.equal(code.content.text, content.steps[0].code);
    assert.equal(code.content.language, "sql");

    const stored = await storedAssignment(id);
    assert.equal(stored.data.document, undefined, "reading a legacy assignment must not persist blocks");
    assert.equal(stored.data.documentRevision, undefined);
    assert.equal(stored.documentRevision, undefined);
    assert.equal(stored.document, undefined);
    assert.deepEqual(stored.data.content, content, "historical content must remain untouched");

    const assignment = await getAssignment(id);
    assert.equal(assignment.status, 200);
    assert.deepEqual(assignment.data.content, content);
  });
});

describe("STAGE 5 save/reload", () => {
  it("saves text and heading edits and reloads them from the durable record", async () => {
    const id = nextId("text");
    await seedAssignment({ id });

    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const blocks = first.data.document.blocks.map((block) => {
      if (block.id === "legacy-title") {
        return { ...block, content: { text: "Edited SQL subquery title" } };
      }
      if (block.id === "legacy-aim-heading") {
        return { ...block, content: { text: "Aim and scope" } };
      }
      return block;
    });

    const saved = await putDocument(id, {
      revision: first.data.document.revision,
      schemaVersion: 2,
      blocks,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.document.revision, 1);
    assert.equal(blockById(saved.data.document.blocks, "legacy-title").content.text, "Edited SQL subquery title");
    assert.equal(blockById(saved.data.document.blocks, "legacy-aim-heading").content.text, "Aim and scope");

    const reloaded = await getDocument(id);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.data.document.revision, 1);
    assert.equal(blockById(reloaded.data.document.blocks, "legacy-title").content.text, "Edited SQL subquery title");
    assert.equal(blockById(reloaded.data.document.blocks, "legacy-aim-heading").content.text, "Aim and scope");

    const stored = await storedAssignment(id);
    assert.equal(stored.data.document.revision, 1);
    assert.equal(blockById(stored.data.document.blocks, "legacy-title").content.text, "Edited SQL subquery title");
    assert.equal(stored.documentRevision, 1);
    assert.equal(stored.documentSchemaVersion, 2);
    assert.deepEqual(stored.document, stored.data.document);
    assert.deepEqual(stored.data.content, first.data.document.content, "saving blocks must not rewrite academic content");
  });

  it("persists insert, delete, duplicate and reorder operations", async () => {
    const id = nextId("ops");
    await seedAssignment({ id });

    const first = await getDocument(id);
    assert.equal(first.status, 200);
    let blocks = first.data.document.blocks;

    const manual = createBlock("paragraph", {
      id: "blk_stage5_manual_insert",
      text: "Manual inserted paragraph",
    });
    blocks = insertBlockAt(blocks, manual, 1);
    const duplicated = duplicateBlock(blocks, "legacy-title");
    assert.ok(duplicated.block);
    blocks = duplicated.blocks;
    const duplicateId = duplicated.block.id;
    assert.equal(blockById(blocks, duplicateId).source, undefined, "a manual duplicate must not keep generated provenance");
    blocks = deleteBlock(blocks, "legacy-objectives");
    blocks = moveBlock(blocks, duplicateId, 1);

    const saved = await putDocument(id, {
      revision: first.data.document.revision,
      schemaVersion: 2,
      blocks,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.document.revision, 1);

    const reloaded = await getDocument(id);
    assert.equal(reloaded.status, 200);
    const reloadedIds = blockIds(reloaded.data.document.blocks);
    assert.ok(reloadedIds.includes("blk_stage5_manual_insert"));
    assert.ok(reloadedIds.includes(duplicateId));
    assert.equal(reloadedIds.includes("legacy-objectives"), false);
    assert.equal(
      reloadedIds.indexOf(duplicateId),
      reloadedIds.indexOf("legacy-title") + 2,
      "the duplicate should remain reordered in the persisted body",
    );

    const stored = await storedAssignment(id);
    assert.deepEqual(blockIds(stored.data.document.blocks), reloadedIds);
  });

  it("preserves multiline code line breaks and indentation exactly", async () => {
    const id = nextId("code");
    await seedAssignment({ id });

    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const legacyCode = first.data.document.blocks.find((block) => block.id === "legacy-step-1-code");
    assert.ok(legacyCode);
    assert.equal(legacyCode.content.text, "SELECT *\n  FROM students\n  WHERE marks > 80;");

    const multiline = "function solve(input) {\n\tif (!input) {\n\t\treturn null;\n\t}\n\treturn input;\n}";
    let blocks = insertBlockAt(
      first.data.document.blocks,
      createBlock("code", { id: "blk_stage5_code", text: multiline }),
      0,
    );
    blocks = updateBlockContent(blocks, "blk_stage5_code", { language: "javascript" });

    const saved = await putDocument(id, {
      revision: first.data.document.revision,
      schemaVersion: 2,
      blocks,
    });
    assert.equal(saved.status, 200);

    const reloaded = await getDocument(id);
    const code = blockById(reloaded.data.document.blocks, "blk_stage5_code");
    assert.equal(code.content.text, multiline);
    assert.equal(code.content.language, "javascript");
    assert.equal(blockById(reloaded.data.document.blocks, "legacy-step-1-code").content.text, legacyCode.content.text);

    const stored = await storedAssignment(id);
    assert.equal(blockById(stored.data.document.blocks, "blk_stage5_code").content.text, multiline);
  });
});

describe("STAGE 5 validation and authorization", () => {
  it("rejects invalid block types, unsupported styles and duplicate ids without changing the document", async () => {
    const id = nextId("invalid");
    await seedAssignment({ id });
    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const revision = first.data.document.revision;
    const valid = first.data.document.blocks;

    const unknownType = await putDocument(id, {
      revision,
      blocks: [{ id: "bad-type", type: "absoluteBox", content: { text: "nope" } }],
    });
    assert.equal(unknownType.status, 400);

    const unsupportedStyle = await putDocument(id, {
      revision,
      blocks: [{ ...valid[0], style: { position: "absolute", top: 20 } }],
    });
    assert.equal(unsupportedStyle.status, 400);

    const outOfRangeStyle = await putDocument(id, {
      revision,
      blocks: [{ ...valid[0], style: { fontSize: 200 } }],
    });
    assert.equal(outOfRangeStyle.status, 400);

    const duplicateIds = await putDocument(id, {
      revision,
      blocks: [valid[0], { ...valid[1], id: valid[0].id }],
    });
    assert.equal(duplicateIds.status, 400);

    const unchanged = await getDocument(id);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.data.document.revision, revision);
    assert.deepEqual(unchanged.data.document.blocks, valid);
  });

  it("denies reads and writes to another user's assignment", async () => {
    const id = nextId("owner");
    await seedAssignment({ id, userId: USER_A });
    const ownerView = await getDocument(id);
    assert.equal(ownerView.status, 200);

    const foreignRead = await getDocument(id, COOKIE_B);
    assert.equal(foreignRead.status, 404);
    const foreignWrite = await putDocument(
      id,
      {
        revision: ownerView.data.document.revision,
        blocks: [{ id: "foreign", type: "paragraph", content: { text: "should not land" } }],
      },
      COOKIE_B,
    );
    assert.equal(foreignWrite.status, 404);

    const anonymousRead = await request(base, "GET", documentPath(id));
    assert.equal(anonymousRead.status, 401);
    const anonymousWrite = await request(base, "PUT", documentPath(id), {
      body: { revision: 0, blocks: [] },
    });
    assert.equal(anonymousWrite.status, 401);

    const unchanged = await getDocument(id);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.data.document.revision, ownerView.data.document.revision);
    assert.deepEqual(unchanged.data.document.blocks, ownerView.data.document.blocks);
  });
});

describe("STAGE 5 optimistic concurrency", () => {
  it("returns 409 for a stale save and never overwrites newer work", async () => {
    const id = nextId("stale");
    await seedAssignment({ id });
    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const revision = first.data.document.revision;
    const firstBlocks = first.data.document.blocks.map((block) =>
      block.id === "legacy-title" ? { ...block, content: { text: "First writer wins" } } : block,
    );
    const staleBlocks = first.data.document.blocks.map((block) =>
      block.id === "legacy-title" ? { ...block, content: { text: "Stale writer loses" } } : block,
    );

    const firstSave = await putDocument(id, { revision, schemaVersion: 2, blocks: firstBlocks });
    assert.equal(firstSave.status, 200);
    assert.equal(firstSave.data.document.revision, revision + 1);

    const staleSave = await putDocument(id, { revision, schemaVersion: 2, blocks: staleBlocks });
    assert.equal(staleSave.status, 409);
    assert.equal(staleSave.data.code, "document_conflict");
    assert.equal(staleSave.data.revision, revision + 1);

    const reloaded = await getDocument(id);
    assert.equal(reloaded.status, 200);
    assert.equal(blockById(reloaded.data.document.blocks, "legacy-title").content.text, "First writer wins");
  });

  it("serializes simultaneous saves so exactly one wins and the other gets 409", async () => {
    const id = nextId("race");
    await seedAssignment({ id });
    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const revision = first.data.document.revision;
    const bodyA = first.data.document.blocks.map((block) =>
      block.id === "legacy-title" ? { ...block, content: { text: "Concurrent A" } } : block,
    );
    const bodyB = first.data.document.blocks.map((block) =>
      block.id === "legacy-title" ? { ...block, content: { text: "Concurrent B" } } : block,
    );

    const [a, b] = await Promise.all([
      putDocument(id, { revision, schemaVersion: 2, blocks: bodyA }),
      putDocument(id, { revision, schemaVersion: 2, blocks: bodyB }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);

    const reloaded = await getDocument(id);
    const winner = blockById(reloaded.data.document.blocks, "legacy-title").content.text;
    assert.ok(winner === "Concurrent A" || winner === "Concurrent B");
    assert.equal(reloaded.data.document.revision, revision + 1);
  });
});

describe("STAGE 5 durable failure and restart", () => {
  it("returns 503 when the durable write fails and leaves the saved document intact", async () => {
    const id = nextId("failure");
    const originalBlocks = [
      { id: "failure-title", type: "title", content: { text: "Persisted title" } },
      { id: "failure-body", type: "paragraph", content: { text: "Persisted body" } },
    ];
    await seedAssignment({
      id,
      document: {
        schemaVersion: 2,
        revision: 1,
        blocks: originalBlocks,
        updatedAt: new Date().toISOString(),
      },
    });

    await disconnectStage5TestDb();
    let failed;
    try {
      failed = await putDocument(id, {
        revision: 1,
        schemaVersion: 2,
        blocks: [
          { id: "failure-title", type: "title", content: { text: "Unsaved local title" } },
          { id: "failure-body", type: "paragraph", content: { text: "Unsaved local body" } },
        ],
      });
    } finally {
      await connectStage5TestDb(TEST_DB);
    }

    assert.equal(failed.status, 503);
    assert.match(String(failed.data?.error), /could not be saved/i);

    const stillThere = await getDocument(id);
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.data.document.revision, 1);
    assert.equal(blockById(stillThere.data.document.blocks, "failure-title").content.text, "Persisted title");
    assert.equal(blockById(stillThere.data.document.blocks, "failure-body").content.text, "Persisted body");

    const stored = await storedAssignment(id);
    assert.equal(stored.data.document.revision, 1);
    assert.equal(blockById(stored.data.document.blocks, "failure-title").content.text, "Persisted title");
    assert.equal(stored.documentRevision, 1);
  });

  it("keeps document changes after an API restart (fresh store, empty memory, isolated DB)", async () => {
    const id = nextId("restart");
    await seedAssignment({ id });
    const first = await getDocument(id);
    assert.equal(first.status, 200);
    const edited = first.data.document.blocks.map((block) =>
      block.id === "legacy-title" ? { ...block, content: { text: "Durable after restart" } } : block,
    );

    const saved = await putDocument(id, {
      revision: first.data.document.revision,
      schemaVersion: 2,
      blocks: edited,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.document.revision, 1);

    // Fresh module = post-restart process (empty Map) + Mongo fallback.
    const fresh = await import(`../src/lib/assignmentStore.js?restart=stage5-${Date.now()}`);
    const afterRestart = await fresh.findRecord(id, USER_A);
    assert.ok(afterRestart, "the assignment must be reloaded from Mongo after a restart");
    assert.equal(afterRestart.document.revision, 1);
    assert.equal(afterRestart.documentSchemaVersion, 2);
    assert.equal(afterRestart.documentRevision, 1);
    assert.equal(blockById(afterRestart.document.blocks, "legacy-title").content.text, "Durable after restart");
    assert.deepEqual(afterRestart.content, first.data.document.content);
  });
});

describe("STAGE 5 section regeneration", () => {
  it("replaces only the regenerated section and preserves manual blocks, styles and ordering", async () => {
    const id = nextId("regen");
    const manualStyle = { align: "right", fontSize: 15, spacingAfter: 18, indent: 12 };
    const initialBlocks = [
      { id: "r-title", type: "title", content: { text: "Regeneration title" }, source: { section: "title" } },
      { id: "r-aim-heading", type: "heading", content: { text: "Aim" }, source: { section: "aim" } },
      { id: "r-aim", type: "paragraph", content: { text: "Original aim text" }, source: { section: "aim" } },
      { id: "r-theory-heading", type: "heading", content: { text: "Theory" }, source: { section: "theory" } },
      { id: "r-theory-1", type: "paragraph", content: { text: "Original theory text" }, source: { section: "theory" } },
      {
        id: "r-manual",
        type: "paragraph",
        content: { text: "Manual note that must survive" },
        style: manualStyle,
      },
      { id: "r-conclusion-heading", type: "heading", content: { text: "Conclusion" }, source: { section: "conclusion" } },
      { id: "r-conclusion", type: "paragraph", content: { text: "Original conclusion text" }, source: { section: "conclusion" } },
    ];
    await seedAssignment({
      id,
      document: {
        schemaVersion: 2,
        revision: 1,
        blocks: initialBlocks,
        updatedAt: new Date().toISOString(),
      },
    });

    const regenerated = await request(base, "POST", `/api/v1/assignments/${id}/regenerate-section`, {
      body: { section: "theory" },
      cookie: COOKIE_A,
    });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.data));
    assert.deepEqual(regenerated.data.content.theory, [
      "Regenerated theory explains nested query planning in detail.",
    ]);

    const reloaded = await getDocument(id);
    assert.equal(reloaded.status, 200);
    const doc = reloaded.data.document;
    assert.equal(doc.revision, 2, "regeneration must bump the document revision");

    assert.equal(blockById(doc.blocks, "r-title").content.text, "Regeneration title");
    assert.equal(blockById(doc.blocks, "r-aim").content.text, "Original aim text");
    assert.equal(blockById(doc.blocks, "r-conclusion").content.text, "Original conclusion text");

    const manual = blockById(doc.blocks, "r-manual");
    assert.ok(manual, "manual blocks must survive section regeneration");
    assert.deepEqual(manual.style, manualStyle, "manual formatting must survive section regeneration");
    assert.equal(manual.source, undefined);

    const theoryTexts = doc.blocks
      .filter((block) => block.source?.section === "theory" && block.type === "paragraph")
      .map((block) => block.content.text);
    assert.deepEqual(theoryTexts, ["Regenerated theory explains nested query planning in detail."]);
    assert.equal(blockById(doc.blocks, "r-theory-1"), undefined, "old section blocks must be replaced");

    const ids = blockIds(doc.blocks);
    assert.ok(ids.indexOf("r-aim") < ids.indexOf("r-manual"));
    assert.ok(ids.indexOf("r-manual") < ids.indexOf("r-conclusion"));

    const stored = await storedAssignment(id);
    assert.equal(stored.data.document.revision, 2);
    assert.deepEqual(blockById(stored.data.document.blocks, "r-manual").style, manualStyle);
  });
});
