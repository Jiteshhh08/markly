import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// STAGE 1 test database helper. Fail-closed: the forced database name must
// contain both "stage1" and "test". Production data is never targeted.

export function stage1TestDbUri(name) {
  if (!String(name).includes("stage1") || !String(name).includes("test")) {
    throw new Error(`[stage1-tests] refusing non-stage1 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage1-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage1-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage1") || !actual.includes("test")) {
    throw new Error(`[stage1-tests] refusing non-stage1 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage1TestDb(name) {
  await mongoose.connect(stage1TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage1TestDb() {
  await mongoose.disconnect().catch(() => {});
}
