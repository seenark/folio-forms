# 04 — Secure bootstrap and browser Sessions

**What to build:** Deliver the complete entry and Session lifecycle for Admins and Users: create-only bootstrap, provisioned login, mandatory password replacement, one-hour live revocation, throttling, private pre-login routing, and Thai authentication UX.

**Blocked by:** 02 — Cut the existing workflow over to Prisma

**Status:** ready-for-human

- [x] Startup creates an Admin from `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` only when no Admin exists and never mutates an existing Admin on later starts.
- [x] Public sign-up is unavailable through both UI and direct Better Auth requests.
- [x] Passwords accept 12–128 characters without composition rules, every authenticated account can change its own password, and a bootstrapped or temporary credential forces replacement before product routes are usable.
- [x] The opaque bearer Session is stored under the existing browser key, expires absolutely after one hour, and does not refresh its lifetime.
- [x] Logout and password replacement invalidate the prior Session immediately through live server lookup.
- [x] Five failed logins for one normalized-email/IP pair within fifteen minutes are throttled without revealing whether the account exists, and successful login clears that pair's failure state.
- [x] An unauthenticated Form link shows only generic Thai login UI and reveals no Form title, description, state, or document preview.
- [x] A safe same-origin return path survives successful login and mandatory password replacement without carrying Field data.
- [x] Authentication UI maps stable error codes to safe Thai text through labelled semantic controls, predictable keyboard focus, and clear loading/error/success states without displaying raw server or operational messages.
- [x] Setup and environment guidance documents create-only bootstrap, no public signup, temporary-password replacement, and the fixed Session lifetime without demo credentials.
- [x] Black-box tests cover bootstrap idempotence, no-signup, password boundaries, throttle isolation, Session expiry metadata, revocation, and metadata privacy.

## Agent proof

- Applied the normalized-email migration to isolated database `folio_forms_ticket04`, created private bucket `folio-forms-ticket04`, and ran the application against those disposable services.
- `bun run --cwd apps/server test:http` passed, then passed again after the browser replaced the existing bootstrap password: 1 test, 122 assertions. The black-box journey covers create-only bootstrap without mutation, disabled direct signup, 12/128-character password boundaries, mandatory replacement, absolute one-hour Sessions, password/logout revocation, normalized email/IP throttling including eight concurrent failures, success reset, and pre-login Form metadata privacy.
- `agent-browser` opened a private Form link and observed only generic Thai login UI; its request log contained no API or Form-metadata request before authentication. An unknown-account failure rendered the stable Thai message and focused `#login-error`.
- The bootstrap Admin was redirected from the Form link and a direct `/admin` request to mandatory replacement. Mismatched confirmation rendered Thai feedback and focused `#change-password-error`; successful replacement removed the prior browser token, returned to login with the original pathname, and the new password resumed the exact Form route without carrying query or Field data.
- Desktop (1280×720) and mobile (390×844) authentication screens rendered labelled controls and visible focus without clipping; the mobile login axe audit reported 0 WCAG A/AA violations. Confirmed browser logout removed the local Session token and returned to login.
- Targeted `bun x ultracite check`, `bun run check-types`, `bun run build`, and `docker compose --env-file apps/server/.env.example -f compose.yaml config --quiet` passed.
- Removed the disposable RustFS bucket and PostgreSQL database after verification.
- Final security reviewer verdict: no findings.
