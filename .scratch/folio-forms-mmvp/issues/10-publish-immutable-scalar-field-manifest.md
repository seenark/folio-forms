# 10 — Publish an immutable scalar Field Manifest

**What to build:** Turn a valid Template Draft into one immutable Published Template, Field Manifest, and protected opaque share link for scalar Forms, making the server contract authoritative and preventing in-place republication.

**Blocked by:** 09 — Configure Fields from the ONLYOFFICE side panel

**Status:** done

- [x] Publish force-saves the Template Draft, hashes and versions the exact DOCX, and atomically binds that Published Template identity to the Field Manifest, required rules, and Prefill Configuration.
- [x] The Field Manifest records every supported scalar control tag, type, dropdown/combo options, required state, and Prefill policy.
- [x] Publish rejects no usable Fields, blank or duplicate tags, malformed controls/options, unknown types, invalid Prefill policies, Group, Repeating Section, and Building Block Gallery controls.
- [x] The published object and structural/policy contract cannot be edited or replaced through save or publish requests.
- [x] The Form receives one opaque generated public ID; custom slugs and raw database IDs are not accepted on public routes.
- [x] Unauthenticated access to the share path reveals only generic login, while an authenticated User can receive the permitted Form metadata.
- [x] A failed publish leaves the Template Draft editable and does not expose a shareable Published Form.
- [x] The Admin Form list immediately reflects successful publication while preserving useful Draft/Submission counts.
- [x] Publish and share-link states use Thai copy, semantic labelled controls, keyboard access, managed focus, and clear validation/success feedback.
- [x] Controlled DOCX fixtures prove text, checkbox, date, dropdown, combo, JSON Pointer tags, options, duplicates, malformed packages, and unsupported controls through the HTTP publish seam.
- [x] Publication and failed publication append content-safe Audit Events.
- [x] Form-lifecycle and supported-Field guidance documents immutable publication, share-link privacy, scalar constraints, and the prohibition on in-place structural change.
