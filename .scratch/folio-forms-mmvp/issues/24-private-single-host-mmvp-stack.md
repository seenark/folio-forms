# 24 — Run the MMVP on the private single-host stack

**What to build:** Make the accepted MMVP runnable on one Linux host through one canonical, pinned, secret-driven HTTPS Compose topology with only the web/API and ONLYOFFICE hosts public and with honest single-disk durability semantics.

**Blocked by:** 03 — Store Template and Response Documents in private RustFS; 05 — Separate Sessions from ONLYOFFICE capabilities; 06 — Make editing Operations and Editor Leases recoverable; 17 — Create and redeem one-time editable Prefill Handoffs

**Status:** ready-for-human

- [x] One canonical production Compose definition starts HTTPS reverse proxy, web/API, ONLYOFFICE 9.4.0.1, PostgreSQL, and RustFS with pinned images; the deterministic external mock is available only in an explicit development/verification profile.
- [x] Web/API is served at the configured forms host and ONLYOFFICE at the configured office host; PostgreSQL and RustFS expose no public reverse-proxy route or host port in production mode.
- [x] RustFS uses a private bucket with no public policy or wildcard CORS, and ONLYOFFICE JWT is enabled.
- [x] Database, auth, editor, Handoff, object-storage, and bootstrap credentials are independent injected secrets with no committed or default production value.
- [x] Prisma deployment migration completes before the application serves traffic, create-only Admin bootstrap follows it, and no demo seed runs.
- [x] Liveness remains shallow; readiness fails until required PostgreSQL/RustFS connectivity and editor configuration preparation are available.
- [x] Restart reconciliation expires stale Handoffs, pending claims, Editor Leases, and Operations and removes only unreferenced staging objects.
- [x] A service restart preserves committed Template Drafts, Published Templates, Drafts, Submissions, Prefill, and Audit Events.
- [x] The topology adds no queue, distributed lock, horizontal scaling, or high-availability machinery beyond the 100-account/100-Form/about-20-editor ceiling.
- [x] Operational logs and safe diagnostic detail are English, and startup/operator output states clearly that no application/off-host backup exists and disk, ransomware, or regional loss is unrecoverable.
- [x] A Compose smoke verifies network exposure, readiness ordering, JWT/private storage settings, secret absence from source, and restart behavior.
- [x] Deployment guidance documents the canonical hosts, injected secrets, private services, migration/bootstrap order, readiness, restart recovery, optional verification mock, operating ceiling, and no-backup risk.
