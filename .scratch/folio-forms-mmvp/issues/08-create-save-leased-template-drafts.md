# 08 — Create and save leased Template Drafts

**What to build:** Let an Admin create, edit, save, list, and abandon a DOCX Template Draft through the secured ONLYOFFICE and RustFS path, with a complete blank/upload choice and exclusive editing.

**Blocked by:** 06 — Make editing Operations and Editor Leases recoverable; 07 — Administer accounts with attributable Audit Events

**Status:** ready-for-human

- [x] An Admin can create a Template Draft from a valid blank DOCX or uploaded `.docx` and then open it in ONLYOFFICE.
- [x] Uploads over 25 MiB, non-DOCX input, and malformed DOCX packages are rejected before a Form becomes usable.
- [x] The Template Draft is edited under one active Editor Lease and a second Admin is shown a non-editable blocked state.
- [x] Explicit Save creates an Operation and the last completed save is the exact DOCX reopened later from RustFS.
- [x] A failed save leaves the previous Template Draft intact and retryable.
- [x] The Admin Form list renders each Form's current lifecycle state and useful Draft/Submission counts without exposing raw object or database IDs.
- [x] An unpublished Form can be hard-deleted with its Template Draft objects; a non-Draft Form cannot use this delete path.
- [x] Create, save, and delete outcomes append safe Form Audit Events.
- [x] Form creation, list, lease-blocked, save, and delete states use Thai copy, semantic labelled controls, keyboard access, managed focus, and clear loading/error/success feedback.
- [x] HTTP acceptance tests cover blank/upload boundaries, lease conflict, durable reopen, failure rollback, and draft-only deletion.
- [x] Form-lifecycle guidance documents blank/upload creation, validation limits, exclusive editing, explicit save, counts, and Draft-only deletion.

## Agent implementation

- Added bounded blank/upload Form creation, strict namespace-aware UTF-8/UTF-16 DOCX package validation, private RustFS persistence, safe public Form DTOs, lifecycle counts, and Draft-only hard deletion.
- Added session-bound exclusive Template Draft leases, capability-scoped explicit save/publish Operations, exact saved-byte reopen, failure rollback, and public-only editor/plugin/Operation contracts.
- Added durable cleanup intents with in-flight protection and periodic retry so failed create/delete object cleanup survives process failure without racing live uploads.
- Added Thai create/list/editor/delete states with native upload controls, focus restoration, blocked/retry feedback, and an imperative ONLYOFFICE mount island that remounts safely after save.

## Agent verification

- Fresh isolated PostgreSQL migration and HTTP journey: 1 passed, 568 assertions, including 25 MiB boundaries, Strict OOXML, UTF-16LE/BE, declared XML/VML DTD rejection, lease/session conflicts, exact callback-byte reopen, cleanup recovery, rollback, audit, and deletion guards.
- ONLYOFFICE plugin suite: 5 passed, 29 assertions. Targeted Ultracite checks, server/web/database TypeScript checks, and production builds passed.
- Real Chromium/ONLYOFFICE proof created a blank Draft, rendered a second Admin's non-editable lease-blocked state, completed explicit Save and editor remount without console errors, handed the lease to the other Session after navigation, rendered Thai state/counts, and hard-deleted the eligible Draft. Screenshots: `/tmp/ticket08-owner-editor.png`, `/tmp/ticket08-peer-blocked.png`.
- Independent correctness and security re-reviews reported no surviving Ticket 08 findings.
