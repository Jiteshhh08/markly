import mongoose from "mongoose";
import { Department, Tenant } from "../models/index.js";
import { isPublishedTemplate } from "./templateAccess.js";
import { getTemplateVersionAuthoritative } from "./templateStore.js";

// Temporary onboarding default.
//
// Until a user chooses a college and branch, the Templates view and generation
// fall back to the first seeded college's Computer Engineering template. This
// is deliberately ONE explicit template, not a general cross-college fallback:
// it is only used when the TCET college/branch exists and the actor has no
// saved college or membership. Once preferences exist, normal college/branch
// isolation applies.
export const BOOTSTRAP_COLLEGE_ID = "tcet";
export const BOOTSTRAP_BRANCH_ID = "tcet-computer-engineering";
export const BOOTSTRAP_TEMPLATE_ID = "tcet-computer-engineering";
export const BOOTSTRAP_TEMPLATE_VERSION = 1;

const MEMORY_COLLEGE = Object.freeze({
  id: BOOTSTRAP_COLLEGE_ID,
  name: "TCET",
  slug: "tcet",
});
const MEMORY_BRANCH = Object.freeze({
  id: BOOTSTRAP_BRANCH_ID,
  tenantId: BOOTSTRAP_COLLEGE_ID,
  name: "Computer Engineering",
  slug: BOOTSTRAP_BRANCH_ID,
});

export function isBootstrapDefaultTemplate(template) {
  return (
    String(template?.id ?? "") === BOOTSTRAP_TEMPLATE_ID &&
    Number(template?.version) === BOOTSTRAP_TEMPLATE_VERSION
  );
}

export function isUnconfiguredActor(actor) {
  const collegeId = actor?.preferences?.collegeId;
  const memberships = Array.isArray(actor?.tenantIds) ? actor.tenantIds : [];
  return !collegeId && memberships.length === 0;
}

// Administrators already see the whole catalogue; the onboarding fallback is
// for ordinary users (and anonymous local-dev callers) only.
export function isBootstrapEligibleActor(actor) {
  if (actor?.role && actor.role !== "user") return false;
  return isUnconfiguredActor(actor);
}

/**
 * Resolve the bootstrap template only when the first college/branch has really
 * been seeded (or when running without MongoDB, where the JSON seed is the
 * source of truth). In a Mongo-backed deployment a missing TCET seed must not
 * silently expose the built-in JSON template to every unconfigured user.
 *
 * Returns `{ template, college, branch }` so catalogue callers can show the
 * real college/branch names, or null when the fallback is unavailable.
 */
export async function loadBootstrapDefault() {
  if (mongoose.connection.readyState !== 1) {
    const template = await getTemplateVersionAuthoritative(
      BOOTSTRAP_TEMPLATE_ID,
      BOOTSTRAP_TEMPLATE_VERSION,
    );
    if (!template || !isPublishedTemplate(template)) return null;
    return { template, college: MEMORY_COLLEGE, branch: MEMORY_BRANCH };
  }

  const [college, branch] = await Promise.all([
    Tenant.findOne({
      id: BOOTSTRAP_COLLEGE_ID,
      status: { $ne: "inactive" },
    }).lean(),
    Department.findOne({
      id: BOOTSTRAP_BRANCH_ID,
      tenantId: BOOTSTRAP_COLLEGE_ID,
      status: { $ne: "inactive" },
    }).lean(),
  ]);
  if (!college || !branch) return null;

  const template = await getTemplateVersionAuthoritative(
    BOOTSTRAP_TEMPLATE_ID,
    BOOTSTRAP_TEMPLATE_VERSION,
  );
  if (!template || !isPublishedTemplate(template)) return null;
  return { template, college, branch };
}

export async function loadBootstrapDefaultTemplate() {
  const found = await loadBootstrapDefault();
  return found?.template ?? null;
}
