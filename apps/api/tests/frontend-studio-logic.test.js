// STAGE 5 — hermetic frontend document-studio tests.
//
// Pure editor helpers are imported directly (no DOM), while the JSX surfaces
// are pinned statically so the save/export/discard contracts cannot silently
// regress. The transport test stubs fetch to verify revision/block payloads
// and error metadata without a running API.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCK_TYPES,
  blockOutlineText,
  canExportDocument,
  clearBlockStyle,
  cloneBlock,
  commitHistory,
  createBlock,
  createHistory,
  deleteBlock,
  documentSaveStatus,
  duplicateBlock,
  exportBlockedMessage,
  insertBlockAt,
  isDocumentDirty,
  moveBlock,
  moveBlockToIndex,
  paginateBlocks,
  redoHistory,
  serializeBlocks,
  undoHistory,
  updateBlockContent,
  updateBlockStyle,
  updateListItems,
} from "../../../src/features/studio/documentEditor.js";
import {
  describeDocumentError,
  saveAssignmentDocument,
} from "../../../src/features/studio/documentApi.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const readSrc = (path) => readFileSync(join(root, path), "utf8");

function paragraph(id, text, extra = {}) {
  return { id, type: "paragraph", content: { text }, ...extra };
}

function ids(blocks) {
  return blocks.map((block) => block.id);
}

describe("STAGE 5 block construction and ordering", () => {
  it("supports every required block type with type-appropriate content", () => {
    assert.deepEqual(
      [...BLOCK_TYPES].sort(),
      [
        "bulletList",
        "code",
        "experimentNumber",
        "heading",
        "numberedList",
        "pageBreak",
        "paragraph",
        "spacer",
        "subheading",
        "title",
      ].sort(),
    );

    const pageBreak = createBlock("pageBreak", { id: "pb" });
    assert.deepEqual(pageBreak, { id: "pb", type: "pageBreak", content: {} });

    const spacer = createBlock("spacer", { id: "sp", height: 42 });
    assert.deepEqual(spacer.content, { height: 42 });

    const bullet = createBlock("bulletList", { id: "bl", items: ["one", "two"] });
    assert.deepEqual(bullet.content.items, ["one", "two"]);

    const code = createBlock("code", { id: "code", text: "a\n  b" });
    assert.equal(code.content.text, "a\n  b");
    assert.equal(code.content.language, null);
  });

  it("inserts, deletes, duplicates and moves blocks without mutating the input", () => {
    const original = [paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")];
    const inserted = insertBlockAt(original, paragraph("x", "X"), 1);
    assert.deepEqual(ids(inserted), ["a", "x", "b", "c"]);
    assert.deepEqual(ids(original), ["a", "b", "c"]);

    const deleted = deleteBlock(inserted, "b");
    assert.deepEqual(ids(deleted), ["a", "x", "c"]);
    assert.deepEqual(ids(inserted), ["a", "x", "b", "c"]);

    const duplicated = duplicateBlock(original, "b");
    assert.deepEqual(ids(duplicated.blocks), ["a", "b", duplicated.block.id, "c"]);
    assert.notEqual(duplicated.block.id, "b");

    const movedUp = moveBlock(original, "c", -1);
    assert.deepEqual(ids(movedUp), ["a", "c", "b"]);
    const movedDown = moveBlock(original, "a", 1);
    assert.deepEqual(ids(movedDown), ["b", "a", "c"]);
    const dropped = moveBlockToIndex(original, "a", 2);
    assert.deepEqual(ids(dropped), ["b", "c", "a"]);
    assert.deepEqual(ids(original), ["a", "b", "c"]);
  });

  it("strips generated provenance from manual duplicates", () => {
    const generated = {
      id: "gen",
      type: "paragraph",
      content: { text: "generated" },
      source: { section: "theory" },
      style: { align: "center" },
    };
    const manual = cloneBlock(generated, { id: "manual" });
    assert.equal(manual.source, undefined);
    assert.deepEqual(manual.style, { align: "center" });

    const kept = cloneBlock(generated, { id: "kept", keepSource: true });
    assert.deepEqual(kept.source, { section: "theory" });
  });
});

describe("STAGE 5 content, list and style editing", () => {
  it("edits list items and preserves code line breaks/indentation exactly", () => {
    const list = createBlock("numberedList", { id: "list", items: ["one"] });
    const editedList = updateListItems([list], "list", ["one", "two"]);
    assert.deepEqual(editedList[0].content.items, ["one", "two"]);

    const code = "if (ready) {\n\tconsole.log('yes');\n}";
    const block = createBlock("code", { id: "code", text: code });
    const edited = updateBlockContent([block], "code", { text: `${code}\n` });
    assert.equal(edited[0].content.text, `${code}\n`);
    assert.equal(block.content.text, code, "original block stays untouched");
  });

  it("applies validated style settings and removes cleared values", () => {
    const blocks = [paragraph("a", "A")];
    const styled = updateBlockStyle(blocks, "a", {
      align: "justify",
      fontSize: 14,
      spacingBefore: 12,
      spacingAfter: 6,
      indent: 20,
    });
    assert.deepEqual(styled[0].style, {
      align: "justify",
      fontSize: 14,
      spacingBefore: 12,
      spacingAfter: 6,
      indent: 20,
    });

    const clearedOne = updateBlockStyle(styled, "a", { fontSize: null, indent: undefined });
    assert.deepEqual(clearedOne[0].style, {
      align: "justify",
      spacingBefore: 12,
      spacingAfter: 6,
    });

    const clearedAll = clearBlockStyle(clearedOne, "a");
    assert.equal(clearedAll[0].style, undefined);
    assert.deepEqual(clearedOne[0].style, {
      align: "justify",
      spacingBefore: 12,
      spacingAfter: 6,
    });
  });
});

describe("STAGE 5 history and save state", () => {
  it("undoes and redoes edits, and a new edit clears the redo stack", () => {
    const initial = [paragraph("a", "A")];
    let history = createHistory(initial);
    history = commitHistory(history, [paragraph("a", "A edited")]);
    history = commitHistory(history, [paragraph("a", "A edited twice")]);

    assert.equal(history.present[0].content.text, "A edited twice");
    history = undoHistory(history);
    assert.equal(history.present[0].content.text, "A edited");
    history = undoHistory(history);
    assert.equal(history.present[0].content.text, "A");
    assert.equal(history.past.length, 0);
    history = undoHistory(history);
    assert.equal(history.present[0].content.text, "A", "undo at the start is a no-op");

    history = redoHistory(history);
    assert.equal(history.present[0].content.text, "A edited");
    history = commitHistory(history, [paragraph("a", "New branch")]);
    assert.deepEqual(history.future, []);
    history = redoHistory(history);
    assert.equal(history.present[0].content.text, "New branch");
  });

  it("detects dirty state and paginates on manual page breaks", () => {
    const blocks = [paragraph("a", "A"), paragraph("b", "B")];
    const saved = serializeBlocks(blocks);
    assert.equal(isDocumentDirty(blocks, saved), false);
    assert.equal(isDocumentDirty([paragraph("a", "A")], saved), true);
    assert.equal(isDocumentDirty(blocks, null), false);

    const paged = paginateBlocks([
      paragraph("a", "A"),
      { id: "break", type: "pageBreak", content: {} },
      paragraph("b", "B"),
    ]);
    assert.equal(paged.length, 2);
    assert.deepEqual(ids(paged[0]), ["a"]);
    assert.deepEqual(ids(paged[1]), ["b"]);
  });

  it("reports save status clearly", () => {
    assert.deepEqual(documentSaveStatus({ loading: true }), {
      key: "loading",
      label: "Loading…",
      tone: "neutral",
    });
    assert.equal(documentSaveStatus({ saving: true }).label, "Saving…");
    assert.equal(documentSaveStatus({ dirty: true }).label, "Unsaved changes");
    assert.equal(documentSaveStatus({ failed: true, dirty: true }).label, "Save failed");
    assert.equal(documentSaveStatus({ conflict: true }).label, "Save conflict");
    assert.equal(documentSaveStatus({}).label, "Saved");
  });
});

describe("STAGE 5 export gating", () => {
  it("blocks exports for unsaved, saving or conflicted documents", () => {
    assert.equal(canExportDocument({ dirty: true }), false);
    assert.equal(canExportDocument({ saving: true }), false);
    assert.equal(canExportDocument({ conflict: true }), false);
    assert.equal(canExportDocument({ dirty: false, saving: false, conflict: false }), true);

    assert.match(exportBlockedMessage({ dirty: true }), /save your changes/i);
    assert.match(exportBlockedMessage({ saving: true }), /save to finish/i);
    assert.match(exportBlockedMessage({ conflict: true }), /reload/i);
    assert.equal(exportBlockedMessage({}), "");
  });

  it("summarizes blocks for the outline without leaking multiline text", () => {
    assert.equal(blockOutlineText({ type: "pageBreak", content: {} }), "Page break");
    assert.match(blockOutlineText({ type: "spacer", content: { height: 30 } }), /30px/);
    assert.equal(blockOutlineText({ type: "bulletList", content: { items: ["a", "b"] } }), "2 items");
    assert.equal(blockOutlineText({ type: "paragraph", content: { text: "one\n two" } }), "one two");
  });
});

describe("STAGE 5 document transport", () => {
  it("sends revision and blocks and returns the saved document", async () => {
    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { document: { revision: 3, blocks: [{ id: "a", type: "paragraph", content: { text: "saved" } }] } };
        },
      };
    };
    try {
      const blocks = [paragraph("a", "saved")];
      const saved = await saveAssignmentDocument({
        apiBase: "http://stage5.test",
        recordId: "asg_stage5",
        revision: 2,
        schemaVersion: 2,
        blocks,
      });
      assert.equal(saved.revision, 3);
      assert.equal(captured.url, "http://stage5.test/api/v1/assignments/asg_stage5/document");
      assert.equal(captured.options.method, "PUT");
      const body = JSON.parse(captured.options.body);
      assert.deepEqual(body, { revision: 2, schemaVersion: 2, blocks });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces 409 conflicts and friendly save errors without losing metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      async json() {
        return {
          error: "This document changed since you opened it.",
          code: "document_conflict",
          revision: 9,
        };
      },
    });
    try {
      await assert.rejects(
        () =>
          saveAssignmentDocument({
            apiBase: "http://stage5.test",
            recordId: "asg_stage5",
            revision: 8,
            blocks: [],
          }),
        (error) => {
          assert.equal(error.status, 409);
          assert.equal(error.code, "document_conflict");
          assert.equal(error.revision, 9);
          return true;
        },
      );
      assert.match(describeDocumentError({ status: 409 }), /reload the latest version/i);
      assert.match(
        describeDocumentError(
          Object.assign(new Error("The document could not be saved."), { status: 503 }),
        ),
        /could not be saved/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("STAGE 5 studio wiring", () => {
  it("mounts the studio from the assignment drawer and app", () => {
    const drawer = readSrc("src/features/assignments/DetailDrawer.jsx");
    assert.ok(drawer.includes("onOpenStudio"), "drawer must expose the studio entry point");
    assert.ok(drawer.includes("Visual editor"), "drawer must have a visible studio action");
    assert.ok(drawer.includes("Visual document editor"), "drawer toolbar must have an accessible studio action");

    const app = readSrc("src/App.jsx");
    assert.ok(app.includes("DocumentStudio"), "App must import and render the studio");
    assert.ok(app.includes("studioKey"), "App must own the studio overlay state");
    assert.ok(app.includes("handleDocumentSaved"), "App must accept persisted document updates");
  });

  it("uses a responsive three-panel layout with accessible reordering", () => {
    const studio = readSrc("src/features/studio/DocumentStudio.jsx");
    assert.ok(studio.includes("BlockOutline"));
    assert.ok(studio.includes("BlockPreview"));
    assert.ok(studio.includes("BlockInspector"));
    assert.ok(studio.includes("lg:grid-cols-[280px_minmax(0,1fr)_320px]"));
    assert.ok(studio.includes("PanelTabs"), "small screens must expose panel tabs");
    assert.ok(studio.includes("role=\"dialog\""));

    const outline = readSrc("src/features/studio/BlockOutline.jsx");
    assert.ok(outline.includes("draggable"));
    assert.ok(outline.includes("onDrop"));
    assert.ok(outline.includes("aria-label={`Move"));
    assert.ok(outline.includes("arrowUp"));
    assert.ok(outline.includes("arrowDown"));

    const inspector = readSrc("src/features/studio/BlockInspector.jsx");
    assert.ok(inspector.includes("List items"));
    assert.ok(inspector.includes("wrap=\"off\""), "code editing must preserve line breaks/indentation");
    assert.ok(inspector.includes("Font size"));
    assert.ok(inspector.includes("Alignment"));
    assert.ok(inspector.includes("Space before"));
    assert.ok(inspector.includes("Space after"));
    assert.ok(inspector.includes("Indent"));
  });

  it("warns before discarding unsaved work and blocks unsaved exports", () => {
    const studio = readSrc("src/features/studio/DocumentStudio.jsx");
    assert.ok(studio.includes("beforeunload"), "refresh/navigation must warn about unsaved edits");
    assert.ok(studio.includes("Discard unsaved changes?"), "closing must confirm discarding local edits");
    assert.ok(studio.includes("canExportDocument"), "exports must consult the saved-state gate");
    assert.ok(studio.includes("exportBlockedMessage"), "exports must explain why they are blocked");
    assert.ok(
      studio.includes("disabled={!exportReady || exportBusy !== ''}"),
      "export buttons must be disabled while unsaved/saving/conflicted",
    );
    assert.ok(
      studio.includes("if (!exportReady)"),
      "the export handler must refuse to run with unsaved state",
    );
    assert.ok(studio.includes("Stage 6"), "the UI must not claim visual exports are already integrated");
  });

  it("keeps local edits and reports a failed save", () => {
    const studio = readSrc("src/features/studio/DocumentStudio.jsx");
    assert.ok(studio.includes("setSavePhase('saving')"));
    assert.ok(studio.includes("setSaveError(describeDocumentError(error))"));
    assert.ok(studio.includes("setSavePhase(error?.status === 409 ? 'conflict' : 'error')"));
    assert.ok(studio.includes("role=\"alert\""), "save failures must be visible");
    assert.ok(studio.includes("Retry save"), "failed saves must offer a retry");
    assert.ok(studio.includes("Reload latest"), "conflicts must offer reloading the newer document");

    const catchStart = studio.indexOf("} catch (error) {");
    const catchEnd = studio.indexOf("  }, [", catchStart);
    assert.ok(catchStart > -1 && catchEnd > catchStart, "save catch block must be present");
    const catchBlock = studio.slice(catchStart, catchEnd);
    assert.ok(!catchBlock.includes("setHistory"), "a failed save must not replace local edits");
    assert.ok(!catchBlock.includes("setDocument"), "a failed save must not claim the server accepted it");
  });
});
