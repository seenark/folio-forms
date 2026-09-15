# 18 — Enforce immutable Prefill locks and stable re-entry

**What to build:** Complete Prefill authority semantics: available trusted values can be locked, missing values stay editable, the server rejects tampering, and later launches always preserve the first immutable Prefill and single Response.

**Blocked by:** 17 — Create and redeem one-time editable Prefill Handoffs

**Status:** ready-for-human

- [x] A configured key absent from the Handoff creates no Prefill entry and leaves its Field editable even under `lock-when-available` policy.
- [x] An available `lock-when-available` value is applied by the plugin and its content remains non-editable in the User editor.
- [x] Save Draft and Submit reassert every locked Prefill value from the immutable snapshot and reject or overwrite client tampering before it becomes authoritative.
- [x] Editable Prefill values may be changed by the User and follow normal Field validation.
- [x] Resume always uses the original Prefill snapshot even when the external mock later returns different values.
- [x] A new Handoff for a User/Form with an existing Draft opens that unchanged Draft and does not replace Prefill or External Reference.
- [x] A new Handoff after Submission opens the existing Receipt and cannot create a second Response.
- [x] A missing external record or omitted configured key creates no Prefill entry and lets the User continue with editable Fields; an unavailable source or malformed value shows an accessible Thai retry/return state and never partially updates a Response.
- [x] Plugin and HTTP tests prove lock application, missing-value behavior, tamper defense, immutable resume, and concurrent re-entry.
