import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Hermetic Stage 8 production guards. No MongoDB connection is opened:
// mongoose stays disconnected, so the production fail-closed branches run
// without touching real data. Each test file runs in its own process, so
// setting NODE_ENV here cannot affect the other suites.
process.env.NODE_ENV = "production";
process.env.AUTH_REQUIRED = "1";
process.env.JWT_SECRET = "stage8-production-guards-0123456789abcdef";
process.env.ALLOWED_ORIGINS = "https://app.example";

const {
  assertAuthConfiguration,
  loginUser,
  registerUser,
  updateProfileForUser,
} = await import("../src/lib/auth.js");
const { deleteRecord, durabilityRequired } = await import("../src/lib/assignmentStore.js");
const mongoose = (await import("mongoose")).default;

const EMAIL = `stage8-guard-${Date.now()}@example.com`;
const PASSWORD = "correct horse battery staple";

describe("STAGE 8 production fail-closed guards", () => {
  it("requires durability only in production", () => {
    assert.equal(durabilityRequired({ NODE_ENV: "production" }), true);
    assert.equal(durabilityRequired({ NODE_ENV: "test" }), false);
    assert.equal(durabilityRequired({ NODE_ENV: "development" }), false);
  });

  it("refuses to start with a placeholder JWT secret when auth is enforced", () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "change-me-in-production";
    try {
      assert.throws(() => assertAuthConfiguration(), /placeholder JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = previous;
    }
  });

  it("refuses registration without Mongo and leaves no memory-only account", async () => {
    assert.equal(mongoose.connection.readyState, 0, "test must not open a Mongo connection");

    await assert.rejects(
      () => registerUser({ email: EMAIL, password: PASSWORD }),
      (err) => err?.status === 503,
    );

    // A failed durable registration must not leave an in-memory account that
    // would later block a retry or disappear on restart.
    await assert.rejects(
      () => loginUser({ email: EMAIL, password: PASSWORD }),
      /Invalid email or password/,
    );
  });

  it("refuses profile updates without Mongo", async () => {
    await assert.rejects(
      () => updateProfileForUser("usr_stage8_missing", { name: "New name" }),
      (err) => err?.status === 503,
    );
  });

  it("reports a non-durable delete instead of pretending success", async () => {
    assert.equal(await deleteRecord(`asg_stage8_missing_${Date.now()}`), false);
  });
});
