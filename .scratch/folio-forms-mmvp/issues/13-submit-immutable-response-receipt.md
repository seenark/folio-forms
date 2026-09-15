# 13 — Submit an immutable Response and open its Receipt

**What to build:** Complete the scalar User journey by enforcing required rules, producing one immutable original Submission, and exposing a private Thai Receipt with reproducible JSON, DOCX, and transient PDF exports.

**Blocked by:** 12 — Start, save, and resume one scalar Draft

**Status:** ready-for-human

- [x] Submit requires non-empty text/combo, `true` checkbox, valid calendar date, declared dropdown value, and all other frozen Field Manifest rules.
- [x] Submit force-saves current editor state and returns a tracked Operation; the Response becomes submitted only after canonical JSON and DOCX are durable.
- [x] A failed or timed-out Submit returns the Response to its prior stable Draft state and can be retried.
- [x] The original Submission data and DOCX cannot be edited, overwritten, or deleted through Draft/save endpoints.
- [x] Repeat start or Handoff-independent access for the same submitted User/Form opens the existing Receipt rather than creating another Response.
- [x] The accessible Thai Receipt and My Responses view show Form title, submitted state, completion time, original data, and Receipt destination without exposing another User's identity or content.
- [x] The owner and an Admin can download original JSON/DOCX and generate PDF with safe server-generated filenames and correct content types; an unrelated User receives a denial.
- [x] Generated PDF bytes correspond to the canonical DOCX and are not retained in PostgreSQL or RustFS after delivery.
- [x] HTTP tests cover each required rule, submission races, immutable original state, receipt authorization, content types, and transient PDF cleanup.
- [x] Response-lifecycle guidance documents immutable Submission, private Receipts, original exports, transient PDFs, and retry after failed Submit.
