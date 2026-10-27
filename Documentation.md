# Markly — Documentation

> Last reviewed: 2026-10-26 (Stage 8). Covers Phases 0–9 as implemented on
> `feat/multicollege-template-admin-document-studio`. Companion files:
> `Utilities.md` (external dependencies), `system-overview.md` (guided tour),
> `deployment-notes.md` (historical production topology and prerequisites).
>
> The Stage 8 review was local only. No deployment, merge, or PR was performed.

## 1. What this is

Markly is an **assignment compiler** for engineering practicals. A student enters
an **aim** (plus optional description/subject/experiment number/technology) and
gets a structured academic document — previewable in the browser and exportable as
**HTML, DOCX, LaTeX, and PDF**.

Core rule: the **LLM generates content only** (JSON). **Templates control
presentation.** Formatting is deterministic and lives in renderers, never prompts.

```
React (:5173)
  → Express API (:4000) — validation, orchestration, templates, document model,
                          rendering, jobs, auth, multi-college authorization
    → FastAPI AI service (:8001) — prompt → Qwen (or stub) → validate
      → Assignment JSON → HTML / DOCX / LaTeX → (container) → PDF
```

## 2. Repository map

| Path | Purpose |
|---|---|
| `src/` | Frontend: `App.jsx` shell, `views/` (dashboard/assignments/history/templates/admin), `features/assignments/` (board, drawer, document studio, create modal), `features/templates/`, `features/auth/`, `contexts/`, `services/api.js` |
| `apps/api/src/index.js` | Express entry: helmet, CORS, cache headers, logging, auth attach, private `/assets` guard, rate limit, route mounts, Mongo bootstrap |
| `apps/api/src/routes/` | `assignments.js`, `templates.js`, `admin.js`, `preferences.js`, `examples.js`, `jobs.js`, `auth.js`, `health.js` |
| `apps/api/src/lib/` | `aiClient.js`, `subjects.js`, `templateStore.js`, `templateAccess.js`, `templateCatalogue.js`, `templateResolution.js`, `assignmentStore.js`, `documentBlocks.js`, `documentModel.js`, `queue.js`, `auth.js`, `roles.js`, `csrf.js`, `cors.js`, `audit.js`, `compile.js`, `storage.js`, `uploadSafety.js`, migration/seed helpers |
| `apps/api/src/render/` | `renderModel.js` (shared resolved nodes), `html.js`, `docx.js`, `latex.js` |
| `apps/api/src/models/` | Mongoose models: User, Tenant (college), Department (branch), Subject, Template, Assignment, Generation, Document, Source, PromptVersion, AuditLog |
| `apps/api/src/templates/` | Tenant template seeds (TCET Computer Engineering v1) |
| `apps/api/assets/` | Tenant artwork; runtime `generated/`, `uploads/` (gitignored) |
| `apps/api/scripts/` | `seed-multicollege.js`, `migrate-multicollege.js` (dry-run by default; production writes require an explicit opt-in) |
| `services/ai-service/app/` | `main.py`, `pipeline.py`, `schemas.py`, `prompts.py`, `subjects.py`, `validators.py`, `sections.py`, `search/`, `corpus.py`, `codecheck.py`, `sandbox.py`, `llm/` |
| `services/ai-service/corpus/` | Ingested examples (runtime data, gitignored) |
| `services/ai-service/tests/` | `test_phase{1,3,5,6,7,8}.py` |
| `packages/shared/` | `assignment.schema.json`, `subject-profiles.json` (loaded by path) |

## 3. Setup

Prerequisites: Node 22+, Python 3.12+, MongoDB for durable/production use, and
Docker + texlive for real PDF compilation. Redis is optional.

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp services/ai-service/.env.example services/ai-service/.env
```

Local Mongo (optional; without it the API runs in memory):

```bash
wsl -- sudo service docker start
wsl -- docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongodata:/data/db mongo:7
```

Run (3 terminals):

| # | Command | Port |
|---|---|---|
| 1 | `cd services/ai-service && python -m pip install -r requirements.txt && python -m uvicorn app.main:app --host 127.0.0.1 --port 8001` | 8001 |
| 2 | `cd apps/api && npm install && npm start` | 4000 |
| 3 | `npm install && npm run dev` (repo root) | 5173 |

Health checks: `:8001/health`, `:4000/api/v1/health` (`mongo: "configured"` means
Mongo is connected).

## 4. Environment variables

API (`apps/api/.env`):

- `PORT` (4000), `AI_SERVICE_URL` (`http://127.0.0.1:8001`)
- `MONGODB_URI` — durable users/assignments/templates/audit. Production requires it;
  local dev and tests may run in memory.
- `JWT_SECRET` — strong random value. The documented placeholder is rejected when
  `AUTH_REQUIRED=1`.
- `AUTH_REQUIRED` (`1` enforces tokens), `COOKIE_SECURE` (`1` for HTTPS cross-site),
  `NODE_ENV=production`
- `ALLOWED_ORIGINS` — comma-separated frontend origins. Empty reflects any origin
  outside production; in production an empty list fails closed for browser origins.
- `TRUST_PROXY` — Express trust-proxy setting. Defaults to `loopback` when the
  API sees Caddy as a loopback peer. In a container, Docker NAT may present the
  bridge gateway; use a hop count/subnet after verifying the source address.
- `RATE_LIMIT_PER_MIN` (60)
- `REDIS_URL` + `BULLMQ_ENABLED=1` — optional BullMQ transport (status remains
  process-local)
- `PDF_COMPILE_CMD` — shell template using `{dir}`/`{wslDir}`. Empty/unset uses the
  native Docker default. Custom commands must include `-no-shell-escape`.
- `PDF_DOCKER`, `PDF_IMAGE` — preflight overrides.

AI (`services/ai-service/.env`): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (all
three or stub mode), `PORT` (8001), `TAVILY_API_KEY` / `SEARXNG_URL`,
`SANDBOX_DOCKER`.

Frontend (`.env`): `VITE_API_URL`, baked at build time. **Explicit empty =
same-origin** via the Vite `/api` + `/assets` proxies locally and host rewrites in
production. Set an absolute URL only for split hosting; then the cookie is
cross-site and needs `COOKIE_SECURE=1`. No browser storage: the session is an
httpOnly cookie plus an in-memory Bearer copy.

## 5. Generation pipeline

1. Input validation — `apps/api/src/schemas.js` (`generateInputSchema`; aim mandatory)
2. Subject profile — `lib/subjects.js` ← `packages/shared/subject-profiles.json`
3. Template resolution — `lib/templateResolution.js`; explicit `templateId` never
   falls back, omitted id resolves preferred → branch default → the TCET Computer
   Engineering onboarding default for an unconfigured ordinary user → explicit
   error. The resolved exact version is pinned on the assignment.
4. Example retrieval — AI `corpus.retrieve_examples()` (style guidance only)
5. Research planning/search/extraction — AI `search/research.py` (optional; failures
   never break generation)
6. Context assembly — `pipeline.py` (research + example shape marked UNTRUSTED)
7. LLM generation — `llm/qwen.py` or the marked `llm/stub.py`
8. JSON extraction + Pydantic validation — `pipeline._extract_json`, `schemas.py`
9. Semantic validation — `validators.py` + `codecheck.py` (sqlglot; one retry)
10. API re-validation (zod) → durable record → response with `provenance`/`sources`

## 6. API reference (`/api/v1`)

- `GET /health` — service status, Mongo state, AI URL
- `POST /auth/register|login` → `{token}`; `POST /auth/logout`;
  `GET /auth/me`; `PATCH /auth/profile` (name/avatar only)
- `POST /assignments/generate` → full record (sync)
- `GET /assignments` → history summaries; `GET /assignments/:id` → full record
- `GET/PUT /assignments/:id/document` → editable block body with revision checks
- `POST /assignments/:id/regenerate-section` `{section, additionalInstructions?}`
- `PUT /assignments/:id` `{content}` → validated academic-content save
- `PATCH /assignments/:id/options` `{includeVivaTitle?, typedConclusion?}`
- `GET /assignments/:id/html` → printable document
- `GET /assignments/:id/docx`; `GET /:id/latex`; `PUT /:id/latex`;
  `DELETE /:id/latex`; `POST /:id/pdf` → compiled PDF or explicit error
- `GET /templates`, `GET /templates/:id[?version=N]`, `POST /templates`,
  `PUT /templates/:id` (forks a version), `POST /templates/from-pdf`
- `POST /examples/ingest` (multipart PDF), `GET /examples?subject=&q=&k=`
- `POST /jobs` → 202 `{job}`; `GET /jobs/:id`; `GET /jobs`
- `GET/PUT /preferences`, `GET /preferences/options`
- Admin: colleges, branches, branch templates/defaults, users, audit
  (`/admin/...`, persisted-admin authorization only)
- `GET /assets/*` — tenant artwork and uploaded template images. Generated
  assignment PDFs are **not** served here.

AI service: `GET /health`, `POST /v1/generate`, `POST /v1/regenerate-section`,
`POST /v1/ingest`, `GET /v1/examples`, `POST /v1/analyze-template`.
`sandbox.run_in_sandbox()` is intentionally not exposed over HTTP.

## 7. Data, templates, and documents

- **Assignment record:** `id, status, userId, input, subjectProfile,
  template{id,version}, options, content, document{schemaVersion,revision,blocks},
  sources[], provenance{…}, createdAt/updatedAt, editedByUser?, latexOverride?`.
  MongoDB is authoritative; memory is a hot cache. Reads are owner-scoped. Legacy
  records with no owner are visible to authenticated users for migration
  compatibility (documented residual risk).
- **Templates:** tenant data, never code. Seeds load as v1; updates fork immutable
  versions; old versions remain readable. Scopes are `platform`, `college`,
  `private`, and `legacy`; authorization lives in `lib/templateAccess.js` and
  `lib/templateCatalogue.js`.
- **Branch defaults:** exact `{id, version}` pointers on `Department`. Publishing a
  newer version does not repoint them. The Stage 1 seed creates TCET with ten
  branches and pins Computer Engineering to `tcet-computer-engineering@1`.
  Re-running the seed backfills missing branches and a missing Computer
  Engineering default; it never overwrites an administrator-chosen default.
- **Onboarding default:** `lib/bootstrapDefault.js` resolves the seeded TCET
  Computer Engineering template only for an ordinary user with no saved college
  and no college membership. `GET /templates` adds it with
  `isBootstrapDefault: true` plus a top-level `bootstrapDefault` summary, and
  generation records source `bootstrap_default`. Explicit template ids remain
  strict: only the eligible unconfigured actor may pin this template, and an
  explicit request from another college still returns the safe not-found error.
- **Document blocks:** flat, validated block list in
  `lib/documentBlocks.js`; legacy content is projected on read. Document saves use
  optimistic revision checks and a per-assignment in-process lock.
- **Watermark 50% rule:** enforced in HTML and LaTeX. DOCX uses Word's
  `ImageWatermark` washout (OOXML has no per-image opacity flag), the verified
  equivalent.
- **Page frame + faculty table:** every renderer draws the border and prints the
  static faculty table last, from template data. No viva questions are generated.
- **Presentation flags:** `includeVivaTitle` appends a heading only;
  `typedConclusion: false` renders the heading with blank writing space.
- **Jobs:** `pending → researching → generating → validating → completed/failed`.
  In-process by default; BullMQ when configured. Status is process-local.
- **Auth:** bcrypt + JWT carrying only `sub`/`email`; roles/college scope are read
  from MongoDB on every authorization decision. Registration and profile updates
  fail closed in production if durable storage is unavailable.
- **Durability:** production assignment mutations (generate, options, regenerate,
  content, LaTeX, delete) return `503` instead of acknowledging a memory-only
  write; local/test mode keeps the memory fallback for those paths. The document
  save (`PUT /assignments/:id/document`) is stricter: it requires a durable write
  in every environment and returns `503` without changing the saved document when
  Mongo is unavailable.

## 8. Frontend

Single-page board (no router): `App.jsx` composes `views/` and
`features/assignments/`. To Do / In Progress / Done columns boot from server
history; no browser storage. The drawer includes section editing/regeneration,
the document studio, LaTeX view/edit, and HTML/DOCX/PDF exports. Templates and
admin screens cover versioned template management, scopes, branch defaults,
colleges/branches, users, and audit. Preferences save the user's college/branch
and optional pinned template. While no college/branch is selected, the Templates
view shows the TCET Computer Engineering default with a banner and a direct
"Choose college & branch" action; the create dialog preselects the same template.
Every server call carries a timeout so stalls become errors, never infinite
spinners. Running jobs are resumed on boot from `GET /jobs`.

## 9. Testing

```bash
cd services/ai-service && python -m pytest tests -q
cd apps/api && node --test tests/*.test.js
npm run build
npm run lint
```

The API suite uses real Express/Mongo/HTTP flows, a stub AI service, a fake PDF
compiler, and a real child-process API restart in Stage 7. Test databases are
isolated and fail-closed to names containing the stage and `test` (for example
`markly_stage7_workflow_test`). Production data is never targeted. Atlas
connectivity can cause flaky runs; rerun the affected file individually and record
the result honestly. `stage4-bootstrap-default.test.js` covers the TCET
onboarding default, including the unconfigured-user catalogue marker, generation
source, explicit-id eligibility, cross-college isolation, administrators, and an
inactive branch. Stage 7 PDF assertions are structural marker checks, not real
TeX compilation.

## 10. Security model

Never trusted: uploaded PDFs/templates, LLM text (escaped on render/export),
generated code (parsed, never executed on host; sandbox containers only),
retrieved webpages (text-only, size-capped, marked UNTRUSTED). Caps: 1 MB JSON,
25 MB PDFs, 5 MB images, 200 KB LaTeX, 120 s compile timeout. Helmet headers,
including CSP `script-src-attr 'none'`; preview HTML has no inline handlers.

- **Auth:** JWT `sub`/`email` only; persisted roles; placeholder `JWT_SECRET`
  rejected when auth is enforced.
- **CSRF:** production cookie-authenticated mutations on assignments, examples,
  jobs, preferences, templates, and admin routes require an allowlisted or
  same-origin Origin/Referer. Bearer requests bypass the ambient-cookie check.
- **CORS:** `ALLOWED_ORIGINS` allowlist; empty fails closed for browser origins in
  production.
- **Rate limiting:** per-client in-memory windows keyed by proxy-aware `req.ip`;
  configure `TRUST_PROXY` for the deployment topology.
- **Uploads:** byte-signature validation, extension allowlists, size caps,
  generated filenames.
- **PDF:** two pdflatex passes in an isolated container; default command disables
  TeX shell-escape. Custom `PDF_COMPILE_CMD` must also disable it.
- **Generated PDFs:** written under `assets/generated/` but blocked from the public
  static mount; only the authenticated assignment route streams them.
- **Errors:** clients receive short generic messages; technical detail stays in
  server logs.

## 11. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `502 Generation failed: fetch failed` | AI service not running → start terminal 1; check `:8001/health` |
| Same, but health loads | Proxy env hijacking localhost → unset `HTTP_PROXY/HTTPS_PROXY`, set `NO_PROXY=127.0.0.1,localhost` |
| `EADDRINUSE :4000/:8001` | Orphan process → find the PID and stop it |
| Empty `{}` → 400 | Expected: aim is mandatory |
| PDF export 502 | Read the message: missing image/compiler vs. LaTeX error; log tail names the cause |
| `opacity` looks wrong in Word | Expected: DOCX uses Word's washout watermark, not a PNG opacity flag |
| Board empty after reload but still logged in | Expected: board rebuilds from server history; session restores from cookie |
| Logged out on every refresh (prod) | Cookie blocked cross-site → set `COOKIE_SECURE=1`, then log in once |
| Action fails with login modal | Expected logged-out/expired-token flow — log in and retry |
| `/assets/tcet-header.png` 404 on Vercel | Host only proxies `/api/*` → add an `/assets/*` rewrite/proxy |
| CSP blocks inline event handler in preview | Preview HTML must stay handler-free; artwork fallbacks are server-side |
| History empties on restart | Expected without Mongo; set `MONGODB_URI` (production requires it) |
| Registration/profile returns 503 in production | Mongo unavailable; production auth is fail-closed |
| Assignment save/export returns 503 | Mongo unavailable; production assignment mutations are fail-closed |

## 12. Known gaps and residual risks

- Preferences are self-asserted: any authenticated user can select any active
  college/branch. College-shared templates are therefore not confidential from a
  user who selects that college.
- Legacy ownerless assignments remain visible to authenticated users for migration
  compatibility.
- `User.email` is indexed but not unique; concurrent registrations are guarded by
  an existence check and an upsert, but a unique partial index is still recommended
  after duplicate cleanup.
- Job status/progress and rate-limit windows are process-local. Multi-instance
  deployments need shared stores.
- Redis-backed rate limiting is not implemented.
- Stage 8 did not re-verify real texlive compilation, pixel-level DOCX/PDF
  comparison, deployment, or the browser admin-v2 publishing flow.
- Qdrant embeddings and the "Explain this assignment" tutoring UI remain future
  work.
