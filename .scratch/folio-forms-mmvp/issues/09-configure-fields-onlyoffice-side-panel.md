# 09 — Configure Fields from the ONLYOFFICE side panel

**What to build:** Add the Admin right-side design surface inside ONLYOFFICE for inspecting a Field, discovering scalar external keys, and saving exact tag, required, and Prefill policy without a separate mapping builder.

**Blocked by:** 08 — Create and save leased Template Drafts

**Status:** ready-for-human

- [x] The side panel is available only in an authorized Admin Template Draft editor and reflects the selected content control.
- [x] The deterministic external mock exposes a searchable cursor-paginated schema large enough to prove paging and filtering.
- [x] Search results contain RFC 6901 JSON Pointer keys for nested scalar leaves and exclude objects as values and every array path.
- [x] Copy writes the exact selected pointer, and the Admin can paste that exact value into the selected content-control tag.
- [x] The Admin can save required state and either `editable` or `lock-when-available` Prefill policy for the exact Field tag.
- [x] The panel does not expose User records, record values, a mapping canvas, or multiple connector choices.
- [x] Configuration survives Template Draft save/reopen and tag changes cannot silently leave conflicting policy behind.
- [x] Plugin-contract tests cover selection, query pagination, Copy, policy persistence, missing selection, API failure, and strict message origin handling.
- [x] All visible panel copy and accessible labels are Thai and keyboard-operable.
- [x] External-mock and Field-authoring guidance documents schema paging, JSON Pointer tags, supported scalar controls, and Prefill policies without describing a mapping builder.

Implementation:

- Added configure-fields capability-scoped schema and Field Rule APIs with signed cursors, RFC 6901 scalar flattening, active lease checks, conflict-safe updates, and immutable form audit events.
- Added the Thai right-side ONLYOFFICE panel for selection state, schema filtering/paging, exact pointer copy/apply, required state, and Prefill policy persistence.
- Added strict parent/plugin bridge validation, fresh capability requests, no-value field-selection messages, and web routing for the new message type.

Verification:

- `bun run check-types`
- `bun run --cwd apps/server check-types`
- `bun run --cwd apps/server test:http` against isolated `folio_ticket09_test` PostgreSQL
- `bun test apps/onlyoffice-plugin/plugin.test.js` — 10 passed, 56 assertions
- Browser smoke: live Admin editor panel, selected `full_name` control, schema search, exact pointer Copy verified through both Clipboard API and synchronous fallback, pointer apply, required + `lock-when-available` save, Template Draft save, and reopen persistence.
