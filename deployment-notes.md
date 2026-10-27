# Markly — Deployment Notes

> **Last recorded production deployment: 2026-10-02.** Frontend on Vercel, API +
> AI service on AWS EC2 behind Caddy, MongoDB Atlas.
>
> **Stage 8 review (2026-10-26): not re-verified.** This review did not deploy,
> merge into `main`, create a PR, or access production data. Treat every production
> result below as historical until it is re-run. The current production
> prerequisites and fail-closed behavior are described in §4 and §8.

This file explains what was deployed, where it ran, how it was set up, and the
current requirements for a safe redeploy. For how the code works, see
`Documentation.md`; for the guided tour, see `system-overview.md`.

---

## 1. What is deployed

| # | Part | What it is | Historical location |
|---|---|---|---|
| 1 | **Web frontend** (Vite + React build) | Workspace board, drawer/document studio, templates, preferences, admin, auth | Vercel — `https://marklyai.vercel.app` |
| 2 | **API** (Node/Express, `apps/api`) | Validation, orchestration, auth, multi-college authorization, versioned templates, document blocks, renderers, PDF jobs, history | AWS EC2 container `markly-api-1`, `127.0.0.1:4000` |
| 3 | **AI service** (Python/FastAPI) | Prompt → Qwen → validate → Assignment JSON | AWS EC2 container `markly-ai-service-1`, internal `:8001` |
| 4 | **Database** (MongoDB) | Users, assignments, templates, colleges/branches, audit | MongoDB Atlas M0, database `markly` |
| 5 | **HTTPS terminator** (Caddy) | TLS + reverse proxy to the API | AWS EC2 host, ports 80/443 |

Deliberately not on the server: the frontend (Vercel serves it), a local MongoDB
(Atlas replaces it), and Redis (jobs run in-process).

---

## 2. Historical topology

### 2.1 Frontend — Vercel

- URL: `https://marklyai.vercel.app`
- Build-time variable: `VITE_API_URL=`. **Explicitly empty = same-origin.** The
  browser calls `/api/…` and `/assets/…` on the Vercel host; `vercel.json` rewrites
  both paths to the API, keeping the session cookie first-party.
- Split hosting alternative: set an absolute API URL and `COOKIE_SECURE=1` on the
  API (the cookie becomes cross-site).
- The variable must exist (even if empty). If it is missing, the bundle falls back
  to `http://127.0.0.1:4000`. Redeploy with build cache OFF after changing it.

### 2.2 Backend — AWS EC2

| Item | Historical value |
|---|---|
| Instance | `Markly` (`i-07823af8761d4730f`), `t3.micro` |
| Region / AZ | ap-south-1 (Mumbai) / ap-south-1b |
| OS | Ubuntu 24.04 |
| Public IP | `13.234.227.216` (Elastic IP) |
| Repo checkout | `/opt/markly` |
| Docker / Compose | 29.1.3 / 2.40.3 |
| Caddy | 2.6.2 (systemd, `/etc/caddy/Caddyfile`) |
| Firewall | `ufw` active; AWS SG opens 22/80/443; app ports 4000/8001 are not public |
| Disk | texlive image pre-pulled (~9 GB) |

Containers:

| Container | Port | Notes |
|---|---|---|
| `markly-api-1` | `127.0.0.1:4000` | Has `docker-cli` + `/var/run/docker.sock` to launch PDF builds on the host |
| `markly-ai-service-1` | internal `:8001` | Reached only by the API container |

### 2.3 Database — MongoDB Atlas

- Cluster host: `cluster0.igmqkw2.mongodb.net`, database `markly` (M0).
- The API connects at boot; the success line is `[api] connected to MongoDB`.
- Connection string shape (placeholders only):
  `mongodb+srv://<DB_USER>:<DB_PASSWORD_URL_ENCODED>@cluster0.igmqkw2.mongodb.net/markly?appName=Cluster0`
- **URL-encode the password**: `@`, `:`, `/`, `?`, `#` must be percent-encoded.
- MongoDB is authoritative for users, assignments, templates, colleges, branches,
  and audit. Memory is a hot cache. In production, registration/profile updates
  and assignment mutations fail closed with `503` if Mongo is unavailable; they do
  not silently succeed in memory.

### 2.4 HTTPS — Caddy + Let's Encrypt + nip.io

- Public API name: `13-234-227-216.nip.io` (nip.io resolves the IP; no account).
- `/etc/caddy/Caddyfile`:

  ```caddy
  13-234-227-216.nip.io {
      reverse_proxy 127.0.0.1:4000
  }
  ```

- Caddy obtains and renews the Let's Encrypt certificate automatically.
- Caddy connects to the host's `127.0.0.1:4000`. Verify what source address the
  API container actually sees: Docker NAT can present the bridge gateway rather
  than loopback. The default `TRUST_PROXY=loopback` is correct only when the
  container sees the proxy as loopback; otherwise set `TRUST_PROXY` to the
  Docker bridge subnet (for example `172.17.0.0/16`) or the correct hop count.
  Do not set it to `true` on a directly exposed API.

---

## 3. Why it is built this way

- **Frontend on Vercel** — free static hosting/CDN, no UI load on the small EC2 box.
- **Backend on EC2** — the PDF step needs Docker-in-Docker (host socket + texlive
  image) and long compile timeouts; serverless platforms do not fit.
- **Atlas M0** — one less stateful container on a 1 GB host.
- **HTTPS via nip.io + Caddy** — trusted TLS without owning a domain; Vercel is
  HTTPS and browsers block mixed-content API calls.
- **Elastic IP** — keeps DNS, certificates, and `VITE_API_URL` stable across
  stop/start.
- **Security group = 22/80/443 open, app ports closed** — AWS SG → Caddy →
  loopback-bound containers.
- **Durable-first writes in production** — a successful response must mean the
  write reached MongoDB. Local dev can still run in memory.
- **Private generated PDFs** — the authenticated assignment route streams them;
  the public `/assets` mount explicitly rejects `/assets/generated`.

---

## 4. Current production prerequisites

Before any redeploy:

1. **MongoDB reachable and durable.** `MONGODB_URI` must point at the intended
   database. Production registration, profile updates, and assignment mutations
   fail closed if it is down.
2. **Strong `JWT_SECRET`.** The documented placeholder is rejected when
   `AUTH_REQUIRED=1`.
3. **`AUTH_REQUIRED=1`, `COOKIE_SECURE=1`, `NODE_ENV=production`.**
4. **`ALLOWED_ORIGINS`** must list the exact frontend origin(s). An empty list
   fails closed for browser origins in production.
5. **`TRUST_PROXY`** must match the reverse-proxy topology. Default `loopback` is
   correct for host Caddy → `127.0.0.1:4000`.
6. **texlive image pre-pulled.** `PDF_COMPILE_CMD` must include
   `-no-shell-escape`; the default does.
7. **Do not expose `assets/generated`.** It contains private assignment PDFs.
   The API blocks it; a CDN/static server must not re-add it.
8. **Seed/migration CLIs are dry-run by default.** Writes require `--apply` and
   `--confirm-db <exact-db>`. With `NODE_ENV=production`, writes additionally
   require the one-command opt-in `ALLOW_PRODUCTION_DB_WRITE=1` after reviewing the
   dry-run.
9. **Backups.** Atlas backups plus the server `.env` (kept outside git) are the
   recovery baseline.
10. **Multi-instance caveat.** Job status/progress and rate-limit windows are
    process-local; use a shared store before scaling horizontally.

### 4.1 TCET seed / branch backfill

The onboarding default depends on the Stage 1 seed having created the `tcet`
college, all ten branches, and the Computer Engineering template. Apply it before
enabling the Templates banner in a new environment. From `apps/api`, with
`MONGODB_URI` pointing at the intended database:

```bash
node scripts/seed-multicollege.js
node scripts/seed-multicollege.js --apply --confirm-db <exact-db>
```

The first command is a dry-run. The seed is idempotent: it inserts only missing
documents and backfills a missing `tcet-computer-engineering` branch default. It
never overwrites an administrator-chosen default, and it never touches
assignments. Production writes still require the documented
`ALLOW_PRODUCTION_DB_WRITE=1` opt-in.

The onboarding fallback is active only while the `tcet` Tenant and
`tcet-computer-engineering` Department exist and the template is published. It is
shown to ordinary users with no saved college and no college membership;
administrators, college members, and users with a saved college preference keep
normal college/branch isolation. If the branch is deactivated or the template is
archived, the fallback disappears and those users receive the existing
preferences-required error instead of a cross-college template.

---

## 5. Setup (historical, corrected)

### 5.1 One-time AWS + Atlas

1. EC2: Ubuntu 24.04 `t3.micro` in ap-south-1; SG inbound 22/80/443; download the
   `.pem`.
2. Allocate an Elastic IP and associate it.
3. Atlas: create M0; create a DB user; allow the EIP (or `0.0.0.0/0` only if
   necessary); copy the SRV URI and URL-encode the password.

### 5.2 Server prep

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git caddy
sudo usermod -aG docker ubuntu          # re-login after this
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile
sudo ufw allow 22,80,443/tcp && sudo ufw enable
sudo docker pull texlive/texlive:latest
git clone <repo-url> /opt/markly
```

### 5.3 Environment files (server, never committed)

`apps/api/.env`:

```ini
NODE_ENV=production
PORT=4000
MONGODB_URI=mongodb+srv://<DB_USER>:<DB_PASSWORD_URL_ENCODED>@cluster0.igmqkw2.mongodb.net/markly?appName=Cluster0
JWT_SECRET=<64-hex-chars>
AUTH_REQUIRED=1
COOKIE_SECURE=1
ALLOWED_ORIGINS=https://marklyai.vercel.app
TRUST_PROXY=loopback
RATE_LIMIT_PER_MIN=60
PDF_COMPILE_CMD=docker run --rm -v "{dir}:/work" -w /work texlive/texlive:latest pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error doc.tex
```

`services/ai-service/.env`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, plus
`TAVILY_API_KEY` if research is wanted.

### 5.4 Start the stack + HTTPS

```bash
cd /opt/markly
docker compose -f docker-compose.prod.yml up -d --build
sleep 8
docker compose -f docker-compose.prod.yml logs -t api | grep -E 'MongoDB|listening'
docker compose -f docker-compose.prod.yml exec -T api wget -qO- http://ai-service:8001/health
printf '13-234-227-216.nip.io {\n\treverse_proxy 127.0.0.1:4000\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo systemctl enable --now caddy && sudo systemctl reload caddy
curl -s -o /dev/null -w '%{http_code}\n' https://13-234-227-216.nip.io/api/v1/assignments/nope  # 401 = TLS+proxy OK
```

### 5.5 Point Vercel at it

- `vercel.json` rewrites `/api/:path*` and `/assets/:path*` to the API.
- `VITE_API_URL` must exist and be empty for same-origin, then redeploy with build
  cache OFF.
- **Gotcha (2026-10-27):** the Vercel rewrite does NOT match trailing-slash URLs
  — `GET /api/v1/preferences/` 404s on Vercel (HTML body, no `error` field),
  while the identical Express route matches fine locally. Keep every frontend
  call slash-less (`/api/v1/preferences`, never `/api/v1/preferences/`); the
  Vite dev proxy and Express hide this otherwise.
- Set `ALLOWED_ORIGINS=https://<frontend-host>` on the API when traffic arrives
  through the Vercel rewrite: the proxied request's `Host` is the destination
  host, so cookie-authenticated mutations (PUT/POST) would otherwise fail the
  same-origin CSRF check with 403 even after the GET starts working.

### 5.6 Deploying a code change later

- **Backend:** `git pull` in `/opt/markly`, then
  `docker compose -f docker-compose.prod.yml up -d --build`. Env-file changes need
  a recreate, not `restart`.
- **Frontend:** push/commit, then Vercel Redeploy (cache OFF if an env var or API
  contract changed).

---

## 6. Verification evidence (historical, 2026-10-02)

| Check | Historical result |
|---|---|
| API boot | `[api] connected to MongoDB` + `listening on :4000` |
| AI health | `{"status":"ok","provider":"qwen-openai-compatible",...}` |
| Register | `POST /api/v1/auth/register` → 201 `{token}` |
| Generate | `completed` with real Qwen output |
| PDF | `POST /api/v1/assignments/:id/pdf` → 200, `application/pdf`, `%PDF-1.7` |
| Public HTTPS | 401 JSON from the public API host (TLS/proxy OK) |
| Session cookies | `HttpOnly; Secure; SameSite=None`; cookie-only `/auth/me` restores |
| Error hygiene | Malformed JSON → generic JSON error, no stack |
| Tests | See the Stage 8 final report for the current local count; the historical deployment recorded a smaller earlier suite |

These are historical results. The Stage 8 review did not deploy or re-run them.

---

## 7. Operations

```bash
cd /opt/markly
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -t api --tail 30
docker compose -f docker-compose.prod.yml logs -t ai-service --tail 30
sudo journalctl -u caddy --since '30 min ago' | tail -20
df -h / ; docker system df
ls data/tex/
```

- **Cert renewal:** automatic (Caddy + Let's Encrypt).
- **Cost:** EC2 t3.micro + EIP + Atlas M0 + Vercel hobby + LE/nip.io.
- **Backups:** Atlas backups; repo + server `.env` outside git.
- **Disk cleanup:** old `data/tex/Markly-tex-*` directories are not automatically
  removed.
- **Restart behavior:** users, assignments, templates, colleges/branches, and audit
  are rehydrated from MongoDB. Job status/progress and rate-limit windows are not;
  in-flight jobs are lost on restart.

---

## 8. Known limitations and residual risks

- **Preferences are self-asserted.** Any authenticated user can select any active
  college/branch, so college-shared templates are not confidential from a user who
  selects that college.
- **Onboarding default is an intentional cross-college exception.** Until an
  ordinary user saves a college/branch or joins a college, the Templates catalogue
  and generation may use the seeded TCET Computer Engineering template. The
  exception is disabled for administrators, college members, and any user with a
  saved college preference. Deactivating the TCET branch or archiving the template
  removes it.
- **Legacy ownerless assignments** remain visible to authenticated users for
  migration compatibility.
- **`User.email` is not unique.** Concurrent registrations are guarded by an
  existence check and an upsert, but add a unique partial index after cleaning any
  existing duplicates.
- **Job status and rate limits are process-local.** Do not scale horizontally
  without a shared status/limit store.
- **No Stage 8 deployment verification.** Real texlive compilation, visual
  DOCX/PDF comparison, and browser admin-v2 publishing were not re-exercised.
- **PDF temp directories** under `data/tex/` accumulate.
- **Custom PDF commands** must include `-no-shell-escape`; saved LaTeX overrides are
  untrusted input.

---

## 9. Secrets hygiene

`.env` files are gitignored and must stay that way. Share values through a password
manager, never through docs, chat logs, screenshots, or commits. The seed/migration
CLIs never write without `--apply` + matching `--confirm-db`, and production writes
require `ALLOW_PRODUCTION_DB_WRITE=1` for that one command.
