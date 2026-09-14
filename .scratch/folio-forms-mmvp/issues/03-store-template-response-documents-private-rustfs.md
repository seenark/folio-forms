# 03 — Store Template and Response Documents in private RustFS

**What to build:** Move durable Template and Response Documents from host files to a server-mediated private RustFS bucket, preserving the existing document journey while making DOCX authoritative and PDF generation transient.

**Blocked by:** 02 — Cut the existing workflow over to Prisma

**Status:** ready-for-human

- [x] Template Draft, Published Template, Draft, original Submission, and staged Operation DOCX objects are written to a non-public RustFS bucket.
- [x] Browsers and ONLYOFFICE can read an object only through short-lived server authorization; no public bucket URL authorizes access.
- [x] A successful write advances the database reference only after the new object is durable.
- [x] A failed object write or database transition leaves the prior stable document readable and removes unreferenced staging objects.
- [x] DOCX downloads remain ownership-checked and return the expected document bytes and content type.
- [x] PDF is rendered on demand and no generated PDF object or database path remains after the response completes.
- [x] A real RustFS integration test covers put, stream, existence, replacement cleanup, and deletion behavior.
- [x] The shared black-box HTTP harness runs against an isolated real PostgreSQL database and private disposable RustFS bucket, with only ONLYOFFICE behavior faked.
- [x] The runtime no longer depends on a host artifact directory for canonical documents.
- [x] Environment and storage guidance documents private RustFS and transient PDF behavior and removes host-artifact and retained-PDF instructions.

## Agent proof

- Started pinned `rustfs/rustfs:1.0.0-rc.6` and `rustfs/rc:v0.1.35` services; RustFS reported healthy and idempotent bucket initialization exited successfully.
- Applied the checked-in Prisma migration to isolated database `folio_forms_ticket03` and created private disposable bucket `folio-forms-ticket03`.
- `bun run --cwd apps/server test:storage`: 1 test passed with 14 assertions against real RustFS, covering exact put/read/stream bytes, private unsigned access rejection, existence, replacement cleanup, and idempotent deletion.
- `bun run --cwd apps/server test:http`: 1 test passed with 49 assertions against the isolated PostgreSQL database and RustFS bucket, with only ONLYOFFICE faked; it covered Admin publish, User start/save/submit, ownership denial, exact DOCX bytes/content type, transient PDF, and stale Operation object cleanup while preserving the canonical document.
- `bun run check-types && bun run build`, targeted `bun x ultracite check`, and `docker compose -f compose.yaml config --quiet` passed.
- Started `apps/server/dist/index.mjs` against PostgreSQL and RustFS and observed `GET /health` return `{"ok":true}`.
- Removed the disposable RustFS bucket with `rc bucket remove --force`; its deletion inventory contained only referenced Template/Submission objects and no orphaned Operation or Draft objects.
- Final reviewer verdict: no findings.
