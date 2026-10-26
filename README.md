# Markly — multi-college assignment compiler (Phases 0–9)

Assignment compiler: **React → Express → FastAPI → Qwen → validated Assignment JSON → HTML / DOCX / LaTeX / PDF.**

> **Stage 8 review status (2026-10-26):** reviewed on
> `feat/multicollege-template-admin-document-studio`. Verification in this review
> was local only. No deployment, merge into `main`, or pull request was performed.
>
> **Last recorded production deployment (historical): 2026-10-02.** Frontend on
> Vercel, API + AI service on AWS EC2 behind Caddy, MongoDB Atlas. That deployment
> was not re-verified during the Stage 8 review; see `deployment-notes.md` for the
> historical topology and the current production prerequisites.

## Layout

| Path | What |
|---|---|
| `src/` (root Vite app) | Web frontend: workspace board, detail drawer/document studio, templates, preferences, admin screens, auth |
| `apps/api/` | Node/Express primary backend, plain JavaScript: validation, orchestration, auth, multi-college authorization, versioned templates, document blocks, renderers, jobs, persistence |
| `services/ai-service/` | Python/FastAPI AI service (prompt → LLM → validate; deterministic stub when the gateway is unconfigured) |
| `packages/shared/` | Shared data files: `assignment.schema.json` (contract mirror), `subject-profiles.json` (loaded by filesystem path, not a JS package) |
| `docker-compose.yml` | `web` + `api` + `ai-service` development stack (needs Docker) |

> Stack note: the backend is plain JavaScript (no TypeScript toolchain) by project
> decision — `node src/index.js`, zero build step.

The LLM generates **content only**. Layout is owned by templates and renderers.

## Prerequisites

- Node 22+, Python 3.12+
- MongoDB for production. Local development can run in memory when
  `MONGODB_URI` is unset, but production registration, profile updates, and
  assignment mutations fail closed without durable storage. The Stage 1–7
  integration suites require a reachable test MongoDB and fail closed rather than
  fake a pass.
- Docker with the `texlive/texlive:latest` image for real PDF compilation.
  Without it, PDF export returns an explicit compiler-unavailable error.
- Redis is optional; BullMQ activates only when `REDIS_URL` and
  `BULLMQ_ENABLED=1` are both set.
- LLM gateway env (college-hosted OpenAI-compatible Qwen). Without it the AI
  service uses a clearly marked deterministic stub so the pipeline still runs.

## Configure

```bash
cp .env.example .env                                   # VITE_API_URL
cp apps/api/.env.example apps/api/.env                 # API + Mongo + auth + PDF
cp services/ai-service/.env.example services/ai-service/.env
```

Important API variables:

- `MONGODB_URI` — durable users/assignments/templates/audit. Required in production.
- `JWT_SECRET` — strong random value; the documented placeholder is rejected when
  `AUTH_REQUIRED=1`.
- `AUTH_REQUIRED=1`, `COOKIE_SECURE=1`, `NODE_ENV=production` — production auth
  and cookie contract.
- `ALLOWED_ORIGINS` — comma-separated frontend origins. Empty fails closed for
  browser origins in production.
- `TRUST_PROXY` — Express trust-proxy setting. Defaults to `loopback`, correct
  when the API sees Caddy as a loopback peer. In a container, Docker NAT may
  present the bridge gateway instead; set a hop count or the bridge subnet
  (for example `172.17.0.0/16`) after verifying the source address. Never set
  it to `true` on a directly exposed API.
- `RATE_LIMIT_PER_MIN` — per-client in-memory limit (default 60).
- `PDF_COMPILE_CMD` — shell template using `{dir}`/`{wslDir}`. Custom commands
  must include `-no-shell-escape`; the default does.

## Run locally (3 terminals)

```bash
# 1. AI service
cd services/ai-service && python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# 2. API
cd apps/api && npm install && npm start   # :4000; memory mode unless MONGODB_URI is set

# 3. Web
npm install && npm run dev                # :5173
```

Open `:5173`. The board boots from server history; there is no browser storage.
A valid `markly_token` cookie restores the session on refresh. Without Mongo, the
board and users live only in process memory.

## Product surface

- **Workspace board** — To Do / In Progress / Done, server-backed history,
  resume-after-refresh for running generation jobs, per-assignment drawer.
- **Document studio** — edit the saved `document.blocks` body (text, headings,
  lists, code, page breaks, order, alignment, font size), with optimistic
  revision checks; save/reload is durable and fails closed on write errors.
- **Exports** — printable HTML, DOCX, LaTeX source, and container-compiled PDF.
  Every export uses the assignment's pinned template version.
- **Templates** — immutable versioning, scoped catalogues, private templates,
  admin publishing, branch defaults pinned to exact versions.
- **Multi-college admin** — platform admins manage colleges and branches; college
  admins manage their own college's branches, templates, defaults, and audit trail.
- **Preferences** — per-user college/branch and optional preferred template.
  Preferences are private to the authenticated user.

## Multi-college model

- `Tenant` = college; `Department` = branch.
- Roles: `user`, `college_admin`, `platform_admin`. Authorization always reads the
  current persisted user; JWT role claims are never trusted.
- Template scopes:
  - `platform` — global catalogue, published by platform admins.
  - `college` — shared within one college/branch, published by that college's
    admins (and platform admins).
  - `private` — owner only; never visible to other users or admins.
  - `legacy` — ownership unknown; platform-admin review only, never silently shared.
- Publishing a template creates a new immutable version. Existing assignments keep
  the exact `{ id, version }` they were generated with, even after a newer version
  or a new branch default is published.
- A branch default stores `{ defaultTemplateId, defaultTemplateVersion }`; it is a
  pinned pointer, not a floating "latest" reference.

## Persistence and durability

- MongoDB is authoritative for users, assignments, templates, colleges, branches,
  and audit records. Process memory is a hot cache.
- In production, assignment mutations (generate, options, section regeneration,
  content save, LaTeX save/clear, delete) return `503` rather than acknowledging
  a memory-only write. Registration and profile updates also fail closed when
  durable storage is unavailable.
- The document save (`PUT /assignments/:id/document`) requires a durable write in
  every environment: it returns `503` and leaves the previous document intact
  when Mongo is unavailable. This is stricter than the other mutations because
  losing a long studio edit is unacceptable.
- Local development and tests retain the memory-only fallback for the other
  mutations when Mongo is absent.
- Generated PDF copies live under `apps/api/assets/generated/` but are **not**
  exposed by the public `/assets` mount; they are streamed only through the
  authenticated assignment PDF route.
- Job status is in process memory even when BullMQ is enabled; multi-instance
  deployments need a shared status store.

## Rendering

- `render/renderModel.js` resolves the saved block body, validated styles, and
  template geometry once. HTML, DOCX, and LaTeX all consume that same node list.
- Watermark opacity is always 50% in HTML and LaTeX. DOCX uses Word's
  `ImageWatermark` washout (OOXML has no per-image opacity flag), the verified
  equivalent.
- Page frame, header/logo/watermark/footer, typography, and the faculty table come
  from template data, never from the LLM.
- PDF compilation runs two pdflatex passes in an isolated container; the default
  command disables TeX shell-escape.

## Security

- **Auth** — bcrypt + JWT carrying only `sub`/`email`; the httpOnly session cookie
  and in-memory Bearer token are both supported.
- **CSRF** — production cookie-authenticated mutations on assignments, examples,
  jobs, preferences, templates, and admin routes require an allowlisted or
  same-origin `Origin`/`Referer`. Bearer requests are not ambient credentials.
- **CORS** — `ALLOWED_ORIGINS` allowlist; production fails closed for browser
  origins when it is empty.
- **Rate limiting** — per-client in-memory windows keyed by the proxy-aware
  `req.ip`. Set `TRUST_PROXY` correctly behind a reverse proxy.
- **Uploads** — byte-signature validation, extension allowlists, 25 MB PDF and
  5 MB image caps, generated filenames.
- **LaTeX** — saved overrides are treated as untrusted input; the default compiler
  command includes `-no-shell-escape`.
- **Errors** — clients receive short generic messages; stacks, driver text, and
  compiler logs stay in server logs.

## Tests

```bash
cd services/ai-service && python -m pytest tests -q
cd apps/api && node --test tests/*.test.js
npm run build
npm run lint
git diff --check
```

The API suite uses real Express/Mongo/HTTP flows and isolated databases whose names
are fail-closed to contain the stage and `test` (for example
`markly_stage7_workflow_test`). Production data is never targeted. Atlas
connectivity can make a run flaky; rerun the affected file individually and record
the result honestly.

Latest Stage 8 local results are recorded in the final review report. They do not
constitute a deployment verification.

## Known limitations and residual risks

- **Preferences are self-asserted.** Any authenticated user may select any active
  college/branch. College-shared templates are therefore not confidential from a
  user who selects that college; they are not a substitute for membership checks.
- **Legacy ownerless assignments** remain visible to authenticated users for
  migration compatibility. This is a documented cross-user exposure for old data.
- **`User.email` is indexed but not unique.** Concurrent registrations are guarded
  by an existence check and an upsert, but a unique partial index should be added
  after existing duplicate data is cleaned up.
- **Jobs status is process-local.** BullMQ transport is implemented, but job status
  and progress are not shared across API instances.
- **Rate limiting is process-local.** Redis-backed limiting is not implemented.
- **No Stage 8 deployment/PDF verification.** Real texlive compilation, visual
  DOCX/PDF comparison, and browser admin-v2 publishing were not re-exercised in
  this review.

## Historical production note

The last recorded production deployment (2026-10-02) used Vercel + EC2 + Caddy +
Atlas. Its evidence, topology, and setup steps are preserved in
`deployment-notes.md`. Treat those results as historical until re-verified; the
Stage 8 review did not deploy or touch production data.
