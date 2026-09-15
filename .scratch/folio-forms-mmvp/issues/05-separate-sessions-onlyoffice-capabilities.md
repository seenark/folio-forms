# 05 — Separate Sessions from ONLYOFFICE capabilities

**What to build:** Keep the authenticated editor journey working while replacing browser-token forwarding with short-lived action-scoped capabilities and an independent ONLYOFFICE JWT/document/callback trust boundary.

**Blocked by:** 03 — Store Template and Response Documents in private RustFS; 04 — Secure bootstrap and browser Sessions

**Status:** ready-for-human

- [x] Editor and plugin configuration contains no Better Auth bearer token or browser-storage fallback.
- [x] Each editor capability is short-lived and bound to the authenticated actor, role, Form, document target, and permitted action.
- [x] A capability for one target or action cannot open, save, publish, submit, or export another target or action.
- [x] ONLYOFFICE Document Server JWT is enabled and validated independently from browser Sessions.
- [x] Private document access and callbacks reject altered signatures, wrong keys, wrong Operations, expiry, redirects, disallowed origins, and oversized payloads.
- [x] Plugin-to-parent and parent-to-plugin messages validate the expected window source and exact configured origin rather than using wildcard trust.
- [x] The existing Admin edit and User save/submit editor flow still completes with valid credentials.
- [x] Targeted HTTP and plugin-contract tests cover valid use, cross-target use, tampering, expiry, and origin rejection.
- [x] Plugin-boundary tests exercise action requests, Operation polling, duplicate-action suppression, valid messages, and strict source/origin rejection without a real browser Session token.

## Agent proof

- `bun test --timeout 120000 apps/server/test/http.test.ts` passed against isolated PostgreSQL and RustFS: 1 journey, 191 assertions. It covers five-minute actor/role/Form/document/action capabilities, six-minute Operation capabilities, cross-action/target/Operation rejection, signature tampering, expiry, live disabled/role-changed actors, private document access, standard timed ONLYOFFICE callback header/body JWTs, callback scope/replay/process guards, origin/redirect/size controls, callback-less timeout cleanup, Admin Save→new key→Publish, and User Save→Submit.
- `bun test apps/onlyoffice-plugin/plugin.test.js` passed: 4 tests, 26 assertions. The VM contract proves JIT capability requests, exact source/origin/bridge/request/action correlation, no browser credential fallback, Operation-capability polling, duplicate suppression, and safe timeout/error/malformed-response behavior.
- A real Document Server rejected an unsigned command and accepted a correctly signed command. Its captured callback shape exposed the signed body-token/header-payload distinction; the compatibility fix was retained as a real-shaped HTTP regression.
- `agent-browser` drove the live Docker Document Server through Admin Save Template→key rotation→editor remount→Publish and User Save Draft→Submit→receipt. Network evidence showed a fresh authenticated editor-config GET immediately before every capability-only action POST, followed by capability-only Operation polling; Document Server logs contained no callback error after the fix.
- Targeted Ultracite checks, server/web/environment type checks, the production workspace build, and `docker compose --env-file apps/server/.env.example -f compose.yaml config --quiet` passed.
- Final correctness and security reviews reported no findings. Ticket 06 retains ownership of durable cross-process callback replay claims/leases; Ticket 24 retains proxy, TLS, and private-network deployment controls.
- Removed both disposable PostgreSQL databases and private RustFS buckets and stopped the ticket-specific API, web, and browser processes.
