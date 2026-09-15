# 17 — Create and redeem one-time editable Prefill Handoffs

**What to build:** Deliver one complete editable-Prefill launch from the deterministic external backend to an authenticated User's first Response using a filtered, short-lived, single-use, email-bound server-to-server Handoff.

**Blocked by:** 04 — Secure bootstrap and browser Sessions; 10 — Publish an immutable scalar Field Manifest; 13 — Submit an immutable Response and open its Receipt; 14 — Archive Forms without stranding existing Drafts; 15 — Protect Draft work across export, discard, and Session expiry

**Status:** ready-for-human

- [x] One runnable deterministic external mock implements schema discovery, Handoff creation, and launch through the same narrow connector boundary.
- [x] Only the configured external backend can create a Handoff for an active Published Form using the deployment shared secret; invalid credentials and unavailable Forms use non-enumerating errors.
- [x] The request includes Form identity, normalized email, External Reference, and candidate scalar values; Folio retains only values allowed by the frozen Prefill Configuration.
- [x] Folio returns 32 cryptographically random bytes encoded as a one-time code, stores only its digest, and expires it after 120 seconds.
- [x] Launch accepts the code only in a top-level POST and exchanges it for a Secure, HttpOnly, SameSite=Lax `__Host-` pending-claim cookie valid for ten minutes.
- [x] The pending claim survives login and mandatory password change without placing code or Prefill values in a URL or browser storage.
- [x] Authenticated redemption atomically verifies email/Form/configuration binding, consumes the claim once, creates the unique Response, copies the Published Template, and stores an immutable editable Prefill plus External Reference.
- [x] A Form with Prefill Configuration rejects a new ordinary share-link start; Discard removes its immutable Prefill and requires a fresh Handoff, while a Form without Prefill Configuration keeps the normal authenticated start path.
- [x] Invalid, expired, replayed, malformed, email-mismatched, Form-mismatched, and configuration-mismatched Handoffs fail closed with an accessible Thai retryable return-to-source state.
- [x] Handoff success/failure Audit Events contain no values, code, secret, document, or identity beyond safe target references.
- [x] Black-box tests cover filtering, entropy/digest behavior, expiry, cookie attributes, login continuation, atomic races, replay, every binding mismatch, archived-Form rejection, post-Discard restart, and browser-storage/URL absence.
- [x] External-mock and Handoff guidance documents the shared-secret boundary, filtered values, lifetimes, POST launch, pending claim, email binding, single use, and safe retry.
