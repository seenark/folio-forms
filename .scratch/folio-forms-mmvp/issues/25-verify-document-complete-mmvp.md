# 25 — Verify and document the complete MMVP

**What to build:** Prove the accepted product as one real desktop journey through the production-like stack and replace contradictory prototype guidance so an Operator and future implementation agent see one truthful system.

**Blocked by:** 15 — Protect Draft work across export, discard, and Session expiry; 16 — Carry Picture Fields through the complete Response journey; 23 — Explore the complete immutable Audit trail; 24 — Run the MMVP on the private single-host stack

**Status:** ready-for-human

- [x] The real canonical Compose stack reaches ready state with real PostgreSQL, RustFS, and ONLYOFFICE rather than permanent test fakes.
- [x] Browser automation completes Admin bootstrap/login, User/Admin provisioning, uploaded DOCX Template Draft creation, side-panel Field configuration, immutable publish, and protected share-link behavior in Thai UI.
- [x] The external mock creates a Handoff; the intended User completes forced password change when applicable, receives editable/locked Prefill, inserts a native Picture, saves, exits, and resumes the exact Draft.
- [x] The User uses Save & Export, observes unsaved/Session protection, submits, opens the Receipt, downloads original DOCX/PDF, and returns through the allowlisted action.
- [x] An Admin audits read-only access, records a Correction, and the User can inspect history and download original versus latest with the expected document/data differences.
- [x] A second User is denied access to the first User's Response, Operation, Receipt, exports, and document capabilities.
- [x] Account disable revokes the live Session, Response deletion removes personal state/objects, external polling reports `deleted`, and Audit retains only safe events/tombstone.
- [x] A restart during the smoke releases stale ephemeral state without losing committed domain state, including Correction revisions.
- [x] Targeted Bun HTTP/plugin tests, type checking, Ultracite checks, and production builds pass after the real runtime scenario without adding a permanent browser-test framework.
- [x] Setup, environment, local/deployment operation, bootstrap, external mock, Form lifecycle, supported Fields, Handoff/status, deletion, and no-backup guidance match the implementation.
- [x] Obsolete Drizzle, local-storage artifact, mutable publish, demo credential/seed, retained-PDF, and insecure Compose instructions are removed rather than documented as an alternate mode.
- [x] Verification leaves no stray process, disposable database/bucket data, throwaway fixture output, debug logging, or generated export; the permanent HTTP/plugin seams and deterministic ONLYOFFICE fake remain committed.

## Runtime verification

- Ran the task-owned Compose stack with real PostgreSQL, RustFS, ONLYOFFICE, Caddy, and the Prefill mock.
- Created a new User through the Thai UI, completed the forced password change, redeemed a real external Prefill Handoff, and confirmed editable `full_name` plus locked `city` Prefill.
- In the follow-up production-native run, authored a native ONLYOFFICE fixed Picture control, let the response editor load as DOCXF, opened its built-in Picture menu, selected `Image from File`, and uploaded a different image (`PRODUCTION USER`).
- Saved the Draft through the Form tab, exited, resumed the same Response, and visually confirmed the uploaded image remained; the resumed editor still reported DOCXF and native OForm filling mode.
- Downloaded the persisted Draft DOCX from RustFS and inspected the OOXML package: `word/media/image1.png` was present, `word/_rels/document.xml.rels` pointed to it, and `word/document.xml` contained the `photo` Picture control with embedded image relationships.
- After the runtime scenario, `bun x ultracite check`, `bun run check-types`, and `bun run build` passed; task-owned containers and disposable storage are removed before delivery.
