// STAGE 6 regression: the BullMQ producer and worker must share one queue
// name. A previous producer/worker mismatch wedged every BullMQ job as
// pending forever (only reachable with REDIS_URL + BULLMQ_ENABLED=1,
// hence uncaught).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATION_QUEUE } from "../src/lib/queue.js";

describe("queue/worker name match", () => {
  it("exports a single shared queue name", () => {
    assert.equal(GENERATION_QUEUE, "Markly-generation");
  });

  it("constructs both Queue and Worker from that name (no stray literals)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "lib", "queue.js"), "utf8");
    assert.ok(/new Queue\(\s*GENERATION_QUEUE/.test(src), "producer must use the shared name");
    assert.ok(/new Worker\(\s*GENERATION_QUEUE/.test(src), "worker must use the shared name");
    assert.ok(!src.includes("assignmentai-generation"), "old mismatched name must stay gone");
  });
});
