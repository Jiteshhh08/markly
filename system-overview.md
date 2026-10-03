# Markly — System Overview

> The guided tour: what happens when you click things, where data lives, and
> which file to open when you want to change something. Deep API/prompt detail
> lives in `Documentation.md`; production topology in `deployment-notes.md`.

## 1. The big picture

```
BROWSER (Vercel build: marklyai.vercel.app)
  │  fetch, Bearer (memory token) + httpOnly cookie   state: React memory only
  ▼                                                   (zero browser storage)
Caddy :443 (EC2 host, Let's Encrypt) ── reverse_proxy ──▶ API :4000 (localhost only)
                                                            │  Express, apps/api/src
                              ┌─────────────────────────────┼─────────────────────────────┐
                              ▼                             ▼                             ▼
                     AI service :8001 (internal)   MongoDB Atlas (users/history)   texlive container (PDF)
                     FastAPI → Qwen LLM                                          via host docker.sock
```

Local dev is the same shape with different addresses: Vite `:5173` →
API `127.0.0.1:4000` → AI `127.0.0.1:8001` → local Mongo or memory.

## 2. A click's journey — Generate

1. Board card form (`src/App.jsx`) collects aim/subject/experiment/template.
   Logged out? Generation is not attempted — the login modal opens instead.
2. `apiFetch('/api/v1/assignments/generate')` (180s timeout) with
   `Authorization: Bearer <memory token>` plus the `markly_token` cookie.
3. API validates (`apps/api/src/schemas.js`), looks up the subject profile
   (`lib/subjects.js` ← `packages/shared/subject-profiles.json`) and template
   (`lib/templateStore.js`), pulls style examples (AI corpus), optionally
   researches (Tavily/SearXNG — skipped unless configured AND the subject
   needs it).
4. AI service (`services/ai-service/app/pipeline.py`): builds prompt
   (`prompts.py`) → Qwen (`llm/qwen.py`, OpenAI-compatible) → extracts JSON →
   Pydantic validation (`schemas.py`) → semantic checks (`validators.py`,
   `codecheck.py` with sqlglot; one retry on failure).
5. API re-validates (zod), saves the record (memory always, Mongo
   best-effort), returns it with `provenance` (provider, model, promptVersion).
6. UI renders sections; heading for the steps list is **Steps**.

## 3. A click's journey — PDF download

1. `POST /api/v1/assignments/:id/pdf` → preflight (`checkCompiler`: is the
   texlive image present? if not, an explicit "pull it" 502 — never a hang).
2. Renderer (`render/latex.js`) turns content + template seed into `doc.tex`.
3. `compileLatexToPdf` (`lib/compile.js`) writes a temp dir under `$TMPDIR`
   and runs **two** pdflatex passes (tikz overlays need pass 2) in a one-shot
   `texlive/texlive:latest` container. In production `$TMPDIR` is
   `/opt/markly/data/tex`, bind-mounted at the same host path so the host
   dockerd can see it.
4. The PDF streams back (`application/pdf`) and a copy lands in
   `assets/generated/assignment-<id>.pdf`.
5. The compile command comes from `PDF_COMPILE_CMD`, with platform flavors:
   Windows dev uses `wsl docker … "{wslDir}"`, the server uses native
   `docker … "{dir}"`. Empty/unset falls back to the native default.

## 4. A click's journey — auth

Register/login (`routes/auth.js`, bcrypt + JWT) → `{token}` → token kept in
memory, session also set as httpOnly `markly_token` cookie. Every call carries
both (Bearer + `credentials: 'include'`). A 401 anywhere (logged out or expired
token) opens the login modal with a "Login required" notice instead of failing,
and templates reload right after login. On boot the board restores a still-valid
cookie session via `GET /auth/me` — refresh keeps you logged in with zero
browser storage (production needs `COOKIE_SECURE=1` so the cookie is
cross-site-capable; without it every refresh logs you out). Logout clears the
token and the cookie with matching attributes. Note: password login needs the
in-memory users map, so it fails right after an API restart until users log in
fresh — but existing cookie sessions survive restarts (stateless JWT, 7d).

## 5. Where state lives

| State | Where | Survives restart? |
|---|---|---|
| Board cards, token, UI prefs | React memory only (zero browser storage) | Reload rebuilds the board from server history; session restores from cookie |
| Assignment records, users, templates | API process memory | **No** — restart wipes |
| Users (copy), assignments, templates | MongoDB Atlas `markly` | Yes (but list/history reads memory today) |
| Uploaded PDFs, generated PDFs, artwork | `apps/api/assets/` (+ `data/` in prod) | Yes (disk, gitignored) |
| Ingested examples | `services/ai-service/corpus/` | Yes (disk, gitignored) |
| Template versions | `templateStore` memory + Mongo upsert | Code seeds always re-load as v1 |

## 6. "I want to change X" cheat sheet

| Change | File(s) |
|---|---|
| Steps heading / section titles | `src/App.jsx`, `apps/api/src/render/{html,docx,latex}.js` |
| What the LLM is asked / output shape | `services/ai-service/app/prompts.py`, `schemas.py` |
| Subject behavior (needs research? tech?) | `packages/shared/subject-profiles.json` |
| PDF layout | `apps/api/src/render/latex.js` (+ `compile.js` for the command) |
| HTML preview layout, 50% watermark rule | `apps/api/src/render/html.js` |
| DOCX layout | `apps/api/src/render/docx.js` |
| Tenant template seed / faculty table | `apps/api/src/templates/*.json` |
| API routes / validation | `apps/api/src/routes/*.js`, `src/schemas.js` |
| Auth rules + session cookie | `apps/api/src/routes/auth.js`, `lib/auth.js`, `AUTH_REQUIRED`, `COOKIE_SECURE` |
| Error contract (generic client messages) | `apps/api/src/lib/errors.js`, final middleware in `src/index.js` |
| Friendly transport errors (offline/timeout) | `apiFetch` in `src/services/api.js` (single choke point) |
| Empty-board hero + dashboard link | `EmptyState` in `src/App.jsx` |
| Timeouts (UI stalls) | `src/services/api.js` (per-request timeout, 180s for generation) |

## 7. Environments compared

| | Local dev | Production |
|---|---|---|
| Frontend | `npm run dev` :5173 | Vercel build, `VITE_API_URL` baked in |
| API | `node src/index.js` :4000 | container, `127.0.0.1:4000` behind Caddy |
| AI | `uvicorn …` :8001 | internal container, no public port |
| DB | local mongo / memory | Atlas (restart-safe for the copy) |
| PDF | WSL docker + texlive | host dockerd + texlive |
| HTTPS | none (http localhost) | Caddy + Let's Encrypt via nip.io |

## 8. Gotchas that already bit once

- Frontend env vars bake at **build** time — changing `VITE_API_URL` needs a
  cache-off redeploy, not just a save.
- Compose `restart` ignores `.env` changes — use `--force-recreate`; code
  changes need `--build`.
- Mongo passwords with `@ : / ? #` must be percent-encoded in the URI.
- An empty `PDF_COMPILE_CMD` now means "use default" (was: crash).
- API restart wipes memory (password login fails until fresh logins), but cookie
  sessions survive (stateless JWT) — reload restores from `/auth/me`.
- Prod refresh logging you out = missing `COOKIE_SECURE=1` (cookie blocked
  cross-site); log in once after setting it.
- Logged-out/expired actions open the login modal — a raw 401 on screen means
  the modal path was bypassed (report it).
- Client errors are always generic by contract (`sendError`); technical detail
  lives in `docker logs`, never on screen — if you see a stack or status code
  in the UI, that's a bug.
- PDF temp dirs under `data/tex/` accumulate — clean old ones if disk fills.
