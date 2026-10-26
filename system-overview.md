# Markly — System Overview

> The guided tour: what happens when you click things, where data lives, and
> which file to open when you want to change something. Deep API/prompt detail
> lives in `Documentation.md`; production topology and prerequisites in
> `deployment-notes.md`.
>
> **Stage 8 review (2026-10-26):** local review only. No deployment, merge, or PR
> was performed; the production notes below are historical.

## 1. The big picture

```
BROWSER (Vite build; same-origin via /api and /assets rewrites)
  │  fetch + Bearer (in-memory token) + httpOnly markly_token cookie
  │  UI state: React memory only (zero browser storage)
  ▼
Caddy :443 (host, TLS) ── reverse_proxy ──▶ API :4000 (loopback only)
                                             │ Express, apps/api/src
                    ┌────────────────────────┼────────────────────────┐
                    ▼                        ▼                        ▼
          AI service :8001          MongoDB Atlas            texlive container
          FastAPI → Qwen/stub       users, assignments,      two pdflatex passes
                                    templates, audit         via host docker.sock
```

Local dev has the same shape: Vite `:5173` → API `127.0.0.1:4000` → AI
`127.0.0.1:8001` → local Mongo or memory.

## 2. A click's journey — Generate

1. `CreateModal` collects aim/subject/experiment/technology/template. Logged-out
   users get the login modal instead of a generation attempt.
2. `apiFetch('/api/v1/assignments/generate')` sends the in-memory Bearer token and
   the httpOnly cookie.
3. The API validates input (`src/schemas.js`), resolves the subject profile
   (`lib/subjects.js` ← `packages/shared/subject-profiles.json`), and resolves the
   exact template version. An explicit `templateId` never falls back to another
   college or a default; omitting it resolves the actor's usable default once and
   pins that version on the assignment.
4. The AI service builds the prompt, calls Qwen (or the marked stub), extracts JSON,
   validates it with Pydantic, and runs semantic/code checks. Research is optional
   and skipped unless configured and relevant.
5. The API re-validates with zod, persists the record durably, then returns it with
   `provenance` and `sources`. In production a failed durable write returns `503`
   instead of a success response.
6. The board renders the card and the drawer shows the saved document.

## 3. A click's journey — document studio and export

1. `GET /assignments/:id/document` projects legacy content into `document.blocks`
   on read (without writing it back).
2. The studio edits a flat, validated block list: title, experiment number, heading,
   subheading, paragraph, bullet/numbered list, code, spacer, page break; plus
   alignment, font size, order, insert/delete/duplicate.
3. `PUT /assignments/:id/document` sends the expected `revision`. A stale revision
   gets `409`; the save lock serializes concurrent writers. The durable write
   happens before the in-memory cache is updated. Unlike the other assignment
   mutations, a document save always requires Mongo: a failed write returns `503`
   and leaves the previous document intact, even in local/test mode.
4. HTML, DOCX, and LaTeX renderers all call `render/renderModel.js` for the same
   ordered node list, styles, template geometry, header/logo/watermark/footer, page
   border, and faculty table.
5. `POST /assignments/:id/pdf` checks the texlive image, renders LaTeX, writes a temp
   directory, and runs two pdflatex passes in an isolated container. The default
   command includes `-no-shell-escape`.
6. PDF bytes stream back from the authenticated route. A copy is written under
   `assets/generated/`, but that directory is blocked from the public `/assets`
   static mount; predictable filenames are not enumerable over HTTP.

## 4. A click's journey — auth and session

1. Register/login (`routes/auth.js`, bcrypt + JWT) returns `{ token }` and sets the
   httpOnly `markly_token` cookie. Tokens carry only `sub` and `email`.
2. Every request carries both credentials. A valid Bearer wins; otherwise a valid
   cookie wins. An invalid Bearer never masks a valid cookie.
3. Authorization reads the current MongoDB user (`lib/roles.js`), so role or college
   changes take effect on the next request without re-issuing a token. Forged role
   claims are ignored.
4. On boot the UI restores the session via `GET /auth/me`; refresh keeps the user
   logged in with zero browser storage. Production needs `COOKIE_SECURE=1` for the
   cross-site cookie.
5. Users are hydrated from MongoDB at API boot, so password login survives a
   restart. Registration and profile updates fail closed in production if durable
   storage is unavailable.
6. Logout clears the cookie with matching attributes and wipes the board state.

## 5. Templates, preferences, and multi-college admin

- **Scopes:** `platform` (global, platform-admin published), `college` (shared
  within one college/branch), `private` (owner only), `legacy` (platform-admin
  review only).
- **Versioning:** every publish/edit forks an immutable version. Assignments keep
  their exact `{ templateId, templateVersion }`; older versions stay readable.
- **Branch defaults:** `{ defaultTemplateId, defaultTemplateVersion }` on the
  branch, pinned to an exact version. Publishing a newer version does not silently
  repoint it.
- **Catalogue scope:** `GET /templates?collegeId=&departmentId=` is authorized
  server-side. Missing scope never means "all colleges"; ordinary users without a
  scope see published platform templates only.
- **Preferences:** `GET/PUT /preferences` operate only on `req.actor.id`. A saved
  college/branch and optional preferred template version are stored on the user.
- **Admin UI:** platform admins manage colleges and branch admins; college admins
  manage their own branches, templates, defaults, and audit trail. The branch
  template view intentionally excludes platform templates; platform admins can
  still see and set them.

## 6. Where state lives

| State | Where | Survives restart? |
|---|---|---|
| Board cards, token, UI state | React memory only | Reload rebuilds the board from server history; session restores from the cookie |
| Users, assignments, templates, colleges, branches, audit | MongoDB (authoritative) | Yes |
| API hot cache | Process memory | Rebuilt from MongoDB on demand/boot |
| Uploaded template images, generated PDFs, artwork | `apps/api/assets/` (gitignored runtime dirs) | Yes, on disk; generated PDFs are private |
| Ingested examples | `services/ai-service/corpus/` | Yes, on disk (gitignored) |
| Job status/progress | Process memory (even with BullMQ) | No; multi-instance needs a shared store |
| Rate-limit windows | Process memory | No |

## 7. "I want to change X" cheat sheet

| Change | File(s) |
|---|---|
| Steps heading / section titles | `apps/api/src/render/{html,docx,latex}.js` + `src/features/assignments/DetailDrawer.jsx` |
| What the LLM is asked / output shape | `services/ai-service/app/prompts.py`, `schemas.py` |
| Subject behavior | `packages/shared/subject-profiles.json` |
| Shared document model / block types | `apps/api/src/lib/documentBlocks.js`, `render/renderModel.js` |
| HTML preview / 50% watermark | `apps/api/src/render/html.js`, `render/renderModel.js` |
| DOCX layout | `apps/api/src/render/docx.js` |
| LaTeX/PDF layout | `apps/api/src/render/latex.js`, `lib/compile.js` |
| Template scopes / visibility | `apps/api/src/lib/templateAccess.js`, `templateCatalogue.js` |
| Template versions / persistence | `apps/api/src/lib/templateStore.js` |
| Multi-college admin routes | `apps/api/src/routes/admin.js` |
| Preferences | `apps/api/src/routes/preferences.js` |
| Auth/session/CSRF/CORS | `apps/api/src/routes/auth.js`, `lib/auth.js`, `lib/csrf.js`, `lib/cors.js`, `src/index.js` |
| Error contract | `apps/api/src/lib/errors.js`, final middleware in `src/index.js` |
| Frontend transport errors | `apiFetch` in `src/services/api.js` |

## 8. Environments compared

| | Local dev | Production (historical topology) |
|---|---|---|
| Frontend | `npm run dev` :5173 | Vercel build, same-origin via `/api` + `/assets` rewrites |
| API | `node src/index.js` :4000 | container, `127.0.0.1:4000` behind Caddy |
| AI | `uvicorn` :8001 | internal container, no public port |
| DB | local Mongo or memory | Atlas; production mutations require it |
| PDF | WSL/native Docker + texlive | host dockerd + texlive |
| HTTPS | none (localhost) | Caddy + Let's Encrypt |
| Proxy | none | Caddy; `TRUST_PROXY` defaults to `loopback` |

## 9. Gotchas that already bit once

- Frontend env vars bake at **build** time — changing `VITE_API_URL` needs a
  cache-off redeploy.
- Compose `restart` ignores `.env` changes — use `--force-recreate`; code changes
  need `--build`.
- Mongo passwords with `@ : / ? #` must be percent-encoded in the URI.
- An empty `PDF_COMPILE_CMD` means "use the default" (the code uses `||`).
- Prod refresh logging you out = missing `COOKIE_SECURE=1`; log in once after
  setting it.
- Behind Caddy, rate limiting needs the proxy-aware client IP. `TRUST_PROXY`
  defaults to `loopback`; in a container, verify whether Docker NAT presents the
  bridge gateway instead and set the bridge subnet/hop count accordingly.
- A production registration/profile/assignment write that cannot reach Mongo now
  fails closed with `503`; it does not silently succeed in memory.
- Generated PDFs under `assets/generated/` are private. Do not re-expose that
  directory through a static server or CDN.
- Custom `PDF_COMPILE_CMD` values must include `-no-shell-escape`.
- PDF temp dirs under `data/tex/` accumulate — clean old ones if disk fills.

## 10. Residual risks (Stage 8 review)

- Preferences are self-asserted: any authenticated user can select any active
  college/branch, so college-shared templates are not confidential from a user who
  selects that college.
- Legacy ownerless assignments remain visible to authenticated users for migration
  compatibility.
- `User.email` is not unique; concurrent registrations are guarded but a unique
  partial index is still recommended after duplicate cleanup.
- Job status and rate limits are process-local.
- Real texlive compilation, pixel-level DOCX/PDF comparison, and the admin v2
  publishing flow were not re-verified in the Stage 8 review.
