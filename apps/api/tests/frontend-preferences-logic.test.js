// STAGE 4 — hermetic frontend preference/template logic tests.
//
// These pin the pure selection rules used by the first-time setup modal and
// the assignment create dialog. No DOM, no network, no MongoDB: the same
// helpers are imported from src and the JSX surfaces are checked statically so
// the "no generic default option" and "preserve the brief" contracts cannot
// silently regress.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildScopedTemplateChoices,
  buildTemplateChoices,
  branchDefaultTemplate,
  describePreferencesSummary,
  effectiveDefaultTemplate,
  filterEligibleTemplates,
  initialTemplateSelection,
  isPrivateOnly,
  isSelectionAvailable,
  isTemplateEligible,
  isUsableTemplate,
  normalizeTemplate,
  setupCompleted,
  templateKey,
  templateLabel,
} from "../../../src/features/preferences/preferences.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const readSrc = (path) => readFileSync(join(root, path), "utf8");

const COLLEGE = "college-a";
const BRANCH = "branch-a1";

function template(overrides = {}) {
  return {
    id: "tpl-a",
    version: 1,
    name: "Template A",
    status: "active",
    scope: "college",
    tenantId: COLLEGE,
    departmentId: BRANCH,
    ownerUserId: null,
    ...overrides,
  };
}

const PREFERRED = template({ id: "tpl-preferred", version: 2, name: "Preferred" });
const BRANCH_DEFAULT = template({ id: "tpl-default", version: 1, name: "Default" });
const OTHER = template({ id: "tpl-other", version: 1, name: "Other" });
const PLATFORM = template({
  id: "tpl-platform",
  scope: "platform",
  tenantId: null,
  departmentId: null,
});
const PRIVATE = template({
  id: "tpl-private",
  scope: "private",
  tenantId: null,
  departmentId: null,
  ownerUserId: "user-a",
});

const PREFERENCES = {
  setupCompleted: true,
  preferences: {
    collegeId: COLLEGE,
    departmentId: BRANCH,
    preferredTemplateId: PREFERRED.id,
    preferredTemplateVersion: PREFERRED.version,
    setupCompletedAt: "2026-01-02T03:04:05.000Z",
  },
  college: { id: COLLEGE, name: "College A" },
  branch: { id: BRANCH, name: "Branch A1", defaultTemplate: BRANCH_DEFAULT },
  preferredTemplate: PREFERRED,
};

describe("STAGE 4 template eligibility helpers", () => {
  it("normalizes exact id/version keys and rejects malformed versions", () => {
    assert.equal(templateKey(PREFERRED), "tpl-preferred@2");
    assert.equal(normalizeTemplate({ id: "x", version: "3" }).version, 3);
    assert.equal(normalizeTemplate({ id: "x", version: 0 }), null);
    assert.equal(normalizeTemplate({ id: "x", version: "latest" }), null);
    assert.equal(templateKey(null), "");
  });

  it("offers only published college templates from the selected college/branch plus platform/private", () => {
    const eligible = filterEligibleTemplates(
      [
        BRANCH_DEFAULT,
        OTHER,
        PLATFORM,
        PRIVATE,
        template({ id: "tpl-draft", status: "draft" }),
        template({ id: "tpl-archived", status: "archived" }),
        template({ id: "tpl-legacy", scope: "legacy" }),
        template({ id: "tpl-foreign", tenantId: "college-b" }),
        template({ id: "tpl-other-branch", departmentId: "branch-b1" }),
      ],
      { collegeId: COLLEGE, departmentId: BRANCH },
    );
    assert.deepEqual(
      eligible.map((item) => item.id).sort(),
      [BRANCH_DEFAULT.id, OTHER.id, PLATFORM.id, PRIVATE.id].sort(),
    );
    assert.equal(isTemplateEligible(OTHER, { collegeId: COLLEGE, departmentId: BRANCH }), true);
    assert.equal(isTemplateEligible(OTHER, { collegeId: null, departmentId: null }), false);
    assert.equal(isUsableTemplate({ ...OTHER, available: false }), true, "available is a server hint, not a status");
  });

  it("builds choices in preferred → branch default → other order without duplicates", () => {
    const choices = buildScopedTemplateChoices({
      templates: [OTHER, BRANCH_DEFAULT, PREFERRED, PLATFORM],
      preferredTemplate: PREFERRED,
      branchDefault: BRANCH_DEFAULT,
      collegeId: COLLEGE,
      departmentId: BRANCH,
    });
    assert.deepEqual(
      choices.map((item) => item.id),
      [PREFERRED.id, BRANCH_DEFAULT.id, OTHER.id, PLATFORM.id],
    );
    assert.equal(choices[0].isPreferred, true);
    assert.equal(choices[1].isBranchDefault, true);
  });

  it("drops a stale preference so the branch default can take its place", () => {
    const stale = { ...PREFERRED, available: false };
    const choices = buildScopedTemplateChoices({
      templates: [BRANCH_DEFAULT, OTHER],
      preferredTemplate: stale,
      branchDefault: BRANCH_DEFAULT,
      collegeId: COLLEGE,
      departmentId: BRANCH,
    });
    assert.equal(choices[0].id, BRANCH_DEFAULT.id);
    assert.equal(choices[0].isBranchDefault, true);
    assert.ok(!choices.some((item) => item.isPreferred));

    const archivedPreference = buildScopedTemplateChoices({
      templates: [BRANCH_DEFAULT],
      preferredTemplate: { ...PREFERRED, status: "archived" },
      branchDefault: BRANCH_DEFAULT,
      collegeId: COLLEGE,
      departmentId: BRANCH,
    });
    assert.deepEqual(archivedPreference.map((item) => item.id), [BRANCH_DEFAULT.id]);
  });
});

describe("STAGE 4 create-dialog preselection", () => {
  it("preselects the saved preference at its exact pinned version", () => {
    const selection = initialTemplateSelection({
      templates: [OTHER, BRANCH_DEFAULT],
      preferences: PREFERENCES,
    });
    assert.deepEqual(selection, { templateId: PREFERRED.id, templateVersion: "2" });
  });

  it("uses the exact branch default when no preference is saved", () => {
    const selection = initialTemplateSelection({
      templates: [template({ id: "tpl-default", version: 2 }), OTHER],
      preferences: { ...PREFERENCES, preferredTemplate: null },
    });
    assert.deepEqual(selection, { templateId: BRANCH_DEFAULT.id, templateVersion: "1" });
  });

  it("honours an explicit prefill only when that exact template/version is eligible", () => {
    const prefill = initialTemplateSelection({
      templates: [OTHER, BRANCH_DEFAULT],
      preferences: PREFERENCES,
      requestedTemplateId: OTHER.id,
    });
    assert.deepEqual(prefill, { templateId: OTHER.id, templateVersion: "1" });

    const pinned = initialTemplateSelection({
      templates: [
        OTHER,
        template({ id: OTHER.id, version: 2, name: "Other v2" }),
        BRANCH_DEFAULT,
      ],
      preferences: PREFERENCES,
      requestedTemplateId: OTHER.id,
      requestedTemplateVersion: 2,
    });
    assert.deepEqual(pinned, { templateId: OTHER.id, templateVersion: "2" });

    const unavailable = initialTemplateSelection({
      templates: [OTHER],
      preferences: PREFERENCES,
      requestedTemplateId: "tpl-not-eligible",
    });
    assert.deepEqual(unavailable, { templateId: PREFERRED.id, templateVersion: "2" });

    const staleVersion = initialTemplateSelection({
      templates: [OTHER, BRANCH_DEFAULT],
      preferences: PREFERENCES,
      requestedTemplateId: OTHER.id,
      requestedTemplateVersion: 9,
    });
    assert.deepEqual(staleVersion, { templateId: PREFERRED.id, templateVersion: "2" });
  });

  it("falls back to the first eligible template and keeps selections version-exact", () => {
    const selection = initialTemplateSelection({
      templates: [PLATFORM, OTHER],
      preferences: { setupCompleted: true, preferences: {}, college: null, branch: null },
    });
    assert.deepEqual(selection, { templateId: PLATFORM.id, templateVersion: "1" });

    const choices = buildTemplateChoices({
      templates: [
        template({ id: "tpl-x", version: 1, scope: "platform", tenantId: null, departmentId: null }),
        template({ id: "tpl-x", version: 2, scope: "platform", tenantId: null, departmentId: null }),
      ],
      preferences: null,
    });
    assert.equal(isSelectionAvailable({ templateId: "tpl-x", templateVersion: "1" }, choices), true);
    assert.equal(isSelectionAvailable({ templateId: "tpl-x", templateVersion: "2" }, choices), true);
    assert.equal(isSelectionAvailable({ templateId: "tpl-x", templateVersion: "3" }, choices), false);
    assert.equal(isSelectionAvailable({ templateId: "", templateVersion: "" }, choices), false);
  });

  it("labels the preferred/default tags without offering a generic default", () => {
    assert.match(templateLabel(PREFERRED, { preferred: true }), /your preference/);
    assert.match(templateLabel(BRANCH_DEFAULT, { branchDefault: true }), /branch default/);
    assert.match(templateLabel(PLATFORM), /platform/);
    assert.match(templateLabel(PRIVATE), /private/);
  });
});

describe("STAGE 4 setup/profile helpers", () => {
  it("detects completed setup, private-only mode and a readable summary", () => {
    assert.equal(setupCompleted(PREFERENCES), true);
    assert.equal(setupCompleted({ setupCompleted: false }), false);
    assert.equal(isPrivateOnly(PREFERENCES), false);
    assert.equal(
      isPrivateOnly({
        setupCompleted: true,
        preferences: { collegeId: null, departmentId: null },
      }),
      true,
    );
    assert.equal(
      describePreferencesSummary(PREFERENCES),
      "College A · Branch A1",
    );
    assert.equal(describePreferencesSummary({ setupCompleted: false }), "Not configured");
    assert.equal(
      describePreferencesSummary({
        setupCompleted: true,
        preferences: { collegeId: null, departmentId: null },
      }),
      "Private and platform templates",
    );
    assert.equal(effectiveDefaultTemplate(PREFERENCES).id, PREFERRED.id);
    assert.equal(branchDefaultTemplate(PREFERENCES).id, BRANCH_DEFAULT.id);
    assert.equal(branchDefaultTemplate({ branch: { defaultTemplate: null } }), null);
  });
});

describe("STAGE 4 frontend wiring pins", () => {
  const createModal = readSrc("src/features/assignments/CreateModal.jsx");
  const preferencesModal = readSrc("src/features/preferences/PreferencesModal.jsx");
  const app = readSrc("src/App.jsx");
  const profile = readSrc("src/features/auth/ProfileMenu.jsx");
  const ui = readSrc("src/components/ui.jsx");

  it("removes the generic default option and pins the exact version when submitting", () => {
    assert.ok(
      !createModal.includes("Default (active template)"),
      "the generic default option must stay removed",
    );
    assert.ok(createModal.includes("templateVersion: selection.templateVersion"));
    assert.ok(createModal.includes("onOpenPreferences"));
    assert.ok(
      createModal.includes("isSelectionAvailable(previous, choices)"),
      "an in-progress brief must keep its still-valid selection",
    );
    assert.ok(
      createModal.includes("setForm((previous) =>"),
      "opening preferences must not reset aim/description",
    );
  });

  it("filters branches by college and exposes the private-only path", () => {
    assert.ok(preferencesModal.includes("selectedCollege?.branches"));
    assert.ok(preferencesModal.includes("My college isn’t listed"));
    assert.ok(preferencesModal.includes("branchDefault"));
    assert.ok(preferencesModal.includes("preferredTemplateVersion: selectedChoice?.version ?? null"));
  });

  it("wires setup, profile settings, stacked modal and session refresh", () => {
    assert.ok(app.includes("PreferencesModal"));
    assert.ok(app.includes("setupCompleted === false"));
    assert.ok(app.includes("auth.refreshSession()"));
    assert.ok(app.includes("onOpenPreferences"));
    assert.ok(app.includes("templateVersion: form.templateVersion"));
    assert.ok(app.includes("setupDismissed"));
    assert.ok(profile.includes("College &amp; branch"));
    assert.ok(profile.includes("describePreferencesSummary"));
    assert.ok(ui.includes("stacked"), "ModalShell must support stacking preferences over create");
  });
});
