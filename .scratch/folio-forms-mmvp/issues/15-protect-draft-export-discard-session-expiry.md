# 15 — Protect Draft work across export, discard, and Session expiry

**What to build:** Make explicit Draft ownership understandable and safe by warning about unsaved editor state, force-saving before export, supporting deliberate Discard, and returning through reauthentication without putting values in browser storage.

**Blocked by:** 04 — Secure bootstrap and browser Sessions; 13 — Submit an immutable Response and open its Receipt; 14 — Archive Forms without stranding existing Drafts

**Status:** ready-for-human

- [x] The secured plugin bridge marks the editor dirty after a Field change and clears dirty state only after successful save, submit, or deliberate Discard.
- [x] Route changes, browser close/reload, logout, and Session-expiry actions warn while unsaved changes exist.
- [x] Save & Export completes the current Save Draft Operation before streaming DOCX or on-demand PDF from that saved version, including for a Draft whose Form is archived.
- [x] Owner-only Discard requires deliberate confirmation and removes Draft data, the Response Document, active lease, and unneeded staged objects.
- [x] After Discard, My Responses no longer lists the Draft, and starting again follows the current Form availability and access rules.
- [x] The UI warns five minutes before absolute Session expiry and offers save before reauthentication.
- [x] After reauthentication, a safe same-origin return path opens the same saved Response without putting Field values, Prefill, or claims in URL/localStorage.
- [x] Dirty, Discard, export, expiry, and reauthentication states use Thai copy, semantic controls, keyboard access, managed focus, and clear loading/error/success feedback.
- [x] Tests cover clean versus dirty navigation, save failure, export ordering, idempotent Discard, expiry warning timing, and safe return-path validation.
