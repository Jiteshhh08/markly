# Markly — Utilities (every external thing this project uses)

> Runtimes, packages, infrastructure, and services. "Configured in" tells you
> where each one is referenced. See `Documentation.md` for how they fit together.
>
> **Stage 8 review (2026-10-26):** dependency and environment inventory checked.
> No deployment was performed. Production notes are historical until re-verified.

## 1. Languages & runtimes

| Thing | Version | Used for | Configured in |
|---|---|---|---|
| Node.js | 22+ | Express API, Vite frontend, tests | `apps/api/package.json`, root `package.json` |
| Python | 3.12+ (3.13 verified) | FastAPI AI service, tests | `services/ai-service/requirements.txt` |
| WSL 2 + Ubuntu 24.04 | — | Docker Engine host for local Mongo/texlive | Windows side (no repo config) |
| Docker Engine (native, no Desktop) | 29.8.x verified | Mongo container, isolated texlive PDF builds, optional code sandboxes | `docker run` commands (docs), `PDF_COMPILE_CMD`, `SANDBOX_DOCKER` |
| PowerShell 5.1 | Windows shell | Dev commands in this repo's docs | — |

## 2. API dependencies (`apps/api/package.json`)

| Package | Purpose |
|---|---|
| `express` | HTTP server + routing |
| `cors` | Cross-origin access with the `ALLOWED_ORIGINS` allowlist. Outside production an empty list reflects any origin; in production an empty list fails closed for browser origins. |
| `dotenv` | `.env` loading |
| `mongoose` | Authoritative Mongo persistence for users, assignments, templates, colleges/branches, and audit. Production mutations fail closed if it is unavailable; local development/tests may run in memory. |
| `zod` | Input + Assignment JSON + section/document validation |
| `docx` | DOCX renderer (headers, footers, floating watermark via Word washout) |
| `helmet` | Security headers (`crossOriginResourcePolicy: false` so the preview iframe embeds; CSP includes `script-src-attr 'none'`) |
| `jsonwebtoken` + `bcryptjs` | JWT auth (`sub`/`email` only), password hashing |
| `multer` | PDF upload handling (memory storage, 25 MB cap, type filter) |
| `bullmq` + `ioredis` | Optional background-job transport when `REDIS_URL` + `BULLMQ_ENABLED=1` (lazy import; in-process otherwise). Job status remains process-local. |

## 3. Frontend dependencies (root `package.json`)

| Package | Purpose |
|---|---|
| `react`, `react-dom` | UI |
| `tailwindcss`, `@tailwindcss/vite` | Styling (+ the Jira-style `@theme` in `src/index.css`) |
| `vite`, `@vitejs/plugin-react` | Dev server + build |
| `oxlint` | Lint (`npm run lint`) |

> Removed (STAGE 6, unused): `react-router-dom`, `@tanstack/react-query`, `@monaco-editor/react`, `react-hook-form` were imported only by the deleted unwired `src/pages/*`; `@types/react`, `@types/react-dom` had no TypeScript to describe. The board uses manual fetch + plain form state + a LaTeX textarea.

## 4. AI-service dependencies (`services/ai-service/requirements.txt`)

| Package | Purpose |
|---|---|
| `fastapi`, `uvicorn[standard]` | HTTP API + server |
| `pydantic` | Assignment/section/source schemas |
| `httpx` | Qwen gateway, Tavily/SearXNG, page fetch |
| `python-dotenv` | `.env` loading |
| `sqlglot` | SQL parse-checks (no execution) |
| `pypdf` | Sample-PDF text extraction |
| `reportlab` | Test-fixture PDF generation (tests only, in practice) |
| `python-multipart` | Multipart PDF uploads |

## 5. Infrastructure & services

| Thing | Purpose | Setup |
|---|---|---|
| MongoDB 7 (container `mongo`) or Atlas M0 | Authoritative persistence for users/assignments/templates/colleges/branches/audit. Production registration, profile updates, and assignment mutations fail closed when it is unavailable. Local: `wsl -- docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongodata:/data/db mongo:7`, then `MONGODB_URI=mongodb://127.0.0.1:27017/Markly`. Prod: Atlas `mongodb+srv://…` (URL-encode the password; `@` → `%40`) | `MONGODB_URI` in `apps/api/.env` (gitignored) |
| texlive image (`texlive/texlive:latest`, ~9 GB) | Isolated LaTeX→PDF compiler; two pdflatex passes | Pre-pull on the host (`sudo docker pull texlive/texlive:latest`); `PDF_COMPILE_CMD`, `PDF_DOCKER`, `PDF_IMAGE`. The default command and any custom command must include `-no-shell-escape`. |
| Redis (optional; absent by default) | BullMQ job transport. Redis-backed rate limiting is **not** implemented; rate-limit windows are process-local. | Set `REDIS_URL` + `BULLMQ_ENABLED=1` when available |
| Qwen via OpenAI-compatible gateway (college-hosted) | LLM content generation | `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`; without all three the service runs a marked stub |
| Tavily **or** SearXNG (both absent) | Web research | `TAVILY_API_KEY` or `SEARXNG_URL`; without either, research is skipped |
| GitHub (`Jiteshhh08/markly`) | Source of truth; default branch `main` | The Stage 8 work lives on `feat/multicollege-template-admin-document-studio` and was not merged during review |
| AWS EC2 `t3.micro` (Ubuntu 24.04, ap-south-1) + Elastic IP | Historical production host for API + AI containers | `/opt/markly` checkout, `docker-compose.prod.yml`, SSH via `Markly.pem` |
| Vercel | Historical production frontend hosting (`marklyai.vercel.app`) | `VITE_API_URL` env var (baked at build; redeploy cache-off after changes) |
| Caddy 2.6.2 + Let's Encrypt + nip.io | Historical production HTTPS (`13-234-227-216.nip.io` → `127.0.0.1:4000`); cert auto-renews | `/etc/caddy/Caddyfile` on the EC2 host. The API defaults to `TRUST_PROXY=loopback` for this topology so rate limiting uses the real client IP. |
| Qdrant (absent, future) | Vector retrieval when the corpus outgrows keyword search | Would plug into `retrieve_examples()` |

## 6. Security-relevant runtime behavior

- **Trusted proxy:** `TRUST_PROXY` defaults to `loopback`, correct for host Caddy
  → `127.0.0.1:4000`. Set a hop count or subnet if the proxy reaches the API from
  a Docker bridge or another host. Do not trust arbitrary forwarded headers.
- **Private generated PDFs:** files under `apps/api/assets/generated/` are not
  served by the public `/assets` static mount; they stream only through the
  authenticated assignment PDF route. Do not re-expose that directory via a CDN
  or static server.
- **CSRF:** production cookie-authenticated mutations on assignments, examples,
  jobs, preferences, templates, and admin routes require an allowlisted or
  same-origin `Origin`/`Referer`. Bearer requests bypass the ambient-cookie check.
- **Durable document saves:** `PUT /assignments/:id/document` always requires a
  Mongo-acknowledged write and returns `503` without changing the saved document
  when Mongo is unavailable. Other assignment mutations fail closed only in
  production; local development keeps the memory fallback.
- **Production write opt-in:** seed and migration CLIs are dry-run by default;
  with `NODE_ENV=production` writes additionally require
  `ALLOW_PRODUCTION_DB_WRITE=1` for that command.
- **Secrets:** only `.env.example` files are tracked. Real `.env` files, keys,
  generated assets, build output, and database files are gitignored. The
  documented placeholder `JWT_SECRET` is rejected when `AUTH_REQUIRED=1`.

## 7. What is deliberately NOT used

No vector DB (corpus too small), no fine-tuning (gateway-only by design),
no Docker Desktop (WSL Engine for local dev, native Engine on EC2),
no cloud storage (local `assets/` + `corpus/`, both gitignored),
no self-hosted Mongo in prod (Atlas M0 instead), no full shadcn/Radix set,
no Redis-backed rate limiter or shared job-status store.
