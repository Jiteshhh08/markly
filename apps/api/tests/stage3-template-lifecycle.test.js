import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage3-template-lifecycle-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";
import {
  fileForm,
  minimalPdf,
  pdfFile,
  startAiStub,
  svgBytes,
  textBytes,
} from "./helpers/stage3Fixtures.js";

const { default: app } = await import("../src/index.js");
const { AuditLog, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { startServer, stopServer, cookieFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage3_template_lifecycle_test";
const PREFIX = "stage3-lifecycle";
const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;
const BRANCH_A2 = `${PREFIX}-branch-a2`;
const BRANCH_B1 = `${PREFIX}-branch-b1`;

let db;
let server;
let base;
let aiStub;
let aiMode = "ok";
let platformAdmin;
let collegeAdminA;
let collegeAdminB;
let ordinaryA;
let ordinaryB;

function api(user, method, path, body) {
  return request(base, method, path, {
    ...(user ? { cookie: cookieFor(user) } : {}),
    body,
  });
}

async function createTemplate(user, body) {
  const response = await api(user, "POST", "/api/v1/templates", body);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.template;
}

async function cleanup() {
  await User.deleteMany({ email: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
  await Template.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Department.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Tenant.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await AuditLog.deleteMany({ actorEmail: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
}

before(async () => {
  db = await connectStage3TestDb(TEST_DB);
  await db.dropDatabase();

  platformAdmin = await User.create({
    id: `${PREFIX}-usr-platform`,
    email: `${PREFIX}-platform@example.com`,
    name: "Stage3 Lifecycle Platform",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: `${PREFIX}-usr-college-a`,
    email: `${PREFIX}-college-a@example.com`,
    name: "Stage3 Lifecycle College A",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_A],
    tenantIds: [COLLEGE_A],
  });
  collegeAdminB = await User.create({
    id: `${PREFIX}-usr-college-b`,
    email: `${PREFIX}-college-b@example.com`,
    name: "Stage3 Lifecycle College B",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_B],
    tenantIds: [COLLEGE_B],
  });
  ordinaryA = await User.create({
    id: `${PREFIX}-usr-user-a`,
    email: `${PREFIX}-user-a@example.com`,
    name: "Stage3 Lifecycle Ordinary A",
    role: "user",
    tenantIds: [COLLEGE_A],
    preferences: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
  });
  ordinaryB = await User.create({
    id: `${PREFIX}-usr-user-b`,
    email: `${PREFIX}-user-b@example.com`,
    name: "Stage3 Lifecycle Ordinary B",
    role: "user",
    tenantIds: [COLLEGE_B],
    preferences: { collegeId: COLLEGE_B, departmentId: BRANCH_B1 },
  });

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage3 Lifecycle College A", slug: "stage3-lifecycle-college-a" },
    { id: COLLEGE_B, name: "Stage3 Lifecycle College B", slug: "stage3-lifecycle-college-b" },
  ]);
  await Department.create([
    { id: BRANCH_A1, tenantId: COLLEGE_A, name: "A1", slug: "a1" },
    { id: BRANCH_A2, tenantId: COLLEGE_A, name: "A2", slug: "a2" },
    { id: BRANCH_B1, tenantId: COLLEGE_B, name: "B1", slug: "b1" },
  ]);

  aiStub = await startAiStub(() => {
    if (aiMode === "fail") {
      return { status: 500, body: { error: "simulated extraction outage" } };
    }
    if (aiMode === "bad-sections") {
      return {
        suggestedName: "Stage3 Lifecycle AI Suggested",
        requiredSections: ["not-a-section"],
        detectedHeadings: ["Aim"],
        chars: 12,
      };
    }
    return {
      suggestedName: "Stage3 Lifecycle AI Suggested",
      requiredSections: ["title", "aim", "theory", "steps", "conclusion"],
      detectedHeadings: ["Aim", "Theory", "Steps"],
      chars: 4321,
    };
  });
  process.env.AI_SERVICE_URL = aiStub.url;

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await aiStub?.close().catch(() => {});
  delete process.env.AI_SERVICE_URL;
  await cleanup().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage3TestDb();
});

describe("STAGE 3 template lifecycle, imports and persistence", () => {
  it("keeps a private template owner-only through edit, publish and archive", async () => {
    const created = await createTemplate(ordinaryA, {
      name: "Stage3 Lifecycle Private Owner",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      footer: { text: "private v1" },
      page: { size: "A4", margin: { top: "100px", right: "18mm" } },
      typography: { fontFamily: "Georgia", baseSize: "12pt", lineHeight: 1.5 },
      requiredSections: ["title", "aim", "theory"],
    });
    assert.equal(created.version, 1);
    assert.equal(created.status, "draft");
    assert.equal(created.scope, "private");
    assert.equal(created.ownerUserId, ordinaryA.id);

    for (const outsider of [ordinaryB, collegeAdminA, platformAdmin]) {
      const read = await api(outsider, "GET", `/api/v1/templates/${created.id}`);
      assert.equal(read.status, 404, JSON.stringify(read.data));
    }

    const ownerCatalogue = await api(ordinaryA, "GET", "/api/v1/templates");
    assert.equal(ownerCatalogue.status, 200);
    assert.equal(
      ownerCatalogue.data.templates.some((template) => template.id === created.id),
      true,
    );

    const otherCatalogue = await api(ordinaryB, "GET", "/api/v1/templates");
    assert.equal(otherCatalogue.status, 200);
    assert.equal(
      otherCatalogue.data.templates.some((template) => template.id === created.id),
      false,
    );

    const platformCatalogue = await api(platformAdmin, "GET", "/api/v1/templates");
    assert.equal(platformCatalogue.status, 200);
    assert.equal(
      platformCatalogue.data.templates.some((template) => template.id === created.id),
      false,
    );

    const edited = await api(ordinaryA, "PUT", `/api/v1/templates/${created.id}`, {
      footer: { text: "private v2" },
      status: "draft",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.template.version, 2);
    assert.equal(edited.data.template.status, "draft");

    const v1 = await Template.findOne({ id: created.id, version: 1 }).lean();
    const v2 = await Template.findOne({ id: created.id, version: 2 }).lean();
    assert.equal(v1.footer.text, "private v1");
    assert.equal(v2.footer.text, "private v2");

    const published = await api(
      ordinaryA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      { footer: { text: "private v3" } },
    );
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.template.version, 3);
    assert.equal(published.data.template.status, "published");
    assert.ok(published.data.template.publishedAt);

    const v3 = await Template.findOne({ id: created.id, version: 3 }).lean();
    assert.equal(v3.footer.text, "private v3");
    assert.equal((await Template.findOne({ id: created.id, version: 2 }).lean()).status, "draft");
    assert.equal((await Template.findOne({ id: created.id, version: 1 }).lean()).status, "draft");

    const history = await api(ordinaryA, "GET", `/api/v1/templates/${created.id}/versions`);
    assert.equal(history.status, 200, JSON.stringify(history.data));
    assert.deepEqual(
      history.data.versions.map((entry) => entry.version),
      [1, 2, 3],
    );
    assert.deepEqual(
      history.data.versions.map((entry) => entry.status),
      ["draft", "draft", "published"],
    );

    const archived = await api(ordinaryA, "POST", `/api/v1/templates/${created.id}/archive`, {});
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.equal(archived.data.template.version, 4);
    assert.equal(archived.data.template.status, "archived");
    assert.ok(archived.data.template.archivedAt);

    const archivedRead = await api(ordinaryA, "GET", `/api/v1/templates/${created.id}`);
    assert.equal(archivedRead.status, 200);
    assert.equal(archivedRead.data.template.status, "archived");
    assert.equal(
      (await Template.findOne({ id: created.id, version: 3 }).lean()).status,
      "published",
    );

    const archivedHistory = await api(
      ordinaryA,
      "GET",
      `/api/v1/templates/${created.id}/versions`,
    );
    assert.deepEqual(
      archivedHistory.data.versions.map((entry) => entry.version),
      [1, 2, 3, 4],
    );

    const outsiderArchive = await api(
      platformAdmin,
      "POST",
      `/api/v1/templates/${created.id}/archive`,
      {},
    );
    assert.equal(outsiderArchive.status, 403, JSON.stringify(outsiderArchive.data));
  });

  it("forks immutable versions on edit and publish without mutating published history", async () => {
    const created = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Immutable",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      footer: { text: "immutable v1" },
      requiredSections: ["title", "aim", "objectives", "theory", "steps", "conclusion"],
    });
    assert.equal(created.version, 1);
    assert.equal(created.status, "draft");

    const draft2 = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { footer: { text: "immutable v2" }, status: "draft" },
    );
    assert.equal(draft2.status, 200, JSON.stringify(draft2.data));
    assert.equal(draft2.data.template.version, 2);
    assert.equal(draft2.data.template.status, "draft");

    const published3 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      { footer: { text: "immutable v3" } },
    );
    assert.equal(published3.status, 200, JSON.stringify(published3.data));
    assert.equal(published3.data.template.version, 3);
    assert.equal(published3.data.template.status, "published");

    const v1 = await Template.findOne({ id: created.id, version: 1 }).lean();
    const v2 = await Template.findOne({ id: created.id, version: 2 }).lean();
    const v3 = await Template.findOne({ id: created.id, version: 3 }).lean();
    assert.equal(v1.footer.text, "immutable v1");
    assert.equal(v1.status, "draft");
    assert.equal(v2.footer.text, "immutable v2");
    assert.equal(v2.status, "draft");
    assert.equal(v3.footer.text, "immutable v3");
    assert.equal(v3.status, "published");

    for (const [version, expected] of [
      [1, "immutable v1"],
      [2, "immutable v2"],
      [3, "immutable v3"],
    ]) {
      const read = await api(
        collegeAdminA,
        "GET",
        `/api/v1/templates/${created.id}?version=${version}`,
      );
      assert.equal(read.status, 200, JSON.stringify(read.data));
      assert.equal(read.data.template.version, version);
      assert.equal(read.data.template.footer.text, expected);
    }

    const history = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${created.id}/versions`,
    );
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.data.versions.map((entry) => [entry.version, entry.status]),
      [
        [1, "draft"],
        [2, "draft"],
        [3, "published"],
      ],
    );

    // Saving a draft from a published version must not rewrite the published
    // version. The new draft is the latest version; the old one stays pinned.
    const draft4 = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { footer: { text: "immutable v4 draft" }, status: "draft" },
    );
    assert.equal(draft4.status, 200, JSON.stringify(draft4.data));
    assert.equal(draft4.data.template.version, 4);
    assert.equal(draft4.data.template.status, "draft");
    assert.equal(
      (await Template.findOne({ id: created.id, version: 3 }).lean()).status,
      "published",
    );
    assert.equal(
      (await Template.findOne({ id: created.id, version: 3 }).lean()).footer.text,
      "immutable v3",
    );

    const latest = await api(collegeAdminA, "GET", `/api/v1/templates/${created.id}`);
    assert.equal(latest.status, 200);
    assert.equal(latest.data.template.version, 4);
    assert.equal(latest.data.template.status, "draft");

    const published5 = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      { footer: { text: "immutable v5" } },
    );
    assert.equal(published5.status, 200, JSON.stringify(published5.data));
    assert.equal(published5.data.template.version, 5);
    assert.equal(published5.data.template.status, "published");

    const versions = await Template.find({ id: created.id }).sort({ version: 1 }).lean();
    assert.deepEqual(
      versions.map((entry) => entry.version),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      versions.map((entry) => entry.footer.text),
      [
        "immutable v1",
        "immutable v2",
        "immutable v3",
        "immutable v4 draft",
        "immutable v5",
      ],
    );

    const otherCollegeEdit = await api(
      collegeAdminB,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { footer: { text: "cross college" } },
    );
    assert.equal(otherCollegeEdit.status, 403, JSON.stringify(otherCollegeEdit.data));

    const otherCollegePublish = await api(
      collegeAdminB,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      {},
    );
    assert.equal(otherCollegePublish.status, 403, JSON.stringify(otherCollegePublish.data));

    const otherCollegeArchive = await api(
      collegeAdminB,
      "POST",
      `/api/v1/templates/${created.id}/archive`,
      {},
    );
    assert.equal(otherCollegeArchive.status, 403, JSON.stringify(otherCollegeArchive.data));

    const platformEdit = await api(
      platformAdmin,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { footer: { text: "platform edit" }, status: "draft" },
    );
    assert.equal(platformEdit.status, 200, JSON.stringify(platformEdit.data));
    assert.equal(platformEdit.data.template.version, 6);
    assert.equal(platformEdit.data.template.status, "draft");
  });

  it("rejects unsafe template configuration and invalid lifecycle transitions", async () => {
    const created = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Validation",
      scope: "college",
      tenantId: COLLEGE_A,
      footer: { text: "valid" },
    });

    const invalidBodies = [
      { page: { size: "A0" } },
      { page: { margin: { top: "18mm; color: red" } } },
      { typography: { fontFamily: "Arial; background:url(javascript:alert(1))" } },
      { typography: { baseSize: "12pt; background:red" } },
      { typography: { lineHeight: 4 } },
      { header: { image: "http://evil.example/header.png" } },
      { header: { image: "/assets/../secret.png" } },
      { header: { image: "/assets/header.svg" } },
      { watermark: { image: "/assets/uploads/ok.png", opacity: 0.7 } },
      { requiredSections: [] },
      { requiredSections: ["theory", "aim"] },
      { requiredSections: ["bogus"] },
      { studentMetadataFields: ["$where"] },
      { facultyTable: { columns: ["Name", "Signature"], rows: [["only-one"]] } },
      { metadata: { $where: "sleep(1000)" } },
      { assets: { logo: "javascript:alert(1)" } },
    ];

    for (const body of invalidBodies) {
      const response = await api(
        collegeAdminA,
        "PUT",
        `/api/v1/templates/${created.id}`,
        { ...body, status: "draft" },
      );
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(body)} => ${response.status} ${JSON.stringify(response.data)}`,
      );
    }
    assert.equal(await Template.countDocuments({ id: created.id }), 1);

    const safeWatermark = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      {
        watermark: { image: "/assets/uploads/ok.png", opacity: 0.5, everyPage: true },
        header: { image: "/assets/headers/alpha.png", alt: "Header", height: "72px" },
        assets: { logo: "/assets/logos/alpha.png" },
        status: "draft",
      },
    );
    assert.equal(safeWatermark.status, 200, JSON.stringify(safeWatermark.data));
    assert.equal(safeWatermark.data.template.version, 2);
    assert.equal(safeWatermark.data.template.watermark.opacity, 0.5);

    const published = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      { footer: { text: "published before archive" } },
    );
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.template.version, 3);

    const archived = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/archive`,
      {},
    );
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.equal(archived.data.template.version, 4);
    assert.equal(archived.data.template.status, "archived");

    const republishArchived = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      {},
    );
    assert.equal(republishArchived.status, 400, JSON.stringify(republishArchived.data));

    const publishViaPut = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { status: "published" },
    );
    assert.equal(publishViaPut.status, 400, JSON.stringify(publishViaPut.data));

    const restoreDraft = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { status: "draft", footer: { text: "restored draft" } },
    );
    assert.equal(restoreDraft.status, 200, JSON.stringify(restoreDraft.data));
    assert.equal(restoreDraft.data.template.version, 5);
    assert.equal(restoreDraft.data.template.status, "draft");

    const republished = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${created.id}/publish`,
      { footer: { text: "republished" } },
    );
    assert.equal(republished.status, 200, JSON.stringify(republished.data));
    assert.equal(republished.data.template.version, 6);
    assert.equal(republished.data.template.status, "published");

    const history = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${created.id}/versions`,
    );
    assert.deepEqual(
      history.data.versions.map((entry) => [entry.version, entry.status]),
      [
        [1, "draft"],
        [2, "draft"],
        [3, "published"],
        [4, "archived"],
        [5, "draft"],
        [6, "published"],
      ],
    );
  });

  it("accepts null/empty optional asset slots and persists the clear", async () => {
    const created = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Optional Assets",
      scope: "college",
      tenantId: COLLEGE_A,
      assets: { logo: "/assets/logos/alpha.png" },
    });
    assert.equal(created.assets.logo, "/assets/logos/alpha.png");

    const cleared = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { assets: { logo: null }, status: "draft" },
    );
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.equal(cleared.data.template.version, 2);
    assert.equal(cleared.data.template.assets?.logo ?? null, null);

    const empty = await api(
      collegeAdminA,
      "PUT",
      `/api/v1/templates/${created.id}`,
      { assets: { logo: "" }, status: "draft" },
    );
    assert.equal(empty.status, 200, JSON.stringify(empty.data));
    assert.equal(empty.data.template.version, 3);
    assert.equal(empty.data.template.assets?.logo ?? null, null);
  });

  it("imports PDFs as drafts and never auto-publishes", async () => {
    aiMode = "ok";
    try {
      const imported = await request(
        base,
        "POST",
        "/api/v1/templates/from-pdf",
        {
          cookie: cookieFor(collegeAdminA),
          body: fileForm(
            {
              name: "Stage3 Lifecycle Imported",
              scope: "college",
              tenantId: COLLEGE_A,
              departmentId: BRANCH_A1,
              status: "published",
            },
            pdfFile(minimalPdf()),
          ),
        },
      );
      assert.equal(imported.status, 201, JSON.stringify(imported.data));
      assert.equal(imported.data.template.status, "draft");
      assert.equal(imported.data.template.version, 1);
      assert.equal(imported.data.template.scope, "college");
      assert.equal(imported.data.template.tenantId, COLLEGE_A);
      assert.equal(imported.data.template.departmentId, BRANCH_A1);
      assert.deepEqual(imported.data.template.requiredSections, [
        "title",
        "aim",
        "theory",
        "steps",
        "conclusion",
      ]);
      assert.equal(imported.data.analysis.suggestedName, "Stage3 Lifecycle AI Suggested");
      assert.equal(imported.data.analysis.detectedHeadings.length, 3);

      const persisted = await Template.findOne({
        id: imported.data.template.id,
        version: 1,
      }).lean();
      assert.equal(persisted.status, "draft");
      assert.equal(persisted.name, "Stage3 Lifecycle Imported");

      const audit = await AuditLog.findOne({
        action: "template.import",
        entityId: imported.data.template.id,
      }).lean();
      assert.ok(audit);
      assert.equal(audit.actorId, collegeAdminA.id);

      const privateImport = await request(
        base,
        "POST",
        "/api/v1/templates/from-pdf",
        {
          cookie: cookieFor(ordinaryA),
          body: fileForm(
            { scope: "private", tenantId: COLLEGE_A, status: "active" },
            pdfFile(minimalPdf()),
          ),
        },
      );
      assert.equal(privateImport.status, 201, JSON.stringify(privateImport.data));
      assert.equal(privateImport.data.template.status, "draft");
      assert.equal(privateImport.data.template.scope, "private");
      assert.equal(privateImport.data.template.ownerUserId, ordinaryA.id);
      assert.equal(privateImport.data.template.name, "Stage3 Lifecycle AI Suggested");

      const ordinarySharedImport = await request(
        base,
        "POST",
        "/api/v1/templates/from-pdf",
        {
          cookie: cookieFor(ordinaryA),
          body: fileForm(
            { scope: "college", tenantId: COLLEGE_A },
            pdfFile(minimalPdf()),
          ),
        },
      );
      assert.equal(
        ordinarySharedImport.status,
        403,
        JSON.stringify(ordinarySharedImport.data),
      );

      aiMode = "bad-sections";
      const badSections = await request(
        base,
        "POST",
        "/api/v1/templates/from-pdf",
        {
          cookie: cookieFor(collegeAdminA),
          body: fileForm(
            {
              name: "Stage3 Lifecycle Bad Sections",
              scope: "college",
              tenantId: COLLEGE_A,
            },
            pdfFile(minimalPdf()),
          ),
        },
      );
      assert.equal(badSections.status, 201, JSON.stringify(badSections.data));
      assert.equal(badSections.data.template.status, "draft");
      assert.equal(badSections.data.template.requiredSections.length, 6);
      assert.deepEqual(badSections.data.analysis.requiredSections, []);
    } finally {
      aiMode = "ok";
    }
  });

  it("rejects unsafe or malformed PDF imports without creating templates", async () => {
    const beforeCount = await Template.countDocuments({ id: new RegExp(`^${PREFIX}-`) });

    const cases = [
      ["missing file", fileForm({ name: "Stage3 Lifecycle Missing PDF" })],
      [
        "text file",
        fileForm({ name: "Stage3 Lifecycle Text PDF" }, pdfFile(textBytes("not a pdf"), "bad.pdf")),
      ],
      [
        "svg disguised",
        fileForm({ name: "Stage3 Lifecycle SVG PDF" }, pdfFile(svgBytes(), "bad.pdf")),
      ],
      [
        "active content",
        fileForm(
          { name: "Stage3 Lifecycle JS PDF" },
          pdfFile(minimalPdf({ javascript: true }), "bad.pdf"),
        ),
      ],
      [
        "missing EOF",
        fileForm(
          { name: "Stage3 Lifecycle Truncated PDF" },
          pdfFile(minimalPdf({ eof: false }), "bad.pdf"),
        ),
      ],
      [
        "too many pages",
        fileForm(
          { name: "Stage3 Lifecycle Too Many Pages" },
          pdfFile(minimalPdf({ pages: 41 }), "bad.pdf"),
        ),
      ],
    ];

    for (const [label, form] of cases) {
      const response = await request(base, "POST", "/api/v1/templates/from-pdf", {
        cookie: cookieFor(collegeAdminA),
        body: form,
      });
      assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.data)}`);
      assert.equal(response.data.template, undefined);
    }

    aiMode = "fail";
    try {
      const failed = await request(base, "POST", "/api/v1/templates/from-pdf", {
        cookie: cookieFor(collegeAdminA),
        body: fileForm(
          { name: "Stage3 Lifecycle AI Failure", scope: "college", tenantId: COLLEGE_A },
          pdfFile(minimalPdf()),
        ),
      });
      assert.equal(failed.status, 500, JSON.stringify(failed.data));
      assert.equal(failed.data.template, undefined);
    } finally {
      aiMode = "ok";
    }

    const afterCount = await Template.countDocuments({ id: new RegExp(`^${PREFIX}-`) });
    assert.equal(afterCount, beforeCount, "failed imports must not persist drafts");
  });

  it("reads authoritative MongoDB records across a restart and another instance", async () => {
    const created = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Persisted",
      scope: "college",
      tenantId: COLLEGE_A,
      footer: { text: "persisted v1" },
    });
    assert.equal(created.version, 1);

    const fresh = await import(
      `../src/lib/templateStore.js?stage3-restart=${Date.now()}`
    );
    await fresh.ensureTemplatesLoaded();
    const reloaded = fresh.getTemplateVersion(created.id, 1);
    assert.ok(reloaded, "a cold store must load the persisted version");
    assert.equal(reloaded.footer.text, "persisted v1");

    // Simulate a second API instance writing directly to MongoDB after this
    // process has already hydrated its in-memory cache.
    const externalId = `${PREFIX}-external-template`;
    await Template.create({
      id: externalId,
      version: 1,
      name: "Stage3 Lifecycle External Template",
      scope: "college",
      status: "active",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      ownerUserId: null,
      requiredSections: ["title", "aim", "theory"],
      page: { size: "A4", margin: { top: "18mm" } },
      typography: { fontFamily: "Georgia", baseSize: "12pt", lineHeight: 1.5 },
      header: { image: null, everyPage: true },
      watermark: { image: null, everyPage: true },
      footer: { text: "external", showPageNumber: true },
    });

    const externalRead = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${externalId}`,
    );
    assert.equal(externalRead.status, 200, JSON.stringify(externalRead.data));
    assert.equal(externalRead.data.template.footer.text, "external");

    const externalCatalogue = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_A)}&departmentId=${encodeURIComponent(BRANCH_A1)}`,
    );
    assert.equal(externalCatalogue.status, 200, JSON.stringify(externalCatalogue.data));
    assert.equal(
      externalCatalogue.data.templates.some((template) => template.id === externalId),
      true,
      "a newly persisted template from another instance must not be hidden by a stale cache",
    );

    // Publish a new version directly in MongoDB; the route must return it
    // immediately instead of serving the cached latest version.
    await Template.create({
      id: externalId,
      version: 2,
      name: "Stage3 Lifecycle External Template",
      scope: "college",
      status: "published",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      ownerUserId: null,
      requiredSections: ["title", "aim", "theory"],
      page: { size: "A4", margin: { top: "18mm" } },
      typography: { fontFamily: "Georgia", baseSize: "12pt", lineHeight: 1.5 },
      header: { image: null, everyPage: true },
      watermark: { image: null, everyPage: true },
      footer: { text: "external v2", showPageNumber: true },
    });

    const externalV2 = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${externalId}`,
    );
    assert.equal(externalV2.status, 200, JSON.stringify(externalV2.data));
    assert.equal(externalV2.data.template.version, 2);
    assert.equal(externalV2.data.template.footer.text, "external v2");

    const missingVersion = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${externalId}?version=999`,
    );
    assert.equal(missingVersion.status, 404, JSON.stringify(missingVersion.data));

    const missingPreview = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates/${externalId}/preview?version=999`,
    );
    assert.equal(missingPreview.status, 404, JSON.stringify(missingPreview.data));

    const generation = await api(
      collegeAdminA,
      "POST",
      "/api/v1/assignments/generate",
      {
        aim: "Verify that a missing pinned template version is an explicit error.",
        templateId: externalId,
        templateVersion: 999,
      },
    );
    assert.equal(generation.status, 404, JSON.stringify(generation.data));
  });

  it("filters the catalogue by scope, status, college and branch", async () => {
    const draftA1 = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Catalogue Draft A1",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
    });
    const publishedA1 = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Catalogue Published A1",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      status: "active",
    });
    const publishedA2 = await createTemplate(collegeAdminA, {
      name: "Stage3 Lifecycle Catalogue Published A2",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A2,
      status: "active",
    });
    const platformPublished = await createTemplate(platformAdmin, {
      name: "Stage3 Lifecycle Catalogue Platform",
      scope: "platform",
      status: "active",
    });
    const privateTemplate = await createTemplate(ordinaryA, {
      name: "Stage3 Lifecycle Catalogue Private",
      tenantId: COLLEGE_A,
    });
    const otherCollegeDraft = await createTemplate(platformAdmin, {
      name: "Stage3 Lifecycle Catalogue B Draft",
      scope: "college",
      tenantId: COLLEGE_B,
      departmentId: BRANCH_B1,
    });

    const drafts = await api(collegeAdminA, "GET", "/api/v1/templates?status=draft");
    assert.equal(drafts.status, 200, JSON.stringify(drafts.data));
    assert.equal(drafts.data.templates.some((template) => template.id === draftA1.id), true);
    assert.equal(
      drafts.data.templates.some((template) => template.id === publishedA1.id),
      false,
    );
    assert.equal(
      drafts.data.templates.some((template) => template.id === otherCollegeDraft.id),
      false,
    );

    const published = await api(
      collegeAdminA,
      "GET",
      "/api/v1/templates?status=published",
    );
    assert.equal(published.status, 200);
    assert.equal(
      published.data.templates.some((template) => template.id === publishedA1.id),
      true,
    );
    assert.equal(
      published.data.templates.some((template) => template.id === draftA1.id),
      false,
    );

    const collegeScope = await api(
      collegeAdminA,
      "GET",
      "/api/v1/templates?scope=college",
    );
    assert.equal(collegeScope.status, 200);
    assert.equal(
      collegeScope.data.templates.some((template) => template.id === publishedA1.id),
      true,
    );
    assert.equal(
      collegeScope.data.templates.some((template) => template.id === platformPublished.id),
      false,
    );
    assert.equal(
      collegeScope.data.templates.some((template) => template.id === privateTemplate.id),
      false,
    );

    const platformScope = await api(
      collegeAdminA,
      "GET",
      "/api/v1/templates?scope=platform",
    );
    assert.equal(platformScope.status, 200);
    assert.equal(
      platformScope.data.templates.some((template) => template.id === platformPublished.id),
      true,
    );

    const branchScope = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_A)}&departmentId=${encodeURIComponent(BRANCH_A1)}`,
    );
    assert.equal(branchScope.status, 200, JSON.stringify(branchScope.data));
    assert.equal(
      branchScope.data.templates.some((template) => template.id === draftA1.id),
      true,
    );
    assert.equal(
      branchScope.data.templates.some((template) => template.id === publishedA1.id),
      true,
    );
    assert.equal(
      branchScope.data.templates.some((template) => template.id === publishedA2.id),
      false,
    );

    const otherCollegeScope = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_B)}`,
    );
    assert.equal(otherCollegeScope.status, 403, JSON.stringify(otherCollegeScope.data));

    const ordinaryScope = await api(
      ordinaryA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_A)}`,
    );
    assert.equal(ordinaryScope.status, 200, JSON.stringify(ordinaryScope.data));

    const ordinaryOtherScope = await api(
      ordinaryA,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_B)}`,
    );
    assert.equal(
      ordinaryOtherScope.status,
      403,
      JSON.stringify(ordinaryOtherScope.data),
    );

    const anonymousScope = await api(
      null,
      "GET",
      `/api/v1/templates?collegeId=${encodeURIComponent(COLLEGE_A)}`,
    );
    // AUTH_REQUIRED=1 rejects anonymous callers before scope evaluation. Either
    // way an anonymous college-scope catalogue is never served.
    assert.equal(anonymousScope.status, 401, JSON.stringify(anonymousScope.data));

    const invalidStatus = await api(
      collegeAdminA,
      "GET",
      "/api/v1/templates?status=not-a-status",
    );
    assert.equal(invalidStatus.status, 400, JSON.stringify(invalidStatus.data));

    const invalidScope = await api(
      collegeAdminA,
      "GET",
      "/api/v1/templates?scope=not-a-scope",
    );
    assert.equal(invalidScope.status, 400, JSON.stringify(invalidScope.data));

    const branchWithoutCollege = await api(
      collegeAdminA,
      "GET",
      `/api/v1/templates?departmentId=${encodeURIComponent(BRANCH_A1)}`,
    );
    assert.equal(
      branchWithoutCollege.status,
      400,
      JSON.stringify(branchWithoutCollege.data),
    );
  });
});
