// STAGE 1 idempotent TCET seed CLI.
//
// Default: dry-run. Writes require BOTH --apply and --confirm-db <exact-db>.
// With NODE_ENV=production, writes additionally require the one-command opt-in
// ALLOW_PRODUCTION_DB_WRITE=1 after reviewing the dry-run.
// Uses $setOnInsert only: re-running never overwrites edits or duplicates data.
// Nothing here runs at API startup.

import dotenv from "dotenv";
import mongoose from "mongoose";
import { runSeed } from "../src/lib/multicollegeSeed.js";

dotenv.config();

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const CONFIRM_DB = arg("--confirm-db");

async function main() {
  if (
    APPLY &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_DB_WRITE !== "1"
  ) {
    throw new Error(
      "Refusing to write with NODE_ENV=production. Review the dry-run, then set ALLOW_PRODUCTION_DB_WRITE=1 for this command.",
    );
  }
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("MONGODB_URI is required (run from apps/api).");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  try {
    const result = await runSeed({ db, apply: APPLY, confirmDb: CONFIRM_DB });
    console.log(JSON.stringify(result, null, 1));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("multicollege seed failed:", String(err?.message ?? err).slice(0, 500));
  process.exitCode = 1;
});
