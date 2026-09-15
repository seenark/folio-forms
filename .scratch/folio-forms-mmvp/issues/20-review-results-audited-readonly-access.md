# 20 — Review Results with audited read-only access

**What to build:** Give Admins a focused Thai Results workflow for finding individual Drafts or Submissions, inspecting them with the correct mutability boundary, and exporting only authorized submitted revisions with attributable access.

**Blocked by:** 07 — Administer accounts with attributable Audit Events; 13 — Submit an immutable Response and open its Receipt

**Status:** ready-for-human

- [x] An Admin can open Results from a Form; the table is cursor-paginated and searchable/filterable by Form, User, Response state, relevant timestamps, and latest Correction number.
- [x] An Admin can open any Draft read-only but cannot edit, acquire an editing lease, or export it from the Admin workflow.
- [x] Every Admin Draft or Submission view appends an Audit Event with actor, target, time, and outcome and no Field values or document content.
- [x] An Admin can inspect a Submission's original data and document metadata without gaining a mutable editor.
- [x] An Admin can export individual original/latest JSON, DOCX, or on-demand PDF; each export is ownership-authorized and audited.
- [x] The User owner keeps access to their own Receipt and exports, while another User remains denied.
- [x] Bulk export, aggregate analytics, charts, and cross-Response analysis are absent.
- [x] Thai UI exposes clear Draft versus Submission state, read-only boundaries, loading, errors, and empty results accessibly.
- [x] Black-box tests cover filters/pagination, Admin/User authorization, Draft no-export, Submission export content, and audit side effects.
