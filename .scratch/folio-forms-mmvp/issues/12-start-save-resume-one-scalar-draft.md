# 12 — Start, save, and resume one scalar Draft

**What to build:** Deliver the first complete User tracer bullet for a non-Prefill scalar Form: authenticated start, restricted editing, explicit durable save, My Responses listing, and exact resume of the one allowed Draft.

**Blocked by:** 10 — Publish an immutable scalar Field Manifest

**Status:** ready-for-human

- [x] An authenticated User can start a published Form without Prefill Configuration; unauthenticated and disabled accounts cannot.
- [x] The database and API enforce at most one Response for the User/Form under concurrent starts.
- [x] A User editor can modify only tagged Fields; static text and images remain non-editable under ONLYOFFICE forms restrictions.
- [x] Text, checkbox, date, dropdown, and combo values use the Field Manifest's scalar semantics and exact tags in flat JSON.
- [x] Save Draft permits missing required Fields but rejects unknown tags, invalid types/options/dates, over-10,000-character text, aggregate JSON over 256 KiB, and changed control inventory.
- [x] Save Draft creates a tracked Operation; completion atomically advances the canonical Draft data/DOCX, while failure preserves the last stable version and leaves the same Draft retryable.
- [x] My Responses lists only the current User's Draft with Form title, Draft state, last-saved timestamp, and resume destination; reopening restores the exact last completed save under an Editor Lease.
- [x] A second User cannot read the Response, Operation, editor configuration, data, or document even with guessed identifiers.
- [x] Black-box tests cover concurrent start, every scalar boundary, incomplete save, stable resume, operation failure, and ownership denial.
- [x] Plugin-contract tests prove visible values and messages for text line breaks, booleans, dates, dropdowns, and combo custom text through save and resume.
- [x] All new User surfaces and expected error states are Thai and desktop-accessible.
- [x] User-lifecycle guidance documents authenticated start, one Response per User/Form, explicit Draft save, resume, Field limits, and ownership boundaries.
