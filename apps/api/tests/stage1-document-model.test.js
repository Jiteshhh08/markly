import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOCUMENT_SCHEMA_VERSION,
  documentSchema,
  normalizeAndValidateDocument,
  normalizeDocument,
  parseDocument,
} from "../src/lib/documentModel.js";
import { assignmentContentSchema } from "../src/schemas.js";

const content = {
  experimentNumber: 3,
  title: "Explore SQL subqueries",
  aim: "Explore SQL subqueries in a practical",
  objectives: ["Understand nested queries"],
  theory: ["A subquery is a query nested inside another query."],
  steps: [
    {
      number: 1,
      title: "Create tables",
      description: ["Create the sample tables first."],
      code: null,
      language: null,
    },
  ],
  conclusion: "Subqueries were explored and outputs recorded.",
  metadata: {},
};

const templateDoc = {
  template: {
    id: "tpl_stage1",
    version: 2,
    name: "Stage 1 template",
    tenantId: "college-a",
    departmentId: "dept-a1",
    scope: "college",
    page: { size: "A4", margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" } },
    typography: { fontFamily: "Georgia", baseSize: "12pt", lineHeight: 1.5 },
    header: { image: "/assets/header.png", everyPage: true },
    requiredSections: ["title", "aim", "theory", "steps", "conclusion"],
  },
};

describe("STAGE 1 canonical document normalization", () => {
  it("normalizes a current record and snapshots the exact template layout", () => {
    const record = {
      id: "asg_stage1_current",
      userId: "usr_owner",
      tenantId: "college-a",
      departmentId: "dept-a1",
      content,
      template: { id: "tpl_stage1", version: 2, name: "Stage 1 template" },
      options: { includeVivaTitle: true, typedConclusion: false },
    };
    const snapshot = structuredClone(record);

    const doc = normalizeDocument(record, templateDoc);

    assert.equal(doc.schemaVersion, DOCUMENT_SCHEMA_VERSION);
    assert.equal(doc.assignmentId, "asg_stage1_current");
    assert.equal(doc.ownerUserId, "usr_owner");
    assert.equal(doc.collegeId, "college-a");
    assert.equal(doc.branchId, "dept-a1");
    assert.deepEqual(doc.content, content);
    assert.equal(doc.template.id, "tpl_stage1");
    assert.equal(doc.template.version, 2);
    assert.equal(doc.template.scope, "college");
    assert.equal(doc.template.collegeId, "college-a");
    assert.equal(doc.template.branchId, "dept-a1");
    assert.equal(doc.layout.page.size, "A4");
    assert.equal(doc.layout.typography.fontFamily, "Georgia");
    assert.deepEqual(doc.presentation, { includeVivaTitle: true, typedConclusion: false });
    assert.equal(doc.normalization.source, "current");
    assert.equal(doc.normalization.legacy, false);
    assert.equal(doc.normalization.missingTemplate, false);
    assert.equal(doc.normalization.missingLayout, false);

    assert.equal(documentSchema.safeParse(doc).success, true);
    assert.deepEqual(record, snapshot, "normalization must never mutate the record");
  });

  it("normalizes legacy generatedContent without inventing ownership or layout", () => {
    const legacy = {
      _id: "mongo-object-id",
      id: "asg_stage1_legacy",
      userId: "usr_legacy",
      generatedContent: content,
      input: { includeVivaTitle: true, typedConclusion: false },
      template: { id: "legacy-tpl", version: 1 },
    };

    const doc = normalizeDocument(legacy);

    assert.deepEqual(doc.content, content);
    assert.equal(doc.normalization.source, "legacy");
    assert.equal(doc.normalization.legacy, true);
    assert.equal(doc.normalization.missingContent, false);
    assert.equal(doc.normalization.missingTemplate, false);
    assert.equal(doc.normalization.missingVersion, false);
    assert.equal(doc.normalization.missingLayout, true);
    assert.equal(doc.template.id, "legacy-tpl");
    assert.equal(doc.template.version, 1);
    assert.equal(doc.template.scope, undefined, "scope must not be invented");
    assert.equal(doc.template.collegeId, null, "college ownership must not be invented");
    assert.equal(doc.template.branchId, null);
    assert.equal(doc.collegeId, null);
    assert.equal(doc.layout, null);
    assert.deepEqual(doc.presentation, { includeVivaTitle: true, typedConclusion: false });
    assert.equal(documentSchema.safeParse(doc).success, true);
  });

  it("keeps a missing template explicit instead of substituting the latest", () => {
    const doc = normalizeDocument({ id: "asg_stage1_no_template", content });
    assert.equal(doc.template, null);
    assert.equal(doc.layout, null);
    assert.equal(doc.normalization.missingTemplate, true);
    assert.equal(doc.normalization.missingVersion, true);
    assert.equal(doc.normalization.missingLayout, true);
    assert.equal(doc.normalization.legacy, true);
    assert.equal(documentSchema.safeParse(doc).success, true);
  });

  it("never applies a different template version's layout", () => {
    const doc = normalizeDocument(
      {
        id: "asg_stage1_mismatch",
        content,
        template: { id: "tpl_stage1", version: 1 },
      },
      templateDoc,
    );
    assert.equal(doc.template.version, 1);
    assert.equal(doc.template.scope, undefined);
    assert.equal(doc.layout, null);
    assert.equal(doc.normalization.missingLayout, true);
  });

  it("preserves missing content as null with documented presentation defaults", () => {
    const doc = normalizeDocument({
      id: "asg_stage1_empty",
      template: { id: "tpl_stage1", version: 2 },
    });
    assert.equal(doc.content, null);
    assert.equal(doc.normalization.source, "unknown");
    assert.equal(doc.normalization.missingContent, true);
    assert.deepEqual(doc.presentation, { includeVivaTitle: false, typedConclusion: true });
    assert.deepEqual(doc.normalization.defaultsApplied, [
      "presentation.includeVivaTitle",
      "presentation.typedConclusion",
    ]);
    assert.equal(documentSchema.safeParse(doc).success, true);
  });

  it("does not fabricate page/typography defaults from an identity-only template", () => {
    const doc = normalizeDocument(
      { id: "asg_stage1_identity", content, template: { id: "tpl_stage1", version: 2 } },
      { template: { id: "tpl_stage1", version: 2, name: "Identity only" } },
    );
    assert.equal(doc.layout, null);
    assert.equal(doc.normalization.missingLayout, true);

    const headerOnly = normalizeDocument(
      { id: "asg_stage1_header", content, template: { id: "tpl_stage1", version: 2 } },
      { template: { id: "tpl_stage1", version: 2, header: { image: "/h.png" } } },
    );
    assert.deepEqual(headerOnly.layout, { header: { image: "/h.png" } });
    assert.equal(headerOnly.layout.page, undefined);
    assert.equal(headerOnly.layout.typography, undefined);
    assert.equal(headerOnly.normalization.missingLayout, true);
    assert.equal(documentSchema.safeParse(headerOnly).success, true);
  });

  it("requires an assignment id and validates through the exported schema", () => {
    assert.throws(() => normalizeDocument({ content }), /assignment id/);
    assert.equal(parseDocument({}).success, false);
    assert.equal(normalizeAndValidateDocument({ id: "asg_stage1_valid", content }).assignmentId, "asg_stage1_valid");
  });
});

describe("STAGE 1 document schema is independent of academic content", () => {
  it("ships a JSON schema with presentation fields, not Qwen/Pydantic fields", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../../../packages/shared/document.schema.json", import.meta.url), "utf8"),
    );
    assert.equal(schema.title, "AssignmentDocument");
    assert.ok(schema.properties.content, "content snapshot must be present");
    for (const generationField of ["aim", "title", "theory", "steps", "conclusion", "objectives"]) {
      assert.equal(schema.properties[generationField], undefined, `${generationField} must stay in the AI schema`);
    }
    assert.ok(String(schema.properties.content.description).includes("assignment.schema.json"));
  });

  it("accepts academic content as an opaque snapshot without adding layout fields to it", () => {
    const doc = normalizeDocument({ id: "asg_stage1_opaque", content });
    const parsed = documentSchema.parse(doc);
    assert.deepEqual(parsed.content, content);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed.content, "layout"), false);

    const academic = assignmentContentSchema.safeParse(content);
    assert.equal(academic.success, true, "the independent academic schema still validates the content");
    assert.equal(Object.prototype.hasOwnProperty.call(academic.data, "schemaVersion"), false);
  });
});
