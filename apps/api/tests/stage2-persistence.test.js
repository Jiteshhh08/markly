import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage2-persistence-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage2TestDb, disconnectStage2TestDb } from "./helpers/testDb.js";

const { default: app } = await import("../src/index.js");
const { Template, User } = await import("../src/models/index.js");
const { startServer, stopServer, cookieFor, request } = await import(
  "./helpers/stage2Http.js"
);

const TEST_DB = "markly_stage2_persistence_test";
const EMAIL_RE = /^stage2-persist-.*@example\.com$/;
const TEMPLATE_RE = /^stage2-persist-/;

let db;
let server;
let base;
let user;

async function cleanup() {
  await User.deleteMany({ email: EMAIL_RE });
  await Template.deleteMany({ id: TEMPLATE_RE });
}

before(async () => {
  db = await connectStage2TestDb(TEST_DB);
  await db.dropDatabase();
  user = await User.create({
    id: "usr_stage2_persist_owner",
    email: "stage2-persist-owner@example.com",
    name: "Stage 2 persistence owner",
    role: "user",
  });
  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await cleanup().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage2TestDb();
});

function cookie() {
  return cookieFor(user);
}

describe("STAGE 2 MongoDB-authoritative template persistence", () => {
  it("persists every runtime field before returning success and reloads it in a fresh store module", async () => {
    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(),
      body: {
        name: "Stage2 Persist Alpha",
        footer: { text: "persisted footer v1", showPageNumber: false },
        header: { image: "/assets/headers/alpha.png", everyPage: true, height: "64px" },
        watermark: { image: "/assets/watermarks/alpha.png", everyPage: true },
        page: { size: "A4", margin: { top: "100px", bottom: "21mm" } },
        pageSettings: { orientation: "portrait", columns: 1 },
        typography: { fontFamily: "Georgia", baseSize: "11pt", lineHeight: 1.5 },
        requiredSections: ["title", "aim", "theory"],
        studentMetadataFields: ["name", "rollNumber"],
        facultyTable: {
          title: "Faculty review v1",
          columns: ["Name", "Signature"],
          rows: [["", ""]],
        },
        assets: { logo: "/assets/logos/alpha.png" },
        metadata: { source: "stage2-test", revision: 1 },
      },
    });

    assert.equal(created.status, 201, JSON.stringify(created.data));
    const template = created.data.template;
    assert.match(template.id, TEMPLATE_RE);
    assert.equal(template.version, 1);
    assert.equal(template.scope, "private");
    assert.equal(template.ownerUserId, user.id);
    assert.equal(template.status, "draft");

    const persisted = await Template.findOne({ id: template.id, version: 1 }).lean();
    assert.ok(persisted, "the version must be in MongoDB before the request succeeds");
    assert.equal(persisted.footer.text, "persisted footer v1");
    assert.equal(persisted.footer.showPageNumber, false);
    assert.equal(persisted.header.image, "/assets/headers/alpha.png");
    assert.equal(persisted.header.height, "64px");
    assert.equal(persisted.watermark.image, "/assets/watermarks/alpha.png");
    assert.equal(persisted.page.margin.top, "100px");
    assert.equal(persisted.pageSettings.orientation, "portrait");
    assert.equal(persisted.typography.baseSize, "11pt");
    assert.deepEqual(persisted.requiredSections, ["title", "aim", "theory"]);
    assert.deepEqual(persisted.studentMetadataFields, ["name", "rollNumber"]);
    assert.equal(persisted.facultyTable.title, "Faculty review v1");
    assert.equal(persisted.assets.logo, "/assets/logos/alpha.png");
    assert.equal(persisted.metadata.revision, 1);
    assert.equal(persisted.createdBy, user.id);

    // Fresh module instance = a cold process reading only MongoDB.
    const fresh = await import(
      `../src/lib/templateStore.js?persistence-restart=${Date.now()}`
    );
    await fresh.ensureTemplatesLoaded();
    const reloaded = fresh.getTemplateVersion(template.id, 1);
    assert.ok(reloaded, "a cold store must load the persisted version");
    assert.equal(reloaded.footer.text, "persisted footer v1");
    assert.equal(reloaded.header.height, "64px");
    assert.equal(reloaded.facultyTable.title, "Faculty review v1");
    assert.equal(reloaded.metadata.revision, 1);
  });

  it("forks immutable versions, persists draft/published state, and survives a cold store", async () => {
    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(),
      body: {
        name: "Stage2 Persist Versioned",
        footer: { text: "version one footer" },
        facultyTable: { title: "Version one faculty", columns: ["Name"], rows: [[""]] },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;
    assert.equal(created.data.template.status, "draft");

    const updated = await request(base, "PUT", `/api/v1/templates/${id}`, {
      cookie: cookie(),
      body: {
        status: "active",
        footer: { text: "version two footer" },
        facultyTable: { title: "Version two faculty", columns: ["Name"], rows: [[""]] },
      },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.template.id, id, "identity must not change on update");
    assert.equal(updated.data.template.version, 2);
    assert.equal(updated.data.template.status, "active");

    const v1 = await Template.findOne({ id, version: 1 }).lean();
    const v2 = await Template.findOne({ id, version: 2 }).lean();
    assert.ok(v1 && v2);
    assert.equal(v1.status, "draft");
    assert.equal(v1.footer.text, "version one footer");
    assert.equal(v2.status, "active");
    assert.equal(v2.footer.text, "version two footer");

    const fresh = await import(
      `../src/lib/templateStore.js?persistence-version-restart=${Date.now()}`
    );
    await fresh.ensureTemplatesLoaded();
    assert.equal(fresh.getTemplateVersion(id, 1).status, "draft");
    assert.equal(fresh.getTemplateVersion(id, 1).footer.text, "version one footer");
    assert.equal(fresh.getTemplateVersion(id, 2).status, "active");
    assert.equal(fresh.getTemplateVersion(id, 2).footer.text, "version two footer");

    const v1Route = await request(base, "GET", `/api/v1/templates/${id}?version=1`, {
      cookie: cookie(),
    });
    const v2Route = await request(base, "GET", `/api/v1/templates/${id}?version=2`, {
      cookie: cookie(),
    });
    assert.equal(v1Route.status, 200);
    assert.equal(v2Route.status, 200);
    assert.equal(v1Route.data.template.status, "draft");
    assert.equal(v2Route.data.template.status, "active");
  });

  it("returns an explicit 503 and leaves the cache untouched when the database write fails", async () => {
    const originalCreate = Template.create.bind(Template);
    const failedName = `Stage2 Persist Failed ${Date.now()}`;
    Template.create = async () => {
      throw new Error("simulated template persistence outage");
    };
    try {
      const failed = await request(base, "POST", "/api/v1/templates", {
        cookie: cookie(),
        body: { name: failedName, footer: { text: "must not be committed" } },
      });
      assert.equal(failed.status, 503, JSON.stringify(failed.data));
      assert.equal(failed.data.template, undefined);
      assert.equal(await Template.countDocuments({ name: failedName }), 0);

      const listed = await request(base, "GET", "/api/v1/templates", {
        cookie: cookie(),
      });
      assert.equal(listed.status, 200);
      assert.equal(
        listed.data.templates.some((template) => template.name === failedName),
        false,
        "a failed write must never appear in the catalogue cache",
      );
    } finally {
      Template.create = originalCreate;
    }

    const created = await request(base, "POST", "/api/v1/templates", {
      cookie: cookie(),
      body: { name: "Stage2 Persist Update Failure", footer: { text: "v1 durable" } },
    });
    assert.equal(created.status, 201);
    const id = created.data.template.id;

    Template.create = async () => {
      throw new Error("simulated template persistence outage");
    };
    try {
      const failedUpdate = await request(base, "PUT", `/api/v1/templates/${id}`, {
        cookie: cookie(),
        body: { footer: { text: "v2 must not be committed" } },
      });
      assert.equal(failedUpdate.status, 503, JSON.stringify(failedUpdate.data));
    } finally {
      Template.create = originalCreate;
    }

    const afterFailure = await request(base, "GET", `/api/v1/templates/${id}`, {
      cookie: cookie(),
    });
    assert.equal(afterFailure.status, 200);
    assert.equal(afterFailure.data.template.version, 1);
    assert.equal(afterFailure.data.template.footer.text, "v1 durable");
    assert.equal(await Template.countDocuments({ id }), 1);
  });

  it("fails closed instead of pretending success when persistence is required but Mongo is down", async () => {
    await disconnectStage2TestDb();
    process.env.TEMPLATE_PERSISTENCE_REQUIRED = "1";
    try {
      const failed = await request(base, "POST", "/api/v1/templates", {
        cookie: cookie(),
        body: { name: "Stage2 Persist Required Offline" },
      });
      assert.equal(failed.status, 503, JSON.stringify(failed.data));
      assert.equal(failed.data.template, undefined);
    } finally {
      delete process.env.TEMPLATE_PERSISTENCE_REQUIRED;
      db = await connectStage2TestDb(TEST_DB);
    }
  });
});
