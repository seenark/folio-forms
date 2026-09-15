# 21 — Record append-only Corrections and revision exports

**What to build:** Let an Admin correct the latest effective Submission through ONLYOFFICE without altering the User's original, producing attributable immutable revisions that Users can inspect and export as original or latest.

**Blocked by:** 06 — Make editing Operations and Editor Leases recoverable; 14 — Archive Forms without stranding existing Drafts; 16 — Carry Picture Fields through the complete Response journey; 18 — Enforce immutable Prefill locks and stable re-entry; 19 — Poll external status and return safely; 20 — Review Results with audited read-only access

**Status:** ready-for-human

- [x] An Admin opens only the latest effective Response Document in Correction mode under a Correction-specific capability and exclusive Editor Lease.
- [x] Correction mode permits Field edits but not static document edits and enforces the frozen Field Manifest, required rules, options, limits, Picture rules, and locked Prefill values.
- [x] Save requires a non-empty reason and creates the next monotonic revision atomically with changed data, complete effective data, canonical DOCX, actor, and time.
- [x] A completed Correction becomes effective atomically and survives service restart without User approval; a failed Operation leaves the prior latest revision effective.
- [x] The original Submission data and DOCX remain byte-for-byte referenced and cannot be overwritten by Correction work.
- [x] The User and Admin can inspect original data, latest effective data, and Correction actor/time/reason/history for active or archived Forms, while export modes remain only `original` or `latest`.
- [x] My Responses, Admin Results, and external status show the latest Correction number and lead authorized application users to revision history.
- [x] Original/latest JSON and DOCX use safe server-generated filenames and correct content types for authoritative revisions, and each PDF is generated transiently from the selected canonical DOCX.
- [x] Competing Admins cannot edit the same Correction target, and callback replay cannot create duplicate revision numbers.
- [x] Correction create/fail/view/export behavior appends safe Audit Events without Field values, reasons containing secrets, or document content in logs.
- [x] HTTP, plugin, and controlled DOCX tests cover scalar/Picture corrections, revision races, validation failure, immutable original, and export selection.
- [x] Every Correction and revision-history surface uses Thai copy, semantic controls, keyboard access, managed focus, labels, and clear loading/error/success states.
