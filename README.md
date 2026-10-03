# Markly — all phases built (0–9)

Assignment compiler: **React → Express → FastAPI → Qwen → validated Assignment JSON → HTML / DOCX / LaTeX / PDF.**

> Phases 0–9 are implemented: generation POC, HTML renderer, section editor,
> DOCX + LaTeX + containerized PDF, research layer, PDF corpus, SQL checks,
> template versioning, jobs + auth + hardening, and the full multi-page frontend.
>
> **Live in production (2026-10-02):** frontend on Vercel
> (`https://marklyai.vercel.app`), API + AI service on AWS EC2 behind Caddy
> HTTPS, MongoDB Atlas. Full topology, setup steps and verification evidence:
> **`deployment-notes.md`**. Newcomer tour: **`system-overview.md**`.

## Layout

| Path | What |
|---|---|
| `src/` (root Vite app) | Web frontend — Phase 1 aim form + structured result view |
| `apps/api/` | Node/Express primary backend, plain JavaScript (validation, orchestration, Mongoose scaffolds) |
| `services/ai-service/` | Python/FastAPI AI service (prompt → LLM → validate) |
| `packages/shared/` | Shared data files: `assignment.schema.json` (contract mirror), `subject-profiles.json` (loaded by filesystem path, not a JS package) |
| `docker-compose.yml` | `web` + `api` + `ai-service` (needs Docker; not installed on this machine) |

> Stack note: the backend is plain JavaScript (no TypeScript toolchain) by project decision — `node src/index.js`, zero build step.

The LLM generates **content only**. Layout is owned by templates/renderers (Phases 2–4).

## Prerequisites

- Node 22+, Python 3.12+, MongoDB optional in Phase 1 (API runs in-memory without it)
- LLM gateway env (college-hosted OpenAI-compatible Qwen). **Without it the AI service uses a clearly-marked deterministic stub** so the pipeline still runs end to end.

## Configure

```bash
cp .env.example .env                                   # VITE_API_URL
cp apps/api/.env.example apps/api/.env                 # PORT, AI_SERVICE_URL, MONGODB_URI (optional), JWT_SECRET, AUTH_REQUIRED, REDIS_URL, PDF_COMPILE_CMD
cp services/ai-service/.env.example services/ai-service/.env   # LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, TAVILY_API_KEY / SEARXNG_URL
```

## Run (local, 3 terminals)

```bash
# 1. AI service
cd services/ai-service && python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# 2. API
cd apps/api && npm install && npm start   # :4000, in-memory mode unless MONGODB_URI set

# 3. Web
npm install && npm run dev                # :5173
```

Open `:5173`: a workspace board (To Do / In Progress / Done) that boots from
server history — no browser storage; reload rebuilds from MongoDB and logs you out.
Create cards with aim + subject + template dropdown; the detail drawer shows
sections, sources, document preview, per-section editing + regeneration, LaTeX
editing, and DOCX/PDF/HTML export. Creation asks about viva heading (heading only,
handwritten) and typed vs handwritten conclusion; both changeable later per card.
Header has Templates manager, server History import, and Login.

## Templates, header & watermark

- Tenant templates are **data** (`apps/api/src/templates/*.json` seeds + `lib/templateStore.js`
  runtime CRUD), never hardcoded logic. Seeded: `tcet-computer-engineering` v1.
  Updates fork new immutable versions; `GET /api/v1/templates/:id?version=N` reads history.
- Artwork lives in `apps/api/assets/` (served at `/assets/*`):
  drop in `tcet-header.png` (department banner) and `tcet-watermark.png` (shield logo).
  Missing files render as labeled placeholders so layout is reviewable without artwork.
- **Watermark opacity is ALWAYS 50%** — enforced by `WATERMARK_OPACITY` in
  `apps/api/src/render/html.js` (HTML) and `render/latex.js` (tikz node at page center).
  DOCX uses the PNG as-is (OOXML has no opacity flag), so save that file at 50% transparency.
- `POST /api/v1/templates/from-pdf` drafts a template from a sample PDF (AI `/v1/analyze-template`).

## Research, corpus, validation

- Search: `SearchProvider` abstraction (Tavily via `TAVILY_API_KEY`, SearXNG via
  `SEARXNG_URL`); skipped gracefully when unconfigured. Sources are stored per
  assignment and shown in the UI. Extracted pages are treated as untrusted input.
- Corpus: `POST /api/v1/examples/ingest` (PDF → normalized example);
  top examples shape generation as style guidance. No vector DB (keyword retrieval;
  Qdrant plugs into `retrieve_examples()` later).
- Code checks: SQL blocks are parsed with sqlglot (failures trigger regeneration);
  `app/sandbox.py` runs untrusted code only in network-isolated containers (no HTTP exposure).

## Jobs, auth, hardening

- `POST /api/v1/jobs` (type `generate`) → `202` + pollable
  `pending → researching → generating → validating → completed/failed`.
  BullMQ + Redis transport activates with `REDIS_URL` + `BULLMQ_ENABLED=1`; otherwise in-process.
- Auth: `POST /api/v1/auth/register|login` (bcrypt + JWT), `GET /api/v1/auth/me`.
- Helmet headers, request logging, in-memory rate limiting, 25MB upload caps with
  PDF/PNG type checks, LaTeX length caps, unhandled-rejection logging.

## Tests

```bash
cd services/ai-service && python tests/test_phase1.py   # + test_phase3/5/6/7/8.py per subsystem
cd apps/api && npm test                                 # 43 passing: schemas, templates, renderer, exports, auth, queue
```

## Verified on 2026-10-02 (production + local)

- AI-service tests pass; API tests **55/55 pass**; `vite build` succeeds
- Live E2E on the EC2 server: register → JWT → `POST /api/v1/assignments/generate`
  `{aim, subject: DBMS}` → `status=completed` (real Qwen gateway, not stub);
  `POST /:id/pdf` → 200 `application/pdf`, 178,105 bytes, `%PDF-1.7`
  (two pdflatex passes in the texlive container); public HTTPS serves 401
  correctly at `https://13-234-227-216.nip.io` (see `deployment-notes.md` §5)

## What remains (later phases)

- Phase 2: ✅ HTML renderer + tenant templates + header/watermark (done)
- Phases 3–9: ✅ all implemented (see sections above)
- Deliberately deferred: Redis-backed BullMQ, Qdrant embeddings,
  full shadcn component set, "Explain this assignment" tutoring feature
  (texlive end-to-end compile, real-gateway generation and Atlas connection
  are all live in production — see `deployment-notes.md` §5)

