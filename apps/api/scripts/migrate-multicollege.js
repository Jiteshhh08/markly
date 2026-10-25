// STAGE 1 multi-college migration CLI.
//
// Default: dry-run (read-only plan). Writes require BOTH --apply and
// --confirm-db <exact-connected-db>. Rollback is also dry-run by default:
//   node scripts/migrate-multicollege.js --rollback <runId> --confirm-db <db> --apply
//
// Never run this against production as part of STAGE 1. Assignments are not
// rewritten; unknown template ownership is flagged as legacy, never invented.
// See docs/stage1-multicollege.md for rollback limitations.

import dotenv from "dotenv";
import mongoose from "mongoose";
import { runMigration, runRollback } from "../src/lib/multicollegeMigration.js";

dotenv.config();

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const ROLLBACK_RUN = arg("--rollback");
const CONFIRM_DB = arg("--confirm-db");

async function main() {
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("MONGODB_URI is required (run from apps/api).");
  if (process.argv.includes("--rollback") && !ROLLBACK_RUN) {
    throw new Error("--rollback requires a run id");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  try {
    const result = ROLLBACK_RUN
      ? await runRollback({ db, runId: ROLLBACK_RUN, apply: APPLY, confirmDb: CONFIRM_DB })
      : await runMigration({ db, apply: APPLY, confirmDb: CONFIRM_DB });
    console.log(JSON.stringify(result, null, 1));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("multicollege migration failed:", String(err?.message ?? err).slice(0, 500));
  process.exitCode = 1;
});
