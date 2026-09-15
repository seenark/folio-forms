# 19 — Poll external status and return safely

**What to build:** Close the trusted external integration loop with privacy-preserving status polling by External Reference and one explicit safe Return action from Folio's Receipt.

**Blocked by:** 18 — Enforce immutable Prefill locks and stable re-entry

**Status:** ready-for-human

- [x] The trusted backend can poll by External Reference only with the configured shared secret.
- [x] The deterministic external mock exercises status polling through the same shared-secret connector boundary used for Handoff creation.
- [x] The status contract permits only `pending`, `draft`, `submitted`, `deleted`, or `expired`; this slice makes every non-deletion state observable with lifecycle timestamps and latest Correction number when available.
- [x] Status never returns User identity, Field values, Prefill, document/object URLs, Session information, or internal database IDs.
- [x] Unknown references and authentication failures do not reveal whether a User or Form exists.
- [x] An unredeemed Handoff becomes `expired` after its accepted lifetime and retains only the non-reversible lookup digest and timestamps needed for status; raw code, Prefill, identity, and document data are purged.
- [x] The Receipt shows one explicit keyboard-accessible Thai Return action to the deployment-configured allowlisted external URL.
- [x] Handoff input cannot supply or override the Return URL, and off-origin/open-redirect attempts are rejected.
- [x] No webhook, email, SMS, delivery queue, or inbound status callback is introduced.
- [x] Black-box tests cover every non-deletion state, the full response schema, privacy shape, secret failure, unknown reference, redirect allowlist, and expiry cleanup proof shows only the allowed digest/timestamps remain.
- [x] External-integration guidance documents status privacy and lifecycle, the later deletion transition, the allowlisted Return action, and the absence of push delivery.
