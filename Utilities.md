# Markly — Utilities (every external thing this project uses)

> Runtimes, packages, infrastructure, and services. "Configured in" tells you
> where each one is referenced. See `Documentation.md` for how they fit together.

## 1. Languages & runtimes

| Thing | Version | Used for | Configured in |
|---|---|---|---|
| Node.js | 22+ | Express API, Vite frontend, tests | `apps/api/package.json`, root `package.json` |
| Python | 3.12+ (3.13 verified) | FastAPI AI service, tests | `services/ai-service/requirements.txt` |
| WSL 2 + Ubuntu 24.04 | — | Docker Engine host, MongoDB, future texlive/Redis | Windows side (no repo config) |
| Docker Engine (native, no Desktop) | 29.8.x verified | Mongo container; texlive/Redis/sandboxes later | `docker run` commands (docs), `PDF_COMPILE_CMD`, `SANDBOX_DOCKER` |
| PowerShell 5.1 | Windows shell | Dev commands in this repo's docs | — |

## 2. API dependencies (`apps/api/package.json`)

| Package | Purpose |
|---|---|
| `express` | HTTP server + routing |
| `cors` | Cross-origin access (Vite `:5173` → API `:4000` locally; `marklyai.vercel.app` → API in prod — locked to the `ALLOWED_ORIGINS` allowlist; empty list = reflect any origin) |
| `dotenv` | `.env` loading |
| `mongoose` | Optional Mongo persistence (works without it) |
| `zod` | Input + Assignment JSON + section validation |
| `docx` | DOCX renderer (headers, footers, floating watermark) |
| `helmet` | Security headers (`crossOriginResourcePolicy: false` so the preview iframe embeds) |
| `jsonwebtoken` + `bcryptjs` | JWT auth, password hashing |
| `multer` | PDF upload handling (memory storage, 25MB cap, type filter) |
| `bullmq` | Background-job transport when `REDIS_URL` + `BULLMQ_ENABLED=1` (lazy import; in-process otherwise) |

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
| MongoDB 7 (container `mongo`) or Atlas M0 | Persistence; auto-creates DB/collections on first write — nothing to provision. Local: `wsl -- docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongodata:/data/db mongo:7`, then `MONGODB_URI=mongodb://127.0.0.1:27017/Markly`. Prod: Atlas `mongodb+srv://…` (URL-encode the password; `@` → `%40`) | `MONGODB_URI` in `apps/api/.env` (gitignored) |
| texlive image (`texlive/texlive:latest`, ~9 GB) | Isolated LaTeX→PDF compiler | Pre-pulled on the EC2 host (`sudo docker pull texlive/texlive:latest`); `PDF_COMPILE_CMD`, `PDF_DOCKER`, `PDF_IMAGE` |
| Redis (absent) | BullMQ transport + future rate limiting | Set `REDIS_URL` + `BULLMQ_ENABLED=1` when available |
| Qwen via OpenAI-compatible gateway (college-hosted) | LLM content generation | `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`; without all three the service runs a marked stub |
| Tavily **or** SearXNG (both absent) | Web research | `TAVILY_API_KEY` or `SEARXNG_URL`; without either, research is skipped |
| GitHub (`Jiteshhh08/markly`, branch `main`) | Source of truth | `git push origin main` |
| AWS EC2 `t3.micro` (Ubuntu 24.04, ap-south-1) + Elastic IP | Prod host for API + AI containers | `/opt/markly` checkout, `docker-compose.prod.yml`, SSH via `Markly.pem` |
| Vercel | Prod frontend hosting (`marklyai.vercel.app`) | `VITE_API_URL` env var (baked at build; redeploy cache-off after changes) |
| Caddy 2.6.2 + Let's Encrypt + nip.io | Prod HTTPS (`13-234-227-216.nip.io` → `127.0.0.1:4000`); cert auto-renews | `/etc/caddy/Caddyfile` on the EC2 host |
| Qdrant (absent, future) | Vector retrieval when the corpus outgrows keyword search | Would plug into `retrieve_examples()` |

## 6. What is deliberately NOT used

No vector DB (corpus too small), no fine-tuning (gateway-only by design),
no Docker Desktop (WSL Engine for local dev, native Engine on EC2),
no cloud storage (local `assets/` + `corpus/`, both gitignored),
no self-hosted Mongo in prod (Atlas M0 instead), no full shadcn/Radix set.

