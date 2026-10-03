// Regression: board cards/hydration must survive the list-summary shape.
// POST-/generate returns FULL records, but GET /assignments returns SUMMARIES
// (no content/input). recordToIssue must render correct cards from summaries,
// and the drawer lazy-loads the full record on open. Before the fix, every
// card from a fresh load rendered "Imported assignment" with no content.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { materializeJobCard, mergeServerIssues, recordToIssue } from "../../../src/features/assignments/data.js";

function summary(overrides = {}) {
  return {
    id: "asg_e2e_1",
    status: "completed",
    title: "Explore subqueries in SQL",
    aim: "Explore subqueries in SQL",
    subject: "DSA",
    technology: "Java",
    experimentNumber: 4,
    template: { id: "tcet-computer-engineering", version: 1 },
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("recordToIssue honours list summaries", () => {
  it("keeps real aim/subject/tech/exp from a summary (no content yet)", () => {
    const issue = recordToIssue(summary());
    assert.equal(issue.key, "asg_e2e_1");
    assert.equal(issue.aim, "Explore subqueries in SQL");
    assert.equal(issue.subject, "DSA");
    assert.equal(issue.technology, "Java");
    assert.equal(issue.experimentNumber, "4");
    assert.equal(issue.templateId, "tcet-computer-engineering");
    assert.equal(issue.status, "done");
    assert.equal(issue.stale, false);
  });

  it("prefers full-record content/input over summary top-level fields", () => {
    const issue = recordToIssue({
      ...summary({ aim: "Stale summary aim", subject: "UHV" }),
      content: { aim: "Real content aim", experimentNumber: 9 },
      input: { subject: "DBMS", technology: "SQL" },
      options: { includeVivaTitle: true, typedConclusion: false },
    });
    assert.equal(issue.aim, "Real content aim");
    assert.equal(issue.subject, "DBMS");
    assert.equal(issue.technology, "SQL");
    assert.equal(issue.experimentNumber, "9");
    assert.equal(issue.includeVivaTitle, true);
    assert.equal(issue.typedConclusion, false);
  });

  it("falls back safely on a bare id-only summary", () => {
    const issue = recordToIssue({ id: "asg_x" });
    assert.equal(issue.key, "asg_x");
    assert.equal(issue.aim, "Imported assignment");
    assert.equal(issue.subject, "DBMS");
    assert.equal(issue.technology, "");
    assert.equal(issue.experimentNumber, "");
    assert.equal(issue.templateId, "");
  });

  it("treats null experimentNumber as empty (never 'null')", () => {
    const issue = recordToIssue(summary({ experimentNumber: null }));
    assert.equal(issue.experimentNumber, "");
  });
});

describe("board merge keeps in-flight generations (refresh race)", () => {
  const jobCard = (overrides = {}) => ({
    key: "job_job1",
    jobId: "job1",
    aim: "Explore subqueries in SQL",
    subject: "DBMS",
    status: "inprogress",
    error: "",
    stale: false,
    record: null,
    ...overrides,
  });

  it("preserves in-flight job cards when the server list resolves after them", () => {
    const server = [{ id: "asg_old", status: "completed", content: { aim: "Old", title: "Old" } }];
    const merged = mergeServerIssues([jobCard()], server);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].key, "job_job1", "pending work stays first");
    assert.equal(merged[1].key, "asg_old");
  });

  it("drops terminal job cards on list merge (failed/completed resolve via poll)", () => {
    const server = [{ id: "asg_old", status: "completed", content: { aim: "Old", title: "Old" } }];
    const merged = mergeServerIssues([jobCard({ status: "failed", error: "x" })], server);
    assert.deepEqual(
      merged.map((i) => i.key),
      ["asg_old"],
    );
  });

  it("materializing swaps the job card for the record with no duplicates", () => {
    const record = {
      id: "asg_new",
      status: "completed",
      content: { aim: "Explore subqueries in SQL", title: "Explore subqueries in SQL" },
      input: { subject: "DBMS" },
    };
    // Record already arrived via list while the job was still polling.
    const prev = [jobCard(), { key: "asg_new", aim: "stale" }];
    const next = materializeJobCard(prev, "job_job1", record);
    assert.deepEqual(next.map((i) => i.key), ["asg_new"]);
    assert.equal(next[0].aim, "Explore subqueries in SQL");
    assert.equal(next[0].status, "done");
  });
});
