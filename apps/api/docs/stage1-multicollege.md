# STAGE 1 — multi-college data model, access rules and safe tooling

This stage adds the data/security foundation only. It does **not** add the
admin UI, preferences UI, visual document editor or renderer redesign.

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

### Catalogue visibility in STAGE 1

`GET /api/v1/templates` and `GET /api/v1/templates/:id` already enforce the
two rules that do not depend on the preferences UI:

- `private` templates are visible only to their owner (never to admins);
- `legacy` templates are visible only to platform admins.

Shared `platform`/`college` catalogue filtering is implemented and tested in
`templateAccess.js` (`canViewTemplate`, `filterVisibleTemplates`), but the HTTP
catalogue still lists those templates broadly. Wiring that filter to the route
needs the STAGE 2 preferences UI so an ordinary user has an explicit
college/branch scope. Until then the route must not be treated as a complete
tenant-isolated catalogue.

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

## CORS

`ALLOWED_ORIGINS` is a comma-separated browser-origin allowlist.

- Outside production an empty allowlist keeps the historical permissive
  behaviour (local development/tests).
- In production (`NODE_ENV=production`) an empty allowlist **fails closed** for
  browser origins. Non-browser callers without an `Origin` header still work.
- Credentialed CORS remains enabled.

## CSRF

`src/lib/csrf.js` exports `csrfProtection()`. It is intentionally not mounted on
legacy routes in STAGE 1, but every future admin mutation route must use it.
Cookie-authenticated unsafe methods require an `Origin` (or `Referer`) that is
allowlisted or same-origin; missing/foreign origins get `403`. Bearer-token
requests are not ambient credentials and bypass the check.

## Seed (idempotent)

```powershell
cd apps/api
node scripts/seed-multicollege.js                     # dry-run
node scripts/seed-multicollege.js --apply --confirm-db <exact-db>
```

The seed reads the existing TCET tenant template file, inserts only missing
college/department/template records with `$setOnInsert`, and never overwrites
administrator edits or deletes data. It never runs at API startup.

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

Tests use isolated databases whose names contain `stage1` and `test`; the test
helpers fail closed otherwise. Do not run the CLIs against production as part
of STAGE 1.

## Document schema

`packages/shared/document.schema.json` is the canonical presentation document.
It snapshots template identity/layout and treats academic content as an opaque
object validated separately by `assignmentContentSchema` /
`packages/shared/assignment.schema.json`. Presentation-only fields are never
added to the Qwen/Pydantic generation contract.

`src/lib/documentModel.js` normalizes legacy records on read. Missing content,
template version or layout stays `null` with explicit `normalization` flags;
nothing is rewritten in MongoDB.
