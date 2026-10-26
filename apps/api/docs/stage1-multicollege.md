# STAGE 1 — multi-college data model, access rules and safe tooling

This stage added the data/security foundation. Later stages added the admin UI,
preferences UI, visual document editor, and renderer integration on top of it.
This document describes the Stage 1 rules and notes where later stages completed
the wiring. **Stage 8 review (2026-10-26): local review only; no deployment.**

## Entities

- `Tenant` = college (reused, not duplicated).
- `Department` = branch (reused, not duplicated).
- `User.role` is one of `user`, `college_admin`, `platform_admin`.
- `User.collegeAdminOf` lists the colleges a `college_admin` may manage.
- `Template.scope` is one of:
  - `platform` — global catalogue, managed by platform admins.
  - `college` — shared within one college/branch, managed by that college's
    admins (and platform admins).
  - `private` — visible/manageable only by `ownerUserId`, never by admins.
  - `legacy` — ownership unknown. Platform-admin review only until explicitly
    claimed/scoped. Never silently shared.
- `active` and `published` both mean published. `archived` is readable to
  managers but not selectable for new assignments.

The rules live in `src/lib/templateAccess.js`; authorization primitives live in
`src/lib/roles.js`. Admin authorization always loads the **current persisted
User** from MongoDB. JWT role claims are ignored, so a role change takes effect
without issuing new tokens.

## Catalogue visibility (wired in STAGE 2)

`GET /api/v1/templates` and `GET /api/v1/templates/:id` enforce:

- `private` templates are visible only to their owner (never to admins);
- `legacy` templates are visible only to platform admins;
- shared `platform`/`college` templates are filtered by the explicit
  `collegeId`/`departmentId` scope (aliases `tenantId`/`branchId`), authorized by
  `templateCatalogue.js`.

Missing scope never means "return every college": an ordinary user without a
scope/preference sees published platform templates only. Platform admins may
request any scope; college admins may request their administered colleges;
ordinary users need persisted preferences or college membership. Anonymous
callers cannot request a college scope. This wiring was completed in STAGE 2, so
the route is now a tenant-isolated catalogue rather than the broad Stage 1 list.

## Registration and profile updates

Public registration accepts credentials/name only. `role`, `collegeAdminOf`,
`tenantIds` and preferences are ignored. New accounts are always `user`.

Registration rejects **any** existing persisted email, including legacy
accounts without a password hash. Such accounts are never claimed through
public registration (that could hand an existing privileged account to the
registrant); they require an explicit administrative recovery. The insert is
also checked with `upsertedCount`, so a concurrent registration cannot turn
into an overwrite.

`PATCH /api/v1/auth/profile` accepts only `name` and `avatarUrl`. It cannot
change role or college scope, even if those fields are present in the body.

In production (`NODE_ENV=production`), registration and profile updates fail
closed with `503` when MongoDB is unavailable; they never return a token for an
account that exists only in process memory. Local development and tests keep the
memory-only fallback.

## CORS

`ALLOWED_ORIGINS` is a comma-separated browser-origin allowlist.

- Outside production an empty allowlist keeps the historical permissive
  behaviour (local development/tests).
- In production (`NODE_ENV=production`) an empty allowlist **fails closed** for
  browser origins. Non-browser callers without an `Origin` header still work.
- Credentialed CORS remains enabled.

## CSRF

`src/lib/csrf.js` exports `csrfProtection()`. Cookie-authenticated unsafe methods
require an `Origin` (or `Referer`) that is allowlisted or same-origin;
missing/foreign origins get `403`. Bearer-token requests are not ambient
credentials and bypass the check.

In production this middleware is mounted on assignments, examples, jobs,
preferences, templates, and admin routes. Admin and preference routes are also
unconditionally authenticated (they do not depend on `AUTH_REQUIRED=1`).

## Seed (idempotent)

```powershell
cd apps/api
node scripts/seed-multicollege.js                     # dry-run
node scripts/seed-multicollege.js --apply --confirm-db <exact-db>
# production writes additionally require:
$env:NODE_ENV = "production"; $env:ALLOW_PRODUCTION_DB_WRITE = "1"
```

The seed reads the existing TCET tenant template file, inserts only missing
college/department/template records with `$setOnInsert`, and never overwrites
administrator edits or deletes data. It never runs at API startup. With
`NODE_ENV=production`, `--apply` is refused unless
`ALLOW_PRODUCTION_DB_WRITE=1` is set for that command after reviewing the
dry-run.

## Migration

```powershell
cd apps/api
node scripts/migrate-multicollege.js                  # dry-run (default)
node scripts/migrate-multicollege.js --apply --confirm-db <exact-db>
node scripts/migrate-multicollege.js --rollback <runId> --confirm-db <exact-db>          # dry-run
node scripts/migrate-multicollege.js --rollback <runId> --confirm-db <exact-db> --apply
```

Safety properties:

- Dry-run by default; writes require both `--apply` and the exact connected
  database name via `--confirm-db`.
- With `NODE_ENV=production`, writes additionally require
  `ALLOW_PRODUCTION_DB_WRITE=1` for that command.
- Never runs during API startup.
- Never deletes assignments, templates, users or colleges.
- Idempotent: documents carrying the STAGE 1 migration version are skipped.
- Missing template scope is derived **only** from explicit `tenantId` /
  `ownerUserId`. Anything else becomes explicit `legacy` +
  `legacyUnscoped`/`needsReview`. No college id, branch id, owner or formatting
  data is invented.
- Assignments are not rewritten. Legacy assignments are normalized on read by
  `src/lib/documentModel.js`; the migration reports them as read-only.
- Users with missing/invalid roles become `user` (least privilege); no
  administrator scope is ever granted.

### Rollback limitations

- Restores only fields recorded in `migrationStage1.previous` for that run.
- Refuses to overwrite a document whose current values differ from what the
  run applied (e.g. an admin edited it afterwards); such documents are skipped.
- Cannot restore deleted documents, undo seed data, or reverse changes made by
  other tools.
- Never touches assignment content or template formatting.
- Run rollback before making further edits to migrated records.

Tests use isolated databases whose names contain the stage and `test`; the test
helpers fail closed otherwise. Do not run the CLIs against production as part
of a routine deploy; review the dry-run first.

## Document schema

`packages/shared/document.schema.json` is the canonical presentation document.
It snapshots template identity/layout and treats academic content as an opaque
object validated separately by `assignmentContentSchema` /
`packages/shared/assignment.schema.json`. Presentation-only fields are never
added to the Qwen/Pydantic generation contract.

`src/lib/documentModel.js` normalizes legacy records on read. Missing content,
template version or layout stays `null` with explicit `normalization` flags;
nothing is rewritten in MongoDB.

STAGE 5 added the editable flat block model in `src/lib/documentBlocks.js`.
Legacy assignments are projected into blocks on read without a write; saving a
document persists a revision-checked `document.blocks` body. STAGE 6 made HTML,
DOCX, and LaTeX consume the same resolved node list from
`src/render/renderModel.js`, with the assignment's pinned template version.

## Current persistence and access notes (post-STAGE 7)

- MongoDB is authoritative; process memory is a hot cache. Reads are
  owner-scoped, with legacy ownerless assignments visible for migration
  compatibility (documented residual risk).
- Production assignment mutations (generate, options, section regeneration,
  content, LaTeX save/clear, delete) return `503` instead of acknowledging a
  memory-only write. The document save is stricter: it requires a durable write
  in every environment and returns `503` without changing the saved document when
  Mongo is unavailable.
- Generated PDFs under `assets/generated/` are private; the public `/assets`
  mount rejects that directory and the authenticated assignment route streams
  the file.
- Preferences are self-asserted: any authenticated user may select any active
  college/branch. College-shared templates are not confidential from a user who
  selects that college. This is a documented residual risk, not a Stage 1
  guarantee.
