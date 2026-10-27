import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

process.env.NODE_ENV = "test";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage3-upload-security-test-secret-0123456789abcdef";
process.env.RATE_LIMIT_PER_MIN = "1000";

import { connectStage3TestDb, disconnectStage3TestDb } from "./helpers/testDb.js";
import {
  gifBytes,
  imageFile,
  jpegBytes,
  pngBytes,
  svgBytes,
  textBytes,
  webpBytes,
  fileForm,
} from "./helpers/stage3Fixtures.js";

const { default: app } = await import("../src/index.js");
const { AuditLog, Department, Template, Tenant, User } = await import(
  "../src/models/index.js"
);
const { startServer, stopServer, cookieFor, forgedCookieFor, request } = await import(
  "./helpers/stage2Http.js"
);
const { assetsDir, resolveAsset, safeUploadFilename, uploadsDir } = await import(
  "../src/lib/storage.js"
);

const TEST_DB = "markly_stage3_upload_security_test";
const PREFIX = "stage3-upload";
const COLLEGE_A = `${PREFIX}-college-a`;
const COLLEGE_B = `${PREFIX}-college-b`;
const BRANCH_A1 = `${PREFIX}-branch-a1`;

let db;
let server;
let base;
let platformAdmin;
let collegeAdminA;
let ordinaryA;
let existingUploads = new Set();

function api(user, method, path, body, headers = {}) {
  return request(base, method, path, {
    ...(user ? { cookie: cookieFor(user) } : {}),
    body,
    headers,
  });
}

function upload(user, file, fields = {}) {
  return request(base, "POST", "/api/v1/admin/assets", {
    ...(user ? { cookie: cookieFor(user) } : {}),
    body: fileForm(fields, file),
  });
}

async function cleanup() {
  await User.deleteMany({ email: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
  await Template.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Department.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await Tenant.deleteMany({ id: new RegExp(`^${PREFIX}-`) });
  await AuditLog.deleteMany({ actorEmail: new RegExp(`^${PREFIX}-.*@example\\.com$`) });
}

async function removeNewUploads() {
  let entries = [];
  try {
    entries = await readdir(uploadsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (existingUploads.has(entry)) continue;
    await unlink(join(uploadsDir, entry)).catch(() => {});
  }
}

before(async () => {
  db = await connectStage3TestDb(TEST_DB);
  await db.dropDatabase();

  try {
    existingUploads = new Set(await readdir(uploadsDir));
  } catch {
    existingUploads = new Set();
  }

  platformAdmin = await User.create({
    id: `${PREFIX}-usr-platform`,
    email: `${PREFIX}-platform@example.com`,
    name: "Stage3 Upload Platform",
    role: "platform_admin",
  });
  collegeAdminA = await User.create({
    id: `${PREFIX}-usr-college-a`,
    email: `${PREFIX}-college-a@example.com`,
    name: "Stage3 Upload College A",
    role: "college_admin",
    collegeAdminOf: [COLLEGE_A],
    tenantIds: [COLLEGE_A],
  });
  ordinaryA = await User.create({
    id: `${PREFIX}-usr-user-a`,
    email: `${PREFIX}-user-a@example.com`,
    name: "Stage3 Upload Ordinary A",
    role: "user",
    tenantIds: [COLLEGE_A],
    preferences: { collegeId: COLLEGE_A, departmentId: BRANCH_A1 },
  });

  await Tenant.create([
    { id: COLLEGE_A, name: "Stage3 Upload College A", slug: "stage3-upload-college-a" },
    { id: COLLEGE_B, name: "Stage3 Upload College B", slug: "stage3-upload-college-b" },
  ]);
  await Department.create([
    { id: BRANCH_A1, tenantId: COLLEGE_A, name: "A1", slug: "a1" },
  ]);

  ({ server, base } = await startServer(app));
});

after(async () => {
  await stopServer(server);
  await cleanup().catch(() => {});
  await removeNewUploads().catch(() => {});
  await db?.dropDatabase().catch(() => {});
  await disconnectStage3TestDb();
});

describe("STAGE 3 asset upload security", () => {
  it("requires a persisted administrator and stores accepted images under /assets/uploads", async () => {
    const anonymous = await upload(null, imageFile(pngBytes(), "anon.png"));
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.data));

    const ordinary = await upload(ordinaryA, imageFile(pngBytes(), "user.png"));
    assert.equal(ordinary.status, 403, JSON.stringify(ordinary.data));

    const forged = await request(base, "POST", "/api/v1/admin/assets", {
      cookie: forgedCookieFor(ordinaryA, { role: "platform_admin" }),
      body: fileForm({}, imageFile(pngBytes(), "forged.png")),
    });
    assert.equal(forged.status, 403, JSON.stringify(forged.data));

    for (const [buffer, name, type, expected] of [
      [pngBytes(), "artwork.png", "image/png", { extension: ".png", mimeType: "image/png" }],
      [jpegBytes(), "photo.jpg", "image/jpeg", { extension: ".jpg", mimeType: "image/jpeg" }],
      [gifBytes(), "animation.gif", "image/gif", { extension: ".gif", mimeType: "image/gif" }],
      [webpBytes(), "picture.webp", "image/webp", { extension: ".webp", mimeType: "image/webp" }],
    ]) {
      const response = await upload(
        collegeAdminA,
        imageFile(buffer, name, type),
      );
      assert.equal(response.status, 201, `${name}: ${JSON.stringify(response.data)}`);
      assert.match(
        response.data.asset.url,
        new RegExp(`^/assets/uploads/[a-z0-9_-]+\\${expected.extension}$`),
      );
      assert.equal(response.data.asset.mimeType, expected.mimeType);
      assert.equal(response.data.asset.size, buffer.length);

      const filename = response.data.asset.url.split("/").pop();
      const full = join(uploadsDir, filename);
      assert.equal(existsSync(full), true, "the accepted image must be written to disk");
      assert.equal(resolve(full).startsWith(`${resolve(uploadsDir)}`), true);

      const served = await request(base, "GET", response.data.asset.url);
      assert.equal(served.status, 200, `${name}: static serving failed`);
      assert.match(served.contentType, new RegExp(`^${expected.mimeType}`));
      assert.equal(served.buffer.equals(buffer), true);
    }

    const platformUpload = await upload(platformAdmin, imageFile(pngBytes(), "platform.png"));
    assert.equal(platformUpload.status, 201, JSON.stringify(platformUpload.data));
  });

  it("sanitizes hostile filenames and never writes outside the uploads directory", async () => {
    const names = [
      "../../../../evil script.png",
      "..\\..\\windows\\system32\\evil.png",
      "<img src=x onerror=alert(1)>.png",
      "..%2f..%2fencoded.png",
      "   .png",
    ];

    for (const originalName of names) {
      const response = await upload(
        collegeAdminA,
        imageFile(pngBytes(), originalName),
      );
      assert.equal(response.status, 201, `${originalName}: ${JSON.stringify(response.data)}`);
      const url = response.data.asset.url;
      assert.match(url, /^\/assets\/uploads\/[a-z0-9_-]+\.png$/);
      assert.equal(url.includes(".."), false);
      assert.equal(url.includes("\\"), false);
      assert.equal(url.includes("%"), false);
      assert.equal(url.includes(" "), false);

      const filename = url.split("/").pop();
      assert.equal(filename.startsWith("."), false);
      const full = resolve(join(uploadsDir, filename));
      assert.equal(full.startsWith(`${resolve(uploadsDir)}${sep}`), true);
      assert.equal(existsSync(full), true);
    }

    // Every newly-created file must live directly in uploads/, never beside it.
    const entries = await readdir(uploadsDir);
    const created = entries.filter((entry) => !existingUploads.has(entry));
    assert.equal(created.length > 0, true);
    for (const entry of created) {
      assert.match(entry, /^[a-z0-9_-]+\.[a-z0-9]+$/);
      assert.equal(existsSync(join(uploadsDir, entry)), true);
    }
    assert.equal(existsSync(join(assetsDir, "evil-script.png")), false);
    assert.equal(existsSync(join(assetsDir, "package.json")), false);
  });

  it("rejects SVG, spoofed, empty, missing and oversized images without writing files", async () => {
    const before = new Set(await readdir(uploadsDir));

    const cases = [
      ["svg extension", imageFile(svgBytes(), "logo.svg", "image/svg+xml")],
      ["svg disguised as png", imageFile(svgBytes(), "logo.png", "image/png")],
      ["xml disguised as png", imageFile(Buffer.from("<?xml version=\"1.0\"?><svg/>"), "logo.png", "image/png")],
      ["text disguised as png", imageFile(textBytes("plain text"), "fake.png", "image/png")],
      ["png with svg extension", imageFile(pngBytes(), "logo.svg", "image/png")],
      ["png with svg mime", imageFile(pngBytes(), "logo.png", "image/svg+xml")],
      ["empty file", imageFile(Buffer.alloc(0), "empty.png", "image/png")],
      [
        "oversized image",
        imageFile(
          Buffer.concat([pngBytes(), Buffer.alloc(5 * 1024 * 1024, 0)]),
          "huge.png",
          "image/png",
        ),
      ],
    ];

    for (const [label, file] of cases) {
      const response = await upload(collegeAdminA, file);
      assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.data)}`);
      assert.ok(response.data.error, `${label}: expected an error message`);
    }

    const missing = await request(base, "POST", "/api/v1/admin/assets", {
      cookie: cookieFor(collegeAdminA),
      body: fileForm({ note: "no file attached" }),
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.data));

    const after = new Set(await readdir(uploadsDir));
    assert.deepEqual([...after].sort(), [...before].sort(), "rejected uploads must not be stored");
  });

  it("validates asset references and preserves old files referenced by immutable versions", async () => {
    const first = await upload(collegeAdminA, imageFile(pngBytes(), "header-one.png"));
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const second = await upload(collegeAdminA, imageFile(pngBytes(), "watermark-two.png"));
    assert.equal(second.status, 201, JSON.stringify(second.data));

    const created = await api(collegeAdminA, "POST", "/api/v1/templates", {
      name: "Stage3 Upload Immutable Assets",
      scope: "college",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      header: { image: first.data.asset.url, alt: "Header", height: "72px" },
      watermark: { image: second.data.asset.url, opacity: 0.5 },
      assets: { logo: first.data.asset.url },
      status: "draft",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;
    assert.equal(created.data.template.header.image, first.data.asset.url);

    const published = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/publish`,
      {
        header: { image: second.data.asset.url, alt: "New header", height: "72px" },
        watermark: { image: first.data.asset.url, opacity: 0.5 },
        assets: { logo: second.data.asset.url },
      },
    );
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.template.version, 2);

    const v1 = await Template.findOne({ id, version: 1 }).lean();
    assert.equal(v1.header.image, first.data.asset.url);
    assert.equal(v1.watermark.image, second.data.asset.url);
    assert.equal(existsSync(resolveAsset(v1.header.image)), true);
    assert.equal(existsSync(resolveAsset(v1.watermark.image)), true);

    const archived = await api(
      collegeAdminA,
      "POST",
      `/api/v1/templates/${id}/archive`,
      {},
    );
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.equal(existsSync(resolveAsset(v1.header.image)), true);
    assert.equal(existsSync(resolveAsset(v1.watermark.image)), true);

    const unsafeRefs = [
      { header: { image: "https://evil.example/header.png" } },
      { header: { image: "http://evil.example/header.png" } },
      { header: { image: "javascript:alert(1)" } },
      { header: { image: "/assets/../package.json" } },
      { header: { image: "/assets/uploads/../package.json" } },
      { header: { image: "/assets/uploads/%2e%2e/package.json" } },
      { header: { image: "/assets/uploads/header.svg" } },
      { header: { image: "/assets//tcet-header.png" } },
      { header: { image: "C:\\Windows\\win.ini" } },
      { watermark: { image: "data:image/png;base64,AAAA" } },
      { assets: { logo: "/assets/uploads/../../secret.png" } },
    ];
    for (const body of unsafeRefs) {
      const response = await api(
        collegeAdminA,
        "PUT",
        `/api/v1/templates/${id}`,
        { ...body, status: "draft" },
      );
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(body)} => ${response.status} ${JSON.stringify(response.data)}`,
      );
    }

    const privateTemplate = await api(ordinaryA, "POST", "/api/v1/templates", {
      name: "Stage3 Upload Private Asset",
      tenantId: COLLEGE_A,
      departmentId: BRANCH_A1,
      header: { image: first.data.asset.url },
    });
    assert.equal(privateTemplate.status, 201, JSON.stringify(privateTemplate.data));
    const privateId = privateTemplate.data.template.id;

    for (const outsider of [ordinaryA, collegeAdminA, platformAdmin]) {
      const preview = await api(outsider, "GET", `/api/v1/templates/${privateId}/preview`);
      if (outsider === ordinaryA) {
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
      } else {
        assert.equal(preview.status, 403, JSON.stringify(preview.data));
      }
    }

    assert.equal(existsSync(resolveAsset(first.data.asset.url)), true);
    assert.equal(existsSync(resolveAsset(second.data.asset.url)), true);
  });

  it("blocks path traversal and encoded traversal through the static asset route", async () => {
    const first = await upload(collegeAdminA, imageFile(pngBytes(), "static-safe.png"));
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const filename = first.data.asset.url.split("/").pop();

    const safe = await request(base, "GET", `/assets/uploads/${filename}`);
    assert.equal(safe.status, 200);
    assert.match(safe.contentType, /^image\/png/);

    const traversalPaths = [
      "/assets/%2e%2e%2fpackage.json",
      "/assets/..%2fpackage.json",
      "/assets/uploads/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/uploads/..%2f..%2fpackage.json",
      "/assets/uploads/%2e%2e%5c%2e%2e%5cpackage.json",
      "/assets/..%5cpackage.json",
      "/assets/uploads/..%5c..%5cpackage.json",
    ];
    for (const path of traversalPaths) {
      const response = await request(base, "GET", path);
      assert.notEqual(response.status, 200, `${path} must not be served`);
      assert.equal(
        [400, 403, 404].includes(response.status),
        true,
        `${path} => ${response.status}`,
      );
      assert.equal(response.text.includes("\"name\""), false);
      assert.equal(response.text.includes("dependencies"), false);
    }

    assert.equal(resolveAsset("/assets/../package.json"), null);
    assert.equal(resolveAsset("/assets/uploads/../../package.json"), null);
    assert.equal(resolveAsset("/assets/%2e%2e/package.json"), null);
    assert.equal(resolveAsset("/assets//tcet-header.png"), null);
    assert.equal(resolveAsset("C:\\Windows\\win.ini"), null);
    assert.equal(resolveAsset("/assets/uploads/evil.svg"), null);
    assert.ok(resolveAsset("/assets/tcet-header.png"));

    for (const name of ["../../evil.png", "..\\..\\evil.png", "<script>.png"]) {
      const safeName = safeUploadFilename(name, ".png");
      assert.match(safeName, /^[a-z0-9_-]+-[a-f0-9-]{12}\.png$/);
      assert.equal(safeName.includes(".."), false);
      assert.equal(safeName.includes("/"), false);
      assert.equal(safeName.includes("\\"), false);
    }
  });
});
