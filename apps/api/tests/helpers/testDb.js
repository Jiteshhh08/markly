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

// STAGE 2 test database helper. Same fail-closed rule: the forced database name
// must contain both "stage2" and "test". Production data is never targeted.
export function stage2TestDbUri(name) {
  if (!String(name).includes("stage2") || !String(name).includes("test")) {
    throw new Error(`[stage2-tests] refusing non-stage2 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage2-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage2-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage2") || !actual.includes("test")) {
    throw new Error(`[stage2-tests] refusing non-stage2 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage2TestDb(name) {
  await mongoose.connect(stage2TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage2TestDb() {
  await mongoose.disconnect().catch(() => {});
}

// STAGE 3 test database helper. Same fail-closed rule: the forced database name
// must contain both "stage3" and "test". Production data is never targeted.
export function stage3TestDbUri(name) {
  if (!String(name).includes("stage3") || !String(name).includes("test")) {
    throw new Error(`[stage3-tests] refusing non-stage3 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage3-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage3-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage3") || !actual.includes("test")) {
    throw new Error(`[stage3-tests] refusing non-stage3 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage3TestDb(name) {
  await mongoose.connect(stage3TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage3TestDb() {
  await mongoose.disconnect().catch(() => {});
}

// STAGE 4 test database helper. Same fail-closed rule: the forced database name
// must contain both "stage4" and "test". Production data is never targeted.
export function stage4TestDbUri(name) {
  if (!String(name).includes("stage4") || !String(name).includes("test")) {
    throw new Error(`[stage4-tests] refusing non-stage4 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage4-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage4-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage4") || !actual.includes("test")) {
    throw new Error(`[stage4-tests] refusing non-stage4 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage4TestDb(name) {
  await mongoose.connect(stage4TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage4TestDb() {
  await mongoose.disconnect().catch(() => {});
}

// STAGE 5 test database helper. Same fail-closed rule: the forced database name
// must contain both "stage5" and "test". Production data is never targeted.
export function stage5TestDbUri(name) {
  if (!String(name).includes("stage5") || !String(name).includes("test")) {
    throw new Error(`[stage5-tests] refusing non-stage5 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage5-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage5-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage5") || !actual.includes("test")) {
    throw new Error(`[stage5-tests] refusing non-stage5 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage5TestDb(name) {
  await mongoose.connect(stage5TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage5TestDb() {
  await mongoose.disconnect().catch(() => {});
}

// STAGE 6 test database helper. Same fail-closed rule: the forced database name
// must contain both "stage6" and "test". Production data is never targeted.
export function stage6TestDbUri(name) {
  if (!String(name).includes("stage6") || !String(name).includes("test")) {
    throw new Error(`[stage6-tests] refusing non-stage6 test database '${name}'`);
  }
  const raw = String(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "").trim();
  if (!raw) {
    throw new Error(
      "[stage6-tests] no MongoDB URI: set MONGODB_TEST_URI (or MONGODB_URI). Refusing to fake-green.",
    );
  }
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error("[stage6-tests] unparseable MongoDB URI (refusing to guess)");

  const uri = `${match[1]}/${name}${match[3] ?? ""}`;
  const actual = uri.split("?")[0].split("/").pop();
  if (!actual.includes("stage6") || !actual.includes("test")) {
    throw new Error(`[stage6-tests] refusing non-stage6 test database '${actual}'`);
  }
  return uri;
}

export async function connectStage6TestDb(name) {
  await mongoose.connect(stage6TestDbUri(name), { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
}

export async function disconnectStage6TestDb() {
  await mongoose.disconnect().catch(() => {});
}
