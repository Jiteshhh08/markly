// STAGE 7 restart helper.
//
// Starts the REAL Express app in a fresh OS process against the isolated Stage 7
// test database. This is deliberately not a cache-busted module import: a real
// process restart proves the durable Mongo copies (users, preferences, template
// versions, assignments) are sufficient to serve requests again, including the
// startup hydration the production entrypoint performs.
//
// The parent test passes MONGODB_URI, JWT_SECRET, AUTH_REQUIRED, PORT and the
// AI/PDF stub settings. No production database can be reached because the
// parent builds the URI with the fail-closed Stage 7 helper.

process.env.NODE_ENV = "test";

import mongoose from "mongoose";

const { default: app } = await import("../../src/index.js");
const { hydrateUsersFromMongo } = await import("../../src/lib/auth.js");
const { hydrateTemplatesFromMongo } = await import("../../src/lib/templateStore.js");

const uri = String(process.env.MONGODB_URI ?? "").trim();
if (!uri) {
  console.error("STAGE7_SERVER_ERROR missing MONGODB_URI");
  process.exit(2);
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  await hydrateUsersFromMongo();
  await hydrateTemplatesFromMongo();
} catch (err) {
  console.error(`STAGE7_SERVER_ERROR ${String(err?.stack ?? err)}`);
  process.exit(3);
}

const server = app.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  console.log(`STAGE7_READY ${address.port}`);
});

async function shutdown() {
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch {
    /* already closed */
  }
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
