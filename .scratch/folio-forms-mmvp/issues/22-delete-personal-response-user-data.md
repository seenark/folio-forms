# 22 — Delete personal Response and User data safely

**What to build:** Deliver complete Admin-controlled personal-data erasure across database and RustFS while retaining only a content-free Deletion Tombstone and privacy-safe external `deleted` status.

**Blocked by:** 07 — Administer accounts with attributable Audit Events; 19 — Poll external status and return safely; 21 — Record append-only Corrections and revision exports

**Status:** ready-for-human

- [x] An Admin can request permanent deletion of a Draft or submitted Response through a deliberate confirmed action.
- [x] Successful deletion removes Response scalar data, Response Documents, Prefill, Submission, Corrections, relevant personal Operation/lease state, and every related RustFS object.
- [x] The deletion path is retry-safe across database/object-store interruption and never reports success while a referenced personal object remains.
- [x] Only a Deletion Tombstone with safe target reference, actor, time, and outcome remains; it contains no identity, Field value, Prefill, document, credential, secret, or raw External Reference.
- [x] The trusted backend can subsequently receive `deleted` through a non-reversible External Reference lookup digest without receiving personal data.
- [x] Disabling a User continues to preserve their data, while hard deletion is rejected until no attributable personal Response data remains or an explicit anonymization has removed it.
- [x] The final enabled Admin cannot be deleted through the account-erasure path.
- [x] Deleted Users and Response owners lose active Sessions immediately, and stale editor/document capabilities can no longer read removed content.
- [x] Deletion attempts and outcomes append immutable safe Audit Events separate from the retained tombstone.
- [x] Response and account deletion use explicit Thai confirmation, semantic labelled controls, keyboard access, managed focus, and clear pending/failure/success states.
- [x] Black-box tests inject database and RustFS failures, retry deletion, inspect status/tombstone shape, and prove removed artifacts and authorization are gone.
- [x] Deletion guidance documents full Response erasure, account-deletion prerequisites, the content-free tombstone, privacy-safe `deleted` status, and the distinction from disable.
