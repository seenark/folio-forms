# 16 — Carry Picture Fields through the complete Response journey

**What to build:** Extend the established Form and Response journey with native ONLYOFFICE Picture Fields while keeping image bytes inside canonical DOCX objects and enforcing the accepted format, count, size, dimension, and required rules.

**Blocked by:** 10 — Publish an immutable scalar Field Manifest; 13 — Submit an immutable Response and open its Receipt

**Status:** ready-for-human

- [x] The Admin side panel and publication parser recognize a tagged Picture control and include its type, required state, and limits in the Field Manifest.
- [x] A User selects a Picture through ONLYOFFICE's native control; no remote-Prefill image or separate upload workflow is added.
- [x] Only one JPEG or PNG up to 10 MiB and 4096×4096 pixels is accepted for each Picture Field.
- [x] Missing required Picture, unsupported format, multiple images, oversized bytes, and oversized dimensions fail before Submission becomes immutable.
- [x] Picture bytes are absent from scalar Response JSON and are not stored as independent image objects.
- [x] Save/resume preserves the embedded Picture in the canonical Draft DOCX, and Submission/authorized DOCX/PDF export preserves it in the rendered location.
- [x] Static non-Field images remain non-editable for Users.
- [x] Picture configuration, constraints, and validation failures are exposed in accessible Thai UI while native ONLYOFFICE image selection remains the only User input surface.
- [x] HTTP DOCX fixtures and plugin-contract tests cover presence/absence, format, count, size, dimensions, save/resume, and export behavior.
- [x] The final real-editor smoke can exercise native Picture insertion without test-only plugin behavior.
- [x] Supported-Field guidance documents Picture format, count, byte/dimension limits, required presence, embedded-DOCX authority, and the absence of separate image objects.
