# 11 — Manage Published Forms without mutating their contract

**What to build:** Let an Admin maintain harmless Published Form metadata or create a structurally independent Duplicate while preserving the original share link, Published Template, Field Manifest, Responses, and history.

**Blocked by:** 10 — Publish an immutable scalar Field Manifest

**Status:** ready-for-human

- [x] An Admin can edit a published Form's title and description without changing its public ID, Published Template hash, Field Manifest, or Prefill Configuration.
- [x] An Admin can Duplicate a Draft or Published Form into a new editable Template Draft with a new opaque public ID.
- [x] Duplicate copies DOCX, title, description, required rules, and Prefill Configuration as independent new draft state.
- [x] Duplicate does not copy Responses, Submissions, Corrections, Operations, Editor Leases, or Audit Events as history of the new Form.
- [x] Editing or deleting the Duplicate cannot change the source Form's objects or metadata.
- [x] A Published Form cannot be hard-deleted or returned to draft state.
- [x] Metadata and Duplicate actions are Admin-only, appear in the Thai Form UI with semantic labelled controls and clear keyboard/focus/state behavior, and append safe Audit Events.
- [x] Acceptance tests compare source and Duplicate behavior without asserting internal field-copy implementation.
- [x] Form-lifecycle guidance documents mutable metadata, independent Duplicate behavior, preserved source history, and the prohibition on Published Form deletion or return to draft.
