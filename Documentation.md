# Markly — Documentation

> Last audited: 2026-10-02. Covers all of Phases 0–9 as built.
> Companion files: `Utilities.md` (every external dependency/service),
> `system-overview.md` (guided tour: click journeys, state map, cheat sheet),
> `deployment-notes.md` (production topology, setup, verification).

## 1. What this is

Markly is an **assignment compiler** for engineering practicals. A student enters
an **aim** (plus optional description/subject/experiment number/technology) and gets a
structured academic document out — previewable in the browser and exportable as
**DOCX, LaTeX, and PDF**.

Core rule: the **LLM generates content only** (JSON). **Templates control presentation.**
Formatting is deterministic and lives in renderers, never in prompts.

```
React (:5173)
  → Express API (:4000) — validation, orchestration, templates, rendering, jobs, auth
    → FastAPI AI service (:8001) — prompt → Qwen (or stub) → validate
      → Assignment JSON → HTML / DOCX / LaTeX → (container) → PDF
```

## 2. Repository map

| Path | Purpose |
|---|---|
| `src/` | Frontend: `App.jsx` shell (state + composition) + `views/` (4 screens) + `features/assignments/` (data, row/card UI, drawer, create modal) + `features/auth/` + `contexts/` (AuthContext) + `services/api.js` (canonical client) + `components/` |
| `apps/api/src/index.js` | Express entry: helmet, CORS, logging, auth attach, static `/assets`, rate limit, route mounts, optional Mongo |
| `apps/api/src/routes/` | `assignments.js` (generate/get/list/html/regen/PUT/docx/latex/pdf), `templates.js` (CRUD + from-pdf), `examples.js` (ingest proxy), `jobs.js`, `auth.js`, `health.js` |
| `apps/api/src/lib/` | `aiClient.js` (AI calls), `subjects.js` (profiles), `templates.js` (seed loader), `templateStore.js` (versioning), `assignmentStore.js` (records), `queue.js` (jobs), `auth.js` (JWT), `storage.js` (files), `compile.js` (PDF) |
| `apps/api/src/render/` | `html.js` (50% rule lives here), `docx.js`, `latex.js` |
| `apps/api/src/models/` | Mongoose scaffolds: User, Tenant, Department, Subject, Template, Assignment, Generation, Document, Source, PromptVersion |
| `apps/api/src/templates/` | Tenant template seeds (TCET Computer Engineering v1) |
| `apps/api/assets/` | Tenant artwork (`tcet-header.png`, `tcet-watermark.png`); runtime `generated/`, `uploads/` (gitignored) |
| `services/ai-service/app/` | `main.py` (7 endpoints), `pipeline.py`, `schemas.py`, `prompts.py`, `subjects.py`, `validators.py`, `sections.py`, `search/`, `corpus.py`, `codecheck.py`, `sandbox.py`, `llm/` |
| `services/ai-service/corpus/` | Ingested examples (runtime data, gitignored) |
| `services/ai-service/tests/` | `test_phase{1,3,5,6,7,8}.py` (run directly with python) |
| `packages/shared/` | `assignment.schema.json` (contract mirror), `subject-profiles.json` (loaded by path; no JS package wiring) |
| `docker-compose.yml`, `Dockerfile`, `apps/api/Dockerfile`, `services/ai-service/Dockerfile` | Container setup (untested — no Docker on Windows host; use WSL Docker) |

## 3. Setup

Prerequisites: Node 22+, Python 3.12+, WSL2 with Docker Engine (for MongoDB now;
texlive/Redis later). No Docker Desktop needed.

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp services/ai-service/.env.example services/ai-service/.env
# MongoDB (once per Windows reboot):
wsl -- sudo service docker start
wsl -- docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongodata:/data/db mongo:7
# After reboot: wsl -- sudo service docker start; wsl -- docker start mongo
```

Run (3 terminals, keep all open):

| # | Command | Port |
|---|---|---|
| 1 | `cd services/ai-service && python -m pip install -r requirements.txt && python -m uvicorn app.main:app --host 127.0.0.1 --port 8001` | 8001 |
| 2 | `cd apps/api && npm install && node src/index.js` | 4000 |
| 3 | `npm install && npm run dev` (repo root) | 5173 |

Open `:5173`. Health checks: `:8001/health`, `:4000/api/v1/health`
(`mongo: "configured"` means Mongo is connected; otherwise in-memory mode).

## 4. Environment variables

API (`apps/api/.env`): `PORT` (4000), `AI_SERVICE_URL` (http://127.0.0.1:8001),
`MONGODB_URI` (unset = in-memory), `RATE_LIMIT_PER_MIN` (60),
`JWT_SECRET` (set in production), `AUTH_REQUIRED` (`1` enforces tokens, default open),
`COOKIE_SECURE` (`1` in HTTPS cross-site production for the session cookie),
`NODE_ENV=production` (prod compose; silences Express debug pages),
`REDIS_URL` + `BULLMQ_ENABLED=1` (unset = in-process jobs), `PDF_COMPILE_CMD` (empty/unset =
native-docker default since the `||`-fallback fix; on Windows-with-WSL-Docker use
`wsl docker run --rm -v "{wslDir}:/work" -w /work texlive/texlive:latest …`).

AI (`services/ai-service/.env`): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
(all three or stub mode), `PORT` (8001), `TAVILY_API_KEY` / `SEARXNG_URL`
(either activates research), `SANDBOX_DOCKER` (`docker`; bogus value = graceful skip).

Frontend (`.env`): `VITE_API_URL` (http://127.0.0.1:4000; baked at `vite build` time).
No browser storage anywhere: the login token lives in memory (reload logs out).

## 5. Generation pipeline (where each step lives)

1. Input validation — `apps/api/src/schemas.js` (`generateInputSchema`; aim mandatory)
2. Subject profile lookup — `lib/subjects.js` ← `packages/shared/subject-profiles.json`
3. Template lookup — `lib/templateStore.js` (requested id or active default)
4. Example retrieval — AI `corpus.retrieve_examples()` (style guidance only)
5. Research planning + web search + extraction — AI `search/research.py` (skipped unless the subject needs it AND a provider is configured; failures never break generation)
6. Context assembly — `pipeline.py` (research context + example shape appended, marked UNTRUSTED)
7. LLM generation — `llm/qwen.py` (OpenAI-compatible gateway) or `llm/stub.py` (clearly marked placeholder when unconfigured)
8. JSON extraction + Pydantic validation — `pipeline._extract_json`, `schemas.AssignmentContent`
9. Semantic validation — `validators.py` (no viva, sequential steps) + `codecheck.py` (sqlglot parse; failures raise → one retry)
10. API-side re-validation (zod) → record saved (memory always; Mongo best-effort) → response with `provenance` + `sources`

## 6. API reference (`/api/v1`)

- `GET /health` — service status, mongo state, AI URL
- `POST /auth/register|login` → `{token}`; `GET /auth/me` (Bearer)
- `POST /assignments/generate` → full record (sync)
- `GET /assignments` → history summaries; `GET /assignments/:id` → full record
- `POST /assignments/:id/regenerate-section` `{section, additionalInstructions?}` → updated record
- `PUT /assignments/:id` `{content}` → validated save (marks `editedByUser`)
- `PATCH /assignments/:id/options` `{includeVivaTitle?, typedConclusion?}` → presentation flags
- `GET /assignments/:id/html` → printable document (header + 50% watermark every page)
- `GET /assignments/:id/docx` → .docx download; `GET /:id/latex` → `{latex, edited}`; `PUT /:id/latex` → save override; `POST /:id/pdf` → compiled PDF or explicit 502
- `GET /templates`, `GET /templates/:id[?version=N]`, `POST /templates`, `PUT /templates/:id` (forks new version), `POST /templates/from-pdf`
- `POST /examples/ingest` (multipart PDF), `GET /examples?subject=&q=&k=`
- `POST /jobs` `{type:"generate", input}` → 202 `{job}`; `GET /jobs/:id` → status + assignment when done
- `GET /assets/*` — tenant artwork + generated PDFs

AI service: `GET /health`, `POST /v1/generate`, `POST /v1/regenerate-section`,
`POST /v1/ingest`, `GET /v1/examples`, `POST /v1/analyze-template`.
`sandbox.run_in_sandbox()` is intentionally **not** exposed over HTTP.

## 7. Data & templates

- Assignment record: `id, status, userId, input, subjectProfile, template{id,version}, options, content, sources[], provenance{…}, createdAt/updatedAt, editedByUser?, latexOverride?` —   durable in Mongo (`Assignment.data` keyed by `recordId`) when connected, memory is only a hot cache. Reads are owner-scoped: legacy/`anonymous` records are shared, owned records visible to their owner only. Nothing persists in the browser — reload rebuilds the board from the server.
- Templates are tenant **data**, never code. Seeds (`src/templates/*.json`) load as v1;
  `updateTemplate()` always forks a new immutable version; old versions stay readable,
  so historical assignments never change. Mongo `Template` upserts are best-effort.
- Watermark 50% rule: enforced in HTML (`WATERMARK_OPACITY`) and LaTeX
  (tikz node at exact page center, `opacity=0.5`). DOCX has no opacity flag — the PNG
  itself must be saved at 50% transparency (both PNGs are committed in `assets/`).
- Page frame + faculty table: every renderer draws a border on all sides and prints
  the static `facultyTable` ("For Faculty Use" / "Marks Obtained") last, flushed to
  the bottom (`\vfill` in LaTeX). Table content is template data — edit the seed or
  `PUT /templates/:id` (new version), never the code. No viva section is generated
  (product rule), regardless of sample layouts.
- Presentation flags per assignment (`options`, changeable anytime via
  `PATCH /assignments/:id/options`): `includeVivaTitle` appends a "Viva Questions"
  HEADING ONLY for faculty handwriting (questions are never generated);
  `typedConclusion: false` renders the compulsory Conclusion heading with blank
  writing space instead of model text. Set at creation via checkboxes.
- Jobs: `pending → researching → generating → validating → completed/failed`
  (+ `rendering` reserved). In-process queue by default; BullMQ transport when
  `REDIS_URL` + `BULLMQ_ENABLED=1` is set (status map stays in-process — move to Redis/Mongo for multi-instance).
- Auth: bcrypt + JWT, open dev mode unless `AUTH_REQUIRED=1`. Login/register also set
  an httpOnly `markly_token` cookie (Bearer kept as fallback); the board restores the
  session on boot via `GET /auth/me`, so refresh keeps you logged in with zero browser
  storage. Logout clears both. CORS allows credentials with a reflected origin.

## 8. Frontend (Jira-style workspace board)

Single-page board in `src/App.jsx` (no router): To Do / In Progress / Done columns
with zero browser storage — the board boots from server history (`GET /assignments`,
Mongo-backed) and deletes go server-side (`DELETE /assignments/:id`, ownership-checked),
create modal (aim, subject, experiment, technology, difficulty, template dropdown
from `GET /templates`), detail drawer (metadata, sections, sources, preview iframe,
raw JSON), per-section editing + regeneration + save, LaTeX view/edit, DOCX/PDF/HTML
export with error surfacing, Templates manager (create + sample-PDF import),
server History (import records onto the board), Login (memory token + httpOnly
cookie; logged-out actions open the login modal instead of failing, and
templates reload right after login), toasts, retry/delete. Every server call carries a
180s `AbortSignal` timeout so stalls become errors, never infinite spinners.
The empty board shows a first-assignment hero with a "Go to dashboard" link back
to the columns.

## 9. Testing

```bash
cd services/ai-service && python tests/test_phase1.py  # also test_phase3/5/6/7/8.py
cd apps/api && npm test                                # 55 passing
```
Covered: schemas, viva rejection, regen, renderer, exports, SQL gate, sandbox/proven-fail paths,
templates/versioning, auth, queue. Live-verified (isolated ports): full generate→export chain,
jobs, ingest, template-from-PDF. Deliberately live-only (need runtimes): texlive compile success,
Redis/BullMQ transport, Mongo persistence, real search providers.

## 10. Security model

Never trusted: uploaded PDFs/templates, LLM text (HTML-escaped on render, LaTeX-escaped
on export), generated code (parsed, never executed on host; sandbox containers only,
network-isolated, capped), retrieved webpages (text-only, size-capped, scripts dropped,
marked UNTRUSTED in prompts). Enforced caps: 1MB JSON, 25MB uploads, 200KB LaTeX,
120s compile timeout. Helmet headers; CORS is open (`*`) for local dev — lock down in
production along with `JWT_SECRET`, `AUTH_REQUIRED=1`, and Redis rate limiting.
Error contract: clients only ever receive short generic `error` strings
(`sendError()` in `lib/errors.js`; a final middleware converts anything else,
including body-parser failures, to JSON). Technical details (stacks, driver text,
compiler logs, validation dumps) go to the server log only — never the response
body, the screen, or the browser console. The UI maps transport failures
(offline/timeout) to friendly copy in one place (`apiFetch` in `src/App.jsx`)
and never shows status codes.

## 11. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `502 Generation failed: fetch failed` | AI service not running → start terminal 1; check `:8001/health` |
| Same, but health loads | Proxy env hijacking localhost → unset `HTTP_PROXY/HTTPS_PROXY` in API terminal, set `NO_PROXY=127.0.0.1,localhost` |
| `EADDRINUSE :4000/:8001` | Orphan from a dead session → find PID via `Get-NetTCPConnection -LocalPort 4000,8001` and `Stop-Process` it |
| Empty `{}` → 400 | Expected: aim is mandatory |
| PDF export 502 | Read the message: missing image = pull texlive; otherwise the log tail names the cause |
| `opacity` looks wrong in Word | Expected: DOCX uses PNG-native transparency (see §7) |
| Board empty after reload but still logged in | Expected: board rebuilds from server history (no browser storage); login persists via cookie |
| Logged out on every refresh (prod) | Session cookie blocked cross-site → set `COOKIE_SECURE=1` on the server (SameSite=None; Secure), then log in once |
| Action fails with login modal popping up | Expected: that IS the logged-out/expired-token flow — log in (or re-log in) and retry |
| History empties on restart | Expected without Mongo (memory store); set `MONGODB_URI` |

## 12. Known gaps (audit 2026-10-02; owner in brackets)

- [done in prod] texlive pulled + end-to-end PDF compile verified on EC2 (178 KB, `%PDF-1.7`)
- [done in prod] real Qwen gateway live (`Qwen3.6-35B-A3B`); MongoDB Atlas connected (`[api] connected to MongoDB`); frontend on Vercel (`marklyai.vercel.app`) — see `deployment-notes.md`
- [you] Production hardening still open: lock CORS to the Vercel origin (currently reflects any origin), `JWT_SECRET` rotation schedule, Redis rate limiting
- [done] Template edits persist to Mongo on save; users rehydrate from Mongo on boot; route-level auth/persistence regression suites added (`apps/api/tests/`)
- [done] `packages/shared` dead JS wiring removed (data files kept, loaded by path)
- [done] BullMQ producer/worker queue names unified (`GENERATION_QUEUE`)
- [later] Qdrant embeddings behind `retrieve_examples()` (keyword retrieval is fine at current corpus size)
- [later] "Explain this assignment" tutoring UI (records already carry content + sources)
- [later] Full shadcn set (hand-rolled Button/Input today), 404 page, frontend error boundaries, list pagination, AI request logging
- [later] `docker-compose.yml` needs real `.env` files present (only `.example`s are committed) and has never been run (no Docker on Windows host)

