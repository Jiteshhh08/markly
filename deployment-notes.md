# Markly — Deployment Notes

> **Status: live.** Last verified: 2026-10-02.
> Frontend: `https://marklyai.vercel.app` · API: `https://13-234-227-216.nip.io`
> (both verified working end-to-end: register → generate → PDF download).

This file explains **what** is deployed, **where** it runs, **how** it was set up
(so you can redo it), and **why** each choice was made. For how the code itself
works, see `Documentation.md`; for every dependency, see `Utilities.md`.

---

## 1. What was deployed

Markly has three runtime parts. All three are live:

| # | Part | What it is | Where it runs |
|---|------|-----------|---------------|
| 1 | **Web frontend** (Vite + React build) | The workspace board UI: aim form, result view, drawer, templates, login, DOCX/PDF/HTML export | **Vercel** — `https://marklyai.vercel.app` |
| 2 | **API** (Node/Express, `apps/api`) | Validation, orchestration, auth (JWT), templates, renderers (HTML/DOCX/LaTeX), PDF jobs, history | **AWS EC2** (Docker container `markly-api-1`, port 4000 on localhost only) |
| 3 | **AI service** (Python/FastAPI, `services/ai-service`) | Prompt → Qwen LLM → validate → Assignment JSON | **AWS EC2** (Docker container `markly-ai-service-1`, internal port 8001) |
| 4 | **Database** (MongoDB) | Users + assignment/template persistence | **MongoDB Atlas M0** (free tier), database `markly` |
| 5 | **HTTPS terminator** (Caddy) | Real TLS certificate + reverse proxy to the API | **AWS EC2 host** (ports 80/443) |

What is deliberately **not** on the server: the frontend (Vercel serves it),
a local MongoDB (Atlas replaces it), Redis (jobs run in-process).

---

## 2. Where everything lives

### 2.1 Frontend — Vercel

- URL: `https://marklyai.vercel.app`
- Build-time variable (baked into the JS bundle at build time):
  `VITE_API_URL=` — **explicitly empty = same-origin**. The browser calls
  `/api/…` and `/assets/…` on `marklyai.vercel.app`; `vercel.json` rewrites
  **both** paths to the API on EC2 (session cookie stays first-party).
- Alternative (split hosting): set an absolute URL instead,
  `VITE_API_URL=https://13-234-227-216.nip.io` (no trailing slash), and the
  page calls the API directly (cookie becomes cross-site → `COOKIE_SECURE=1`).
- ⚠️ The variable must **exist** (empty or absolute). If it is missing
  entirely, the bundle falls back to `http://127.0.0.1:4000` and the site
  talks to the visitor's own machine (broken). After changing the variable you
  must **Redeploy with build cache OFF**, otherwise the old bundle is served.

### 2.2 Backend — AWS EC2

| Item | Value |
|---|---|
| Instance | `Markly` (`i-07823af8761d4730f`), `t3.micro` (1 vCPU, 1 GB RAM + 2 GB swap) |
| Region / AZ | ap-south-1 (Mumbai) / ap-south-1b |
| OS | Ubuntu 24.04 |
| Public IP | `13.234.227.216` — an **Elastic IP** (static; survives stop/start) |
| SSH | `ssh -i Markly.pem ubuntu@13.234.227.216` (key-only, no passwords) |
| Repo checkout | `/opt/markly` (branch `main`, GitHub `Jiteshhh08/markly`) |
| Docker / Compose | 29.1.3 / 2.40.3 |
| Caddy | 2.6.2 (systemd service, config `/etc/caddy/Caddyfile`) |
| Firewall | `ufw` active; AWS security group opens **22, 80, 443 from `0.0.0.0/0`**; ports 4000/8001 are **not** public |
| Disk | texlive image pre-pulled (~9 GB); ~14 GB free at deploy time |

Containers (`docker compose -f docker-compose.prod.yml ps`):

| Container | Port | Notes |
|---|---|---|
| `markly-api-1` | `127.0.0.1:4000` only | Has `docker-cli` + `/var/run/docker.sock` so it can launch PDF builds on the host |
| `markly-ai-service-1` | none published (internal `http://ai-service:8001`) | Reached only by the API container |

### 2.3 Database — MongoDB Atlas

- Cluster host: `cluster0.igmqkw2.mongodb.net`, database `markly` (M0 free tier).
- The API connects at boot; success line in logs: `[api] connected to MongoDB`.
  Without it the API still runs (in-memory mode) but restarts wipe history.
- Connection string shape (values are placeholders — real one lives only in
  `apps/api/.env` on the server and in local dev `.env`, never in git):
  `mongodb+srv://<DB_USER>:<DB_PASSWORD_URL_ENCODED>@cluster0.igmqkw2.mongodb.net/markly?appName=Cluster0`
- ⚠️ **URL-encode the password**: characters like `@`, `:`, `/`, `?`, `#` must
  be percent-encoded (`@` → `%40`). An unencoded `@` splits the URI and the
  driver resolves a garbage hostname (`querySrv ENOTFOUND …`).

### 2.4 HTTPS — Caddy + Let's Encrypt + nip.io

- Public API name: `13-234-227-216.nip.io` (nip.io resolves `13-234-227-216`
  to `13.234.227.216` — real DNS, no account needed).
- `/etc/caddy/Caddyfile` (backup at `/etc/caddy/Caddyfile.bak`):
  ```caddy
  13-234-227-216.nip.io {
      reverse_proxy 127.0.0.1:4000
  }
  ```
- Caddy obtained a real Let's Encrypt certificate automatically (valid
  2026-10-02 → 2026-12-31) and **renews it by itself** — no cron needed.
- Port 80 serves only the ACME challenge + redirect to HTTPS (308).

---

## 3. Why it is built this way (the decisions)

- **Frontend on Vercel, not EC2** — free static hosting with a global CDN and
  zero server maintenance. The t3.micro is too small to serve the UI well
  alongside two containers + texlive.
- **Backend on EC2 t3.micro, not Render/serverless** — the PDF step needs
  Docker-in-Docker (host socket + 9 GB texlive image) and ~2-minute compile
  timeouts; serverless platforms and small PaaS containers don't allow that.
  1 GB RAM is enough because only the API + AI service run there (swap covers
  pdflatex spikes).
- **MongoDB Atlas M0, not self-hosted Mongo** — one less stateful container to
  babysit on a 1 GB box; the free tier is plenty for users + history.
- **HTTPS via nip.io + Caddy, no owned domain, no tunnel** — the Vercel site
  is HTTPS, and browsers **block HTTPS pages from calling `http://` APIs**
  (mixed content), so the API needed trusted HTTPS. With no domain and no
  tunnel, `13-234-227-216.nip.io` gives a stable public hostname that Let's
  Encrypt can validate over plain HTTP-01 — no registrar, no extra account.
- **Elastic IP** — EC2 public IPs change on stop/start (this already caused one
  outage confusion); the EIP pins the address so DNS, certs, and `VITE_API_URL`
  never go stale.
- **Security group = 22/80/443 open, app ports closed** — three layers:
  AWS SG → Caddy → localhost-bound containers. SSH is key-only, so
  `0.0.0.0/0` on port 22 is acceptable (it also survives ISP IP rotation —
  a pinned-IP rule caused a full lockout once, see §6).
- **Containers via `docker-compose.prod.yml`** (separate from dev
  `docker-compose.yml`): production needs no `web` service, host-path binds
  for PDF (`./data` mounted at both `/app/data` **and** `/opt/markly/data`
  so the host dockerd sees the same `{dir}`), `TMPDIR=/opt/markly/data/tex`,
  docker socket mount, and `docker-cli` inside the API image.
- **Mongo writes are best-effort, memory is primary** — the API never crashes
  for lack of DB; it logs and continues in-memory. (Known limit: registered
  users live in memory, so an API restart logs everyone out until they log in
  again — the Mongo user mirror is write-only today.)

---

## 4. How to set this up (redo / onboard a new machine)

### 4.1 One-time AWS + Atlas setup

1. EC2: launch Ubuntu 24.04 `t3.micro` in ap-south-1; open SG inbound
   **22, 80, 443 from `0.0.0.0/0`**; download the `.pem` key.
2. EC2 → **Elastic IPs** → Allocate → associate with the instance.
3. Atlas: create M0 cluster; **Database Access** → create user, set password;
   **Network Access** → allow `0.0.0.0/0` (or the EIP); **Connect → application**
   → copy the `mongodb+srv://…` string and URL-encode the password.

### 4.2 Server prep (SSH as `ubuntu`)

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git caddy
sudo usermod -aG docker ubuntu          # re-login after this
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile
sudo ufw allow 22,80,443/tcp && sudo ufw enable
sudo docker pull texlive/texlive:latest # ~9 GB, do it once
git clone <repo-url> /opt/markly
```

### 4.3 Environment files (on the server, never committed)

`apps/api/.env`:
```ini
PORT=4000
MONGODB_URI=mongodb+srv://<DB_USER>:<DB_PASSWORD_URL_ENCODED>@cluster0.igmqkw2.mongodb.net/markly?appName=Cluster0
JWT_SECRET=<64-hex-chars>
AUTH_REQUIRED=1
COOKIE_SECURE=1
RATE_LIMIT_PER_MIN=60
# Native-docker variant (NOT the wsl one from Windows dev):
PDF_COMPILE_CMD=docker run --rm -v "{dir}:/work" -w /work texlive/texlive:latest pdflatex -interaction=nonstopmode -halt-on-error doc.tex
```
`services/ai-service/.env`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
plus `TAVILY_API_KEY` if research is wanted.

### 4.4 Start the stack + HTTPS

```bash
cd /opt/markly
docker compose -f docker-compose.prod.yml up -d --build
sleep 8
docker compose -f docker-compose.prod.yml logs -t api | grep -E 'MongoDB|listening'
docker compose -f docker-compose.prod.yml exec -T api wget -qO- http://ai-service:8001/health
# Caddy (replace IP): printf '13-234-227-216.nip.io {\n\treverse_proxy 127.0.0.1:4000\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo systemctl enable --now caddy && sudo systemctl reload caddy
curl -s -o /dev/null -w '%{http_code}\n' https://13-234-227-216.nip.io/api/v1/assignments/nope  # 401 = TLS+proxy OK
```

### 4.5 Point Vercel at it

- Rewrites (committed in `vercel.json`, redeploys with the site):
  `/api/:path*` → `http://13.234.227.216/api/:path*` **and**
  `/assets/:path*` → `http://13.234.227.216/assets/:path*` (the second one
  serves the header/watermark artwork the preview document references —
  without it they 404 as `marklyai.vercel.app/assets/…`).
- Env var (Settings → Environment Variables): `VITE_API_URL` left **empty**
  (same-origin through the rewrites above; see §2.1) →
  Deployments → Redeploy with **build cache OFF**.

### 4.6 Deploying a code change later

- **Backend** (`apps/api`, `services/ai-service`, `docker-compose.prod.yml`):
  `git pull` (or copy the file) in `/opt/markly`, then
  `docker compose -f docker-compose.prod.yml up -d --build` (plain
  `--force-recreate` is enough if only `.env` changed — but note: env-file
  changes are only picked up on **recreate**, never on `restart`).
- **Frontend** (`src/`): push/commit, then Vercel Redeploy (cache OFF if an
  env var or API contract changed).

---

## 5. Verification evidence (what "working" looked like)

| Check | Result |
|---|---|
| API boot | `[api] connected to MongoDB` + `listening on :4000` |
| AI health | `{"status":"ok","provider":"qwen-openai-compatible","model":"Qwen3.6-35B-A3B","promptVersion":"v1.0.0"}` |
| Register | `POST /api/v1/auth/register` → 201 `{token}` |
| Generate | `completed` — e.g. "Understanding SQL Joins in DBMS", 4 steps |
| PDF | `POST /api/v1/assignments/:id/pdf` → **200, `application/pdf`, 178,105 bytes, `%PDF-1.7`** (two pdflatex passes in texlive container) |
| Public HTTPS | `https://13-234-227-216.nip.io/…` → 401 `{"error":"Authentication required"}` (TLS trusted, proxy correct) |
| Error hygiene | Malformed JSON → `400 {"error":"Something went wrong…"}` (was: HTML stack page); error bodies carry only `error`, never `details`/`log` |
| Session cookies | `Set-Cookie: markly_token=…; HttpOnly; Secure; SameSite=None`; cookie-only `/auth/me` restores session (refresh-proof); logout stays logged out |
| Tests | API suite **116/116 pass** (30 suites); persistence across restart verified |
| Local machine | idle — no node/python/docker processes, WSL stopped, dev ports free |

---

## 6. Issues hit during deployment (and the fixes)

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | SSH timeout, instance "Running", 3/3 checks green | SG port-22 rule pinned to an **old ISP IP** (`103.165.69.115/32`); IP rotated | Source → `0.0.0.0/0` (key-only auth); added 80/443 |
| 2 | `Host key verification failed` on the new EIP | Recycled Elastic IP → stale `known_hosts` entry (someone else's key) | `ssh-keygen -R <ip>`, reconnected, verified fingerprint matched the original instance |
| 3 | `querySrv ENOTFOUND _mongodb._tcp.<wrong-host>` | Hand-typed URI had a stray `@segment` between the password and the real cluster host, so the driver resolved the stray text as the hostname | Removed the stray segment; added the `/markly` db name |
| 4 | `Password cannot be empty` → then `authentication failed` | Password starts with `@` and was unencoded/misplaced | Percent-encoded (`@` → `%40`); live-tested candidates from dev machine before writing `.env` |
| 5 | ai-service crash-loop `IndexError: parents[3]` in `subjects.py` | Container path depth differs from repo (`/app/app/…` has 3 parents, not 4) | `_find_repo_root()` walk-up + `SUBJECT_PROFILES_PATH` env + ro mount in compose |
| 6 | PDF `502 … 'file' cannot be empty` | Server `.env` had `PDF_COMPILE_CMD=` (empty); code used `??` which keeps `""` | `??` → `\|\|` fallback in `compile.js` + real native command in server `.env`; rebuilt image |
| 7 | Generate returned empty right after deploy | Test fired while ai-service was still booting | Health-wait loop before testing |
| 8 | Vercel site called `http://127.0.0.1:4000` | `VITE_API_URL` unset at build → fallback baked in | Set env var + cache-off redeploy (§4.5) |
| 9 | API crash-loop right after a deploy (`findRecord` import error) | Partial file push: new `assignments.js` scp'd without the matching `assignmentStore.js` refactor | Emergency stash to recover, then full consistent file set + rebuild; lesson: never push half a refactor — deploy the whole tested tree |
| 10 | Refresh logged users out (empty board hero) | Session cookie was `SameSite=Lax` → browsers drop it on Vercel→API cross-site fetch | `COOKIE_SECURE=1` (SameSite=None; Secure) + mirrored attrs on cookie clear; one fresh login mints the new cookie |

General lessons: `docker compose restart` does **not** re-read `env_file`
(use `--force-recreate`); PowerShell mangles multi-line SSH quoting
(send scripts base64-encoded); `ssh-keyscan` on old Windows OpenSSH can fail
KEX against new servers (compare fingerprints instead).

---

## 7. Day-to-day operations

```bash
cd /opt/markly
docker compose -f docker-compose.prod.yml ps            # status
docker compose -f docker-compose.prod.yml logs -t api --tail 30
docker compose -f docker-compose.prod.yml logs -t ai-service --tail 30
sudo journalctl -u caddy --since '30 min ago' | tail -20 # TLS/ACME log
df -h / ; docker system df                              # disk (texlive is ~9 GB)
ls data/tex/                                            # PDF work dirs (see note below)
```

- **Cert renewal**: automatic (Caddy + Let's Encrypt). Nothing to cron.
- **Cost**: EC2 t3.micro (free-tier eligible) + EIP free while attached +
  Atlas M0 free + Vercel hobby free + LE/nip.io free ≈ ₹0 at this scale.
- **Backups**: Atlas M0 has basic backups; repo + `.env` contents (kept outside
  git) are the rest. Known minor leak: PDF temp dirs under `data/tex/` are
  never cleaned — purge old `Markly-tex-*` dirs if disk runs low.
- **Known limits**: API restart wipes memory (password login fails until fresh
  logins); cookie sessions survive restart (stateless JWT, 7d); board state is
  React memory rebuilt from server history (zero browser storage).

## 8. Secrets hygiene

`.env` files are gitignored and must stay that way. If you ever need to share
access, share the **values** through a password manager — never paste real
URIs, JWT secrets, or LLM keys into docs, chat logs, or screenshots.
