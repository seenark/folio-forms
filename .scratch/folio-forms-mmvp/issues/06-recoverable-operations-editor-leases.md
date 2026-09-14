# 06 — Make editing Operations and Editor Leases recoverable

**What to build:** Prevent competing editors and make asynchronous saves safe across failure or restart by persisting exclusive Editor Leases, callback claims, and Operation transitions instead of relying on process memory.

**Blocked by:** 05 — Separate Sessions from ONLYOFFICE capabilities

**Status:** ready-for-human

- [x] A Template Draft or Response target can have at most one unexpired Editor Lease, claimed atomically by one browser Session.
- [x] The holder can renew and release its lease, and an abandoned lease becomes claimable only after expiry.
- [x] A competing editor cannot receive editable configuration or mutate the target while the lease is active.
- [x] Every mutating editor request requires a capability bound to the active lease and actor, and each callback can affect only its exact Operation.
- [x] At most one active Operation exists per target; it persists action, target, actor/owner, `pending → processing → completed | failed` status, timestamps, safe English error code, and result reference for authorized polling.
- [x] Callback authorization and single-use consumption are durable, so duplicate or replayed callbacks cannot complete an Operation twice.
- [x] Timeout, force-save failure, callback failure, and conversion failure preserve the previous stable Template Draft or Response state.
- [x] Startup reconciliation expires stale Operations and leases without changing committed documents or data.
- [x] Black-box concurrency and restart scenarios prove lease exclusion, replay rejection, rollback, and owner/Admin Operation visibility.

## Agent implementation

- Added atomic, Session-bound editor leases with renewal/release endpoints and a 90-second expiry.
- Bound action capabilities to the active lease generation and separated operation-scoped polling trust.
- Persisted exact callback claims and consume them atomically once, making callback authorization restart-safe and replay-safe.
- Serialized operation creation with lease ownership and the per-target active-operation invariant.
- Added stable failure codes, rollback-safe storage promotion, and stale-state reconciliation at startup and on later target access.
- Added the web lease heartbeat and generation-safe adoption when a live editor reacquires an expired lease.
- Extended the HTTP journey with competing-session, concurrent-request, tampering, replay, stale-restart, and failure-preservation scenarios.

## Agent verification

- `apps/server/test/http.test.ts`: 1 journey, 270 assertions, 0 failures against isolated PostgreSQL and RustFS.
- `onlyoffice-plugin/test/plugin.test.ts`: 4 tests, 0 failures.
- `apps/server` and `apps/web` TypeScript checks: passed.
- Targeted Ultracite checks and `apps/server` build: passed.
- Security review: no remaining lease/auth finding.
- Correctness review: no remaining finding; confidence 0.98.
