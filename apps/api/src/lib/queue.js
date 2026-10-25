import { assignmentContentSchema, generateInputSchema } from "../schemas.js";
import { getRecord, nextAssignmentId, persistWithWarning, saveRecord } from "./assignmentStore.js";
import { generateViaAiService } from "./aiClient.js";
import { getSubjectProfile } from "./subjects.js";
import {
  resolvePinnedTemplate,
  resolveTemplateForGeneration,
} from "./templateResolution.js";

// Background generation jobs (Phase 9).
// Transport: BullMQ + Redis when REDIS_URL and BULLMQ_ENABLED=1 are set,
// otherwise an in-process queue. The jobs map below is the status source of truth either way
// (multi-process BullMQ deployments should move status into Redis/Mongo).

// Single BullMQ queue name shared by producer and worker. A previous
// producer/worker mismatch silently wedged every BullMQ job as pending
// forever — pinned by tests/queue-names.test.js.
export const GENERATION_QUEUE = "Markly-generation";

const jobs = new Map();
let counter = 0;
let bullmqQueue = null;
let bullmqWorker = null;
let bullmqWarned = false;

// BullMQ enqueue must never hang the request: a configured-but-dead Redis
// would otherwise retry forever and the job would sit in limbo.
const ENQUEUE_TIMEOUT_MS = Number(process.env.BULLMQ_ENQUEUE_TIMEOUT_MS ?? 10000);

// In-process runner: the throw below is for the BullMQ worker path only.
// Here the failure is already recorded on the job, so swallow the rejection
// (an unhandled rejection would crash the process / fail the test run).
function runInProcess(input, jobId, userId, template) {
  runGenerationJob(input, jobId, userId, template).catch(() => {});
}

export async function closeQueue() {
  const q = bullmqQueue;
  const w = bullmqWorker;
  bullmqQueue = null;
  bullmqWorker = null;
  await Promise.allSettled([q?.close(), w?.close()]);
}

export function queueBackend() {
  // BullMQ is explicit opt-in: a configured-but-dead Redis must never wedge
  // enqueue calls or spam reconnect errors (ioredis retries in a tight loop
  // on instant-refused connections). Default is the in-process queue.
  return process.env.REDIS_URL && process.env.BULLMQ_ENABLED === "1" ? "bullmq" : "memory";
}

function setStatus(job, status, patch = {}) {
  Object.assign(job, { status, updatedAt: new Date().toISOString() }, patch);
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

// Jobs visible to this requester (mirrors the GET /:id ownership rule:
// anonymous jobs are shared, owned jobs are private). Lets a fresh page
// resume polling generations that are still running after a refresh.
export function listJobsFor(requesterId) {
  const out = [];
  for (const job of jobs.values()) {
    if (job.userId && job.userId !== "anonymous" && job.userId !== (requesterId ?? "anonymous")) continue;
    out.push(job);
  }
  out.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return out;
}

async function ensureBullmq() {
  if (bullmqQueue || queueBackend() !== "bullmq") return bullmqQueue;
  try {
    const { Queue, Worker } = await import("bullmq");
    // Fail fast: never buffer commands while disconnected (that is what
    // hung enqueue calls), and cap reconnect backoff so a dead Redis
    // degrades to log noise instead of a log flood.
    const connection = {
      url: process.env.REDIS_URL,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    };
    bullmqQueue = new Queue(GENERATION_QUEUE, { connection });
    // STAGE 6: the worker MUST listen on the same queue the producer enqueues
    // to (see GENERATION_QUEUE above). Dormant in the default memory mode.
    bullmqWorker = new Worker(
      GENERATION_QUEUE,
      async (bjob) =>
        runGenerationJob(
          bjob.data.input,
          bjob.data.jobId,
          bjob.data.userId,
          bjob.data.template ?? null,
        ),
      { connection },
    );
    const worker = bullmqWorker;
    worker.on("failed", (bjob, err) => {
      const job = bjob?.data?.jobId ? jobs.get(bjob.data.jobId) : null;
      if (job && job.status !== "completed") setStatus(job, "failed", { error: String(err?.message ?? err) });
    });
    return bullmqQueue;
  } catch (err) {
    if (!bullmqWarned) {
      console.warn("[queue] BullMQ/Redis unavailable, falling back to in-process queue:", String(err).slice(0, 200));
      bullmqWarned = true;
    }
    return null;
  }
}

export async function createJob(type, input, userId = "anonymous", options = {}) {
  if (type !== "generate") throw new Error('Unsupported job type (only "generate")');
  const parsed = generateInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw new Error("Invalid input for generation job");
  if (parsed.data.templateVersion != null && !parsed.data.templateId) {
    throw new Error("templateVersion requires templateId");
  }

  // Resolve and pin the exact version at enqueue time. The immutable version
  // is stored on the job so an edit while the job is queued cannot change its
  // output. An explicit id never falls back to a default. Resolution errors
  // keep their status/code so the HTTP route can return a precise, safe error.
  const resolved = await resolveTemplateForGeneration({
    templateId: parsed.data.templateId,
    templateVersion: parsed.data.templateVersion,
    actor: options.actor ?? null,
  });

  counter += 1;
  const job = {
    id: `job_${Date.now()}_${counter}`,
    type,
    status: "pending",
    progress: 0,
    backend: queueBackend(),
    userId,
    input: parsed.data,
    template: resolved.snapshot,
    assignmentId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  const q = await ensureBullmq();
  if (q) {
    const add = q.add("generate", {
      jobId: job.id,
      input: job.input,
      userId: job.userId,
      template: job.template,
    });
    // Swallow the loser's late rejection (the race below already moved on).
    add.catch(() => {});
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("BullMQ enqueue timed out")), ENQUEUE_TIMEOUT_MS),
    );
    try {
      await Promise.race([add, timeout]);
    } catch (err) {
      console.warn("[queue] BullMQ enqueue failed, running in-process:", String(err).slice(0, 200));
      setImmediate(() => runInProcess(job.input, job.id, job.userId, job.template));
    }
  } else {
    setImmediate(() => runInProcess(job.input, job.id, job.userId, job.template));
  }
  return job;
}

export async function runGenerationJob(input, jobId, userId = "anonymous", pinnedTemplate = null) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job not found");
  const aiBase = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8001";
  try {
    const resolved = pinnedTemplate
      ? await resolvePinnedTemplate(pinnedTemplate)
      : await resolveTemplateForGeneration({
          templateId: input.templateId,
          templateVersion: input.templateVersion,
          actor: null,
        });

    setStatus(job, "researching", { progress: 10 });
    const profile = getSubjectProfile(input.subject);
    setStatus(job, "generating", { progress: 40 });
    const { includeVivaTitle, typedConclusion, ...aiInput } = input;
    const result = await generateViaAiService(aiInput, aiBase);
    setStatus(job, "validating", { progress: 75 });
    const content = assignmentContentSchema.safeParse(result.content);
    if (!content.success) throw new Error("AI service returned invalid Assignment JSON");
    const record = {
      id: nextAssignmentId(),
      status: "completed",
      userId,
      input,
      subjectProfile: profile,
      template: resolved.snapshot,
      content: content.data,
      options: {
        includeVivaTitle: input.includeVivaTitle ?? false,
        typedConclusion: input.typedConclusion ?? true,
      },
      sources: result.sources ?? [],
      provenance: {
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        validation: result.validation,
        researchProvider: result.researchProvider ?? "none",
      },
      createdAt: new Date().toISOString(),
    };
    saveRecord(record);
    await persistWithWarning(record, "job assignment");
    setStatus(job, "completed", { progress: 100, assignmentId: record.id });
    return record;
  } catch (err) {
    setStatus(job, "failed", { error: String(err?.message ?? err).slice(0, 500) });
    throw err;
  }
}

export function getAssignmentForJob(job) {
  return job.assignmentId ? getRecord(job.assignmentId) : null;
}

