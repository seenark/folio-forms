# 01 — Prefactor the server behind one HTTP test seam

**What to build:** Preserve the current Folio workflow while making the complete HTTP application runnable without binding a production port. This prefactor creates the one high-level seam every later ticket uses and keeps ONLYOFFICE network behavior controllable in deterministic tests.

**Blocked by:** None — can start immediately

**Status:** ready-for-human

- [x] The production command still starts the Elysia server and its existing health endpoint succeeds.
- [x] The same application can handle Requests in-process without opening a listening socket.
- [x] A Bun black-box test exercises an existing authenticated Form workflow through HTTP rather than calling route helpers directly.
- [x] ONLYOFFICE command, callback-document, and converter traffic can target a deterministic local fake without production-only branches.
- [x] The fake can deterministically emit signed success, explicit failure, timeout, duplicate, malformed, and replay scenarios for later HTTP tests.
- [x] Handled API failures consistently expose an HTTP status, stable English machine code, and safe message; browser behavior keys off the code, and tests assert status/code/state rather than message wording.
- [x] Server composition keeps identity, Forms, Responses, Prefill integration, storage, ONLYOFFICE, Operations/leases, and audit responsibilities out of the entrypoint and behind explicit module boundaries.
- [x] Existing route contracts and browser behavior remain unchanged by the prefactor.
- [x] No second application implementation or speculative service layer is introduced.

## Agent proof

- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/folio_forms_test bun run --cwd apps/server test:http` — 1 passing black-box test, 10 assertions.
- `bun run --cwd apps/server check-types` and `bun run --cwd apps/web check-types` — pass.
- `bun run --cwd apps/server build` and `bun run --cwd apps/web build` — pass.
- `bun x ultracite check` on all ticket files — pass.
- Production `dist/index.mjs` reached ready state and `GET /health` returned `{"ok":true}`.
- Deterministic fake smoke emitted callback counts `signed-success:1`, `explicit-failure:1`, `timeout:0`, `duplicate:2`, `malformed:1`, and `replay:2`.
