# 02 — Cut the existing workflow over to Prisma

**What to build:** Replace the prototype Drizzle persistence path with one clean Prisma/PostgreSQL baseline while keeping the currently working authenticated Form, Draft, Operation, and Submission journey demonstrable on an empty database.

**Blocked by:** 01 — Prefactor the server behind one HTTP test seam

**Status:** ready-for-human

- [x] A fresh PostgreSQL database reaches the accepted baseline through Prisma migration commands only.
- [x] Better Auth uses its Prisma adapter and live opaque Sessions continue to authenticate the existing HTTP workflow.
- [x] The initial Prisma model covers the accepted account/Session, Form/template/manifest, Response/Draft/Submission/Correction, Handoff, Operation/lease, Audit, and deletion-tombstone state with its lifecycle, uniqueness, ownership, and immutable-reference constraints.
- [x] The existing Admin create/publish and User start/save/submit/read flow passes through the black-box HTTP seam after cutover.
- [x] Prototype data is intentionally not migrated or preserved.
- [x] Drizzle runtime dependencies, schema, migrations, client, adapter usage, and migration commands are removed after every caller moves.
- [x] Production startup no longer runs a demo seed or creates demo accounts.
- [x] Setup and migration guidance uses only Prisma, and obsolete Drizzle, prototype migration, demo-account, and demo-seed instructions are removed.

## Agent proof

- Applied `20260914145344_initial` to fresh PostgreSQL database `folio_forms_ticket02_test2`, then reran `prisma migrate deploy`; the second run reported no pending migrations.
- `DATABASE_URL=... NODE_ENV=test BETTER_AUTH_SECRET=... bun run --cwd apps/server test:http`: 1 test passed with 39 assertions, covering Admin create/publish and User start/save/submit/JSON/DOCX/PDF read through `createApp().handle`.
- `bun run check-types && bun run build`: all workspace typecheck and production build tasks passed.
- `bun x ultracite check` passed on all changed TypeScript and package manifests.
- Started `apps/server/dist/index.mjs` against the Prisma database and observed `GET /health` return `{"ok":true}`.
