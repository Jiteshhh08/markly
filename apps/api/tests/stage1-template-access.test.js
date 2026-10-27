import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canClaimLegacyTemplate,
  canCreateTemplate,
  canManageBranch,
  canManageCollege,
  canManageTemplate,
  canPublishTemplate,
  canSetBranchDefault,
  canSetTemplateStatus,
  canUseTemplate,
  canViewBranchTemplate,
  canViewTemplate,
  filterVisibleTemplates,
  isLegacyTemplate,
  isPublishedTemplate,
  templateScope,
} from "../src/lib/templateAccess.js";

const platform = {
  id: "usr_platform",
  role: "platform_admin",
  collegeAdminOf: [],
  preferences: null,
};
const collegeA = {
  id: "usr_college_a",
  role: "college_admin",
  collegeAdminOf: ["college-a"],
  preferences: { collegeId: "college-a", departmentId: "dept-a1" },
};
const collegeB = {
  id: "usr_college_b",
  role: "college_admin",
  collegeAdminOf: ["college-b"],
  preferences: { collegeId: "college-b", departmentId: "dept-b1" },
};
const userA = {
  id: "usr_a",
  role: "user",
  collegeAdminOf: [],
  preferences: { collegeId: "college-a", departmentId: "dept-a1" },
};
const userB = {
  id: "usr_b",
  role: "user",
  collegeAdminOf: [],
  preferences: { collegeId: "college-b", departmentId: "dept-b1" },
};

const platformPublished = { id: "tpl_platform", scope: "platform", status: "active" };
const platformDraft = { id: "tpl_platform_draft", scope: "platform", status: "draft" };
const collegeA1 = {
  id: "tpl_a1",
  scope: "college",
  status: "active",
  tenantId: "college-a",
  departmentId: "dept-a1",
};
const collegeA2 = {
  id: "tpl_a2",
  scope: "college",
  status: "active",
  tenantId: "college-a",
  departmentId: "dept-a2",
};
const collegeB1 = {
  id: "tpl_b1",
  scope: "college",
  status: "active",
  tenantId: "college-b",
  departmentId: "dept-b1",
};
const privateA = { id: "tpl_private_a", scope: "private", status: "draft", ownerUserId: "usr_a" };
const privateB = { id: "tpl_private_b", scope: "private", status: "draft", ownerUserId: "usr_b" };
const legacy = { id: "tpl_legacy", scope: "legacy", status: "active", tenantId: "college-a" };
const unknown = { id: "tpl_unknown", status: "active", tenantId: "college-a" };

describe("STAGE 1 template ownership and visibility", () => {
  it("classifies unknown ownership as legacy and treats active/published as published", () => {
    assert.equal(templateScope(unknown), "legacy");
    assert.equal(isLegacyTemplate(unknown), true);
    assert.equal(isPublishedTemplate(platformPublished), true);
    assert.equal(isPublishedTemplate({ status: "published" }), true);
    assert.equal(isPublishedTemplate(platformDraft), false);
  });

  it("platform admins see shared and legacy templates but never another user's private template", () => {
    assert.equal(canViewTemplate(platform, platformPublished), true);
    assert.equal(canViewTemplate(platform, platformDraft), true);
    assert.equal(canViewTemplate(platform, collegeA1), true);
    assert.equal(canViewTemplate(platform, legacy), true);
    assert.equal(canViewTemplate(platform, privateA), false);
  });

  it("ordinary users see published platform templates and only their own college/branch", () => {
    assert.equal(canViewTemplate(userA, platformPublished), true);
    assert.equal(canViewTemplate(userA, platformDraft), false);
    assert.equal(canViewTemplate(userA, collegeA1), true);
    assert.equal(canViewTemplate(userA, collegeA2), false, "other branch must be hidden");
    assert.equal(canViewTemplate(userA, collegeB1), false, "cross-college must be denied");
    assert.equal(canViewTemplate(userB, collegeA1), false);
    assert.equal(canViewTemplate(userA, legacy), false, "legacy is platform-admin-only");
    assert.equal(canViewTemplate(userA, unknown), false);
  });

  it("private templates are visible/usable only by their owner", () => {
    assert.equal(canViewTemplate(userA, privateA), true);
    assert.equal(canViewTemplate(userB, privateA), false);
    assert.equal(canViewTemplate(collegeA, privateA), false);
    assert.equal(canUseTemplate(userA, privateA), true);
    assert.equal(canUseTemplate(userB, privateA), false);
  });

  it("archived templates are never selectable", () => {
    const archived = { ...collegeA1, status: "archived" };
    assert.equal(canViewTemplate(userA, archived), false, "ordinary users do not browse archived shared formats");
    assert.equal(canViewTemplate(collegeA, archived), true, "college managers may still read history");
    assert.equal(canUseTemplate(userA, archived), false);
    assert.equal(canUseTemplate(platform, archived), false);
  });

  it("management is scoped to platform admins, the owning college, or the private owner", () => {
    assert.equal(canManageTemplate(platform, platformPublished), true);
    assert.equal(canManageTemplate(platform, collegeA1), true);
    assert.equal(canManageTemplate(platform, legacy), true);
    assert.equal(canManageTemplate(platform, privateA), false);

    assert.equal(canManageTemplate(collegeA, collegeA1), true);
    assert.equal(canManageTemplate(collegeA, collegeA2), true);
    assert.equal(canManageTemplate(collegeA, collegeB1), false);
    assert.equal(canManageTemplate(collegeB, collegeA1), false);
    assert.equal(canManageTemplate(collegeA, platformPublished), false);
    assert.equal(canManageTemplate(collegeA, legacy), false);

    assert.equal(canManageTemplate(userA, privateA), true);
    assert.equal(canManageTemplate(userA, collegeA1), false);
    assert.equal(canManageTemplate(userA, privateB), false);
  });

  it("ordinary users can never publish a shared template", () => {
    assert.equal(canPublishTemplate(userA, platformPublished), false);
    assert.equal(canPublishTemplate(userA, collegeA1), false);
    assert.equal(canPublishTemplate(userA, privateA), false);
    assert.equal(canPublishTemplate(collegeA, collegeA1), true);
    assert.equal(canPublishTemplate(collegeA, collegeB1), false);
    assert.equal(canPublishTemplate(collegeA, platformPublished), false);
    assert.equal(canPublishTemplate(platform, collegeA1), true);
    assert.equal(canPublishTemplate(platform, legacy), false, "legacy must be claimed/scoped first");
  });

  it("status changes require the right role/scope, including unpublishing", () => {
    assert.equal(canSetTemplateStatus(collegeA, collegeA1, "active"), true);
    assert.equal(canSetTemplateStatus(collegeA, collegeA1, "published"), true);
    assert.equal(canSetTemplateStatus(collegeA, collegeB1, "active"), false);
    assert.equal(canSetTemplateStatus(collegeA, collegeA1, "archived"), true);
    assert.equal(canSetTemplateStatus(userA, collegeA1, "active"), false);
    assert.equal(canSetTemplateStatus(userA, privateA, "active"), true);
    assert.equal(canSetTemplateStatus(userB, privateA, "active"), false);
    assert.equal(canSetTemplateStatus(platform, legacy, "active"), false);
  });

  it("template creation follows the same scope rules", () => {
    assert.equal(canCreateTemplate(userA, "private"), true);
    assert.equal(canCreateTemplate(userA, "college", "college-a"), false);
    assert.equal(canCreateTemplate(userA, "platform"), false);
    assert.equal(canCreateTemplate(collegeA, "college", "college-a"), true);
    assert.equal(canCreateTemplate(collegeA, "college", "college-b"), false);
    assert.equal(canCreateTemplate(platform, "college", "college-b"), true);
    assert.equal(canCreateTemplate(platform, "platform"), true);
    assert.equal(canCreateTemplate(platform, "legacy"), false);
  });

  it("college/branch management and legacy claims are platform-only or scoped", () => {
    assert.equal(canManageCollege(platform), true);
    assert.equal(canManageCollege(collegeA), false);
    assert.equal(canManageBranch(platform, "college-a"), true);
    assert.equal(canManageBranch(collegeA, "college-a"), true);
    assert.equal(canManageBranch(collegeA, "college-b"), false);
    assert.equal(canClaimLegacyTemplate(platform), true);
    assert.equal(canClaimLegacyTemplate(collegeA), false);
  });

  it("branch defaults reject private/legacy/cross-college and unpublished templates", () => {
    const branchA1 = { id: "dept-a1", tenantId: "college-a" };
    assert.equal(canSetBranchDefault(collegeA, collegeA1, branchA1), true);
    assert.equal(canSetBranchDefault(collegeA, collegeA2, branchA1), false, "other branch");
    assert.equal(canSetBranchDefault(collegeA, collegeB1, branchA1), false, "cross-college");
    assert.equal(canSetBranchDefault(collegeA, privateA, branchA1), false);
    assert.equal(canSetBranchDefault(platform, legacy, branchA1), false);
    assert.equal(canSetBranchDefault(platform, platformPublished, branchA1), true);
    assert.equal(canSetBranchDefault(collegeA, { ...collegeA1, status: "draft" }, branchA1), false);
  });

  it("branch visibility mirrors the catalogue rules", () => {
    const branchA1 = { id: "dept-a1", tenantId: "college-a" };
    assert.equal(canViewBranchTemplate(userA, collegeA1, branchA1), true);
    assert.equal(canViewBranchTemplate(userB, collegeA1, branchA1), false);
    assert.equal(canViewBranchTemplate(collegeA, collegeA1, branchA1), true);
    assert.equal(canViewBranchTemplate(collegeA, privateA, branchA1), false);
    assert.equal(canViewBranchTemplate(platform, privateA, branchA1), false);
  });

  it("filters a mixed catalogue without leaking private or cross-college templates", () => {
    const visible = filterVisibleTemplates(userA, [
      platformPublished,
      platformDraft,
      collegeA1,
      collegeA2,
      collegeB1,
      privateA,
      privateB,
      legacy,
      unknown,
    ]);
    assert.deepEqual(visible.map((t) => t.id), ["tpl_platform", "tpl_a1", "tpl_private_a"]);
  });
});
