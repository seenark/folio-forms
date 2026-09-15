# 14 — Archive Forms without stranding existing Drafts

**What to build:** Give Admins reversible availability control over a Published Form while preserving its immutable contract and allowing Users who already started to finish their Drafts.

**Blocked by:** 11 — Manage Published Forms without mutating their contract; 13 — Submit an immutable Response and open its Receipt

**Status:** ready-for-human

- [x] An Admin can archive a Published Form and later unarchive it without changing its public ID, Published Template, Field Manifest, or Prefill Configuration.
- [x] An archived Form rejects every new Response start with a stable safe error.
- [x] A Draft created before archive can still reopen, save, and submit against its original Published Template.
- [x] Existing Submissions, Receipts, authorized original exports, and audit history remain readable while archived.
- [x] Unarchive permits new starts again on the same immutable contract and share link.
- [x] A User with no existing Response learns only that the Form is unavailable after authentication; no private metadata leaks before login.
- [x] Archive and unarchive are Admin-only and append Audit Events with actor, Form, time, and outcome.
- [x] The Admin Form list immediately reflects archive and unarchive transitions while preserving useful Draft/Submission counts.
- [x] Archive, unarchive, and unavailable states use Thai copy, semantic labelled controls, keyboard access, managed focus, and clear loading/error/success feedback.
- [x] Black-box tests cover archive races with start/submit and verify no Draft invalidation or document mutation.
- [x] Form-lifecycle guidance documents archive effects for new Response starts, existing Drafts, Receipts, exports, and unarchive.
