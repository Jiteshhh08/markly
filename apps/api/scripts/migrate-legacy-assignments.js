// One-off migration: legacy assignment docs (pre-recordId schema, Oct 2026)
// into the current durable record shape ({ recordId, userId, data }).
//
// SAFETY (brief SECTION 30):
// - Default mode is --dry-run (read-only plan, NO writes).
// - --apply requires BOTH --email (owner attribution, resolved to a user
//   sub first) AND --confirm-db <exact-db-name> (fail-closed prod guard).
// - Idempotent: only docs WITHOUT recordId are touched; re-runs skip.
// - Reversible: same-_id $set only (old input/generatedContent fields are
//   kept); --rollback --run <id> unsets the added fields and restores
//   userId "anonymous".
// - Content is validated with the live Zod schema; invalid docs are SKIPPED
//   with reasons (never fabricated).
// - Run from apps/api so dotenv loads apps/api/.env:
//     node scripts/migrate-legacy-assignments.js --dry-run
//     node scripts/migrate-legacy-assignments.js --apply --email you@college.edu --confirm-db markly
//     node scripts/migrate-legacy-assignments.js --rollback --run <runId> --confirm-db markly

import dotenv from "dotenv";
import mongoose from "mongoose";
import { assignmentContentSchema } from "../src/schemas.js";

dotenv.config();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ROLLBACK_RUN = arg("--rollback");
const EMAIL = arg("--email");
const CONFIRM_DB = arg("--confirm-db");

function buildRecord(doc, ownerSub, runId) {
  const input = {
    aim: doc.input?.aim ?? doc.generatedContent?.aim ?? "Migrated assignment",
    description: null,
    subject: doc.input?.subject ?? doc.generatedContent?.metadata?.subject ?? "DBMS",
    experimentNumber: doc.generatedContent?.experimentNumber ?? null,
    technology: null,
    templateId: null,
    difficulty: null,
    additionalInstructions: null,
    includeVivaTitle: doc.input?.includeVivaTitle ?? false,
    typedConclusion: doc.input?.typedConclusion ?? true,
  };
  return {
    id: `asg_legacy_${String(doc._id)}`,
    status: doc.status ?? "completed",
    userId: ownerSub,
    input,
    subjectProfile: doc.generatedContent?.metadata?.subjectProfile ?? null,
    template: { id: "default-v1", version: 1, name: "Default (legacy import: original template unknown)" },
    options: {
      includeVivaTitle: input.includeVivaTitle,
      typedConclusion: input.typedConclusion,
    },
    content: doc.generatedContent,
    sources: doc.sources ?? [],
    provenance: {
      provider: "legacy-import",
      model: "n/a",
      promptVersion: "n/a",
      validation: { ok: true, migrated: true },
      researchProvider: "none",
      migrationRun: runId,
      migratedFrom: String(doc._id),
    },
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
  };
}

async function main() {
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("MONGODB_URI is required (run from apps/api).");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  try {
    if (ROLLBACK_RUN) {
      if (!CONFIRM_DB || CONFIRM_DB !== db.databaseName) {
        throw new Error(`--rollback requires --confirm-db ${db.databaseName}`);
      }
      const r = await db.collection("assignments").updateMany(
        { "data.provenance.migrationRun": ROLLBACK_RUN },
        { $set: { userId: "anonymous" }, $unset: { recordId: "", data: "" } },
      );
      console.log(JSON.stringify({ rollback: ROLLBACK_RUN, matched: r.matchedCount, modified: r.modifiedCount }));
      return;
    }

    if (APPLY && (!EMAIL || !CONFIRM_DB)) {
      throw new Error("--apply requires --email <owner> and --confirm-db <exact-db-name>");
    }
    if (APPLY && CONFIRM_DB !== db.databaseName) {
      throw new Error(`--confirm-db ${CONFIRM_DB} does not match connected db ${db.databaseName}; refusing`);
    }

    let ownerSub = null;
    if (EMAIL) {
      const key = String(EMAIL).toLowerCase().trim();
      const user = await db.collection("users").findOne({ email: key });
      if (!user) throw new Error(`no user with email ${key} (migrate nothing; refusing to orphan records)`);
      ownerSub = user.id ?? String(user._id);
    }

    const runId = `mig_${Date.now()}`;
    const legacy = await db.collection("assignments").find({ recordId: { $exists: false } }).toArray();
    const plan = [];
    for (const doc of legacy) {
      const record = buildRecord(doc, ownerSub ?? "UNRESOLVED-OWNER", runId);
      const parsed = assignmentContentSchema.safeParse(record.content);
      if (!parsed.success) {
        plan.push({
          _id: String(doc._id),
          title: doc.generatedContent?.title ?? null,
          verdict: "SKIP",
          reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        continue;
      }
      record.content = parsed.data;
      plan.push({
        _id: String(doc._id),
        recordId: record.id,
        title: record.content.title,
        owner: ownerSub ?? "UNRESOLVED-OWNER (pass --email to resolve)",
        verdict: APPLY ? "MIGRATED" : "WOULD-MIGRATE",
      });
      if (APPLY) {
        await db.collection("assignments").updateOne(
          { _id: doc._id, recordId: { $exists: false } },
          { $set: { recordId: record.id, userId: ownerSub, data: record } },
        );
      }
    }
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", runId: APPLY ? runId : null, db: db.databaseName, plan }, null, 1));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("migration failed:", String(err && err.message ? err.message : err).slice(0, 500));
  process.exitCode = 1;
});
