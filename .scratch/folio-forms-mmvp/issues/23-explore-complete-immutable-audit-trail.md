# 23 — Explore the complete immutable Audit trail

**What to build:** Expose the complete accepted Audit Event record to Admins through a read-only Thai search/filter surface while proving every required security-sensitive action is attributable and no sensitive payload is duplicated into audit storage.

**Blocked by:** 07 — Administer accounts with attributable Audit Events; 11 — Manage Published Forms without mutating their contract; 14 — Archive Forms without stranding existing Drafts; 17 — Create and redeem one-time editable Prefill Handoffs; 20 — Review Results with audited read-only access; 21 — Record append-only Corrections and revision exports; 22 — Delete personal Response and User data safely

**Status:** ready-for-human

- [x] An Admin can cursor-page and filter Audit Events by time range, actor, action, target, and outcome.
- [x] Events cover account administration, Form create/save/publish/metadata/Duplicate/archive, Admin Draft/Submission views, Admin Submission exports, Corrections, Response deletion, and Prefill Handoff consumption/failure.
- [x] Audit Events and Deletion Tombstones are immutable and have no automatic expiry.
- [x] No event or rendered audit detail contains Field values, Prefill values, document content, passwords, temporary credentials, bearer/editor tokens, shared secrets, raw Handoff codes, or full request bodies.
- [x] Only Admin can access audit queries/UI; Users and unauthenticated callers receive a denial without metadata leakage.
- [x] The Thai Audit page makes action, actor, target, time, and outcome understandable and provides accessible loading, empty, filter, and error states.
- [x] Pagination and filters remain deterministic with at least the accepted operating ceiling's volume.
- [x] Black-box tests trigger each required event through its public contract, then assert observable audit metadata and absence of forbidden content rather than internal writer calls.
