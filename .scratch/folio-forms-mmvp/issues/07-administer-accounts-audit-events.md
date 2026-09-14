# 07 — Administer accounts with attributable Audit Events

**What to build:** Give every Admin the same Thai account-management workflow for provisioning, role and access changes, credential reset, and identity correction while recording safe attributable Audit Events.

**Blocked by:** 04 — Secure bootstrap and browser Sessions

**Status:** ready-for-human

- [x] The Admin Users view is cursor-paginated and searchable/filterable by normalized email, role, and enabled state.
- [x] An Admin can create a User or Admin and receives one cryptographically generated temporary password of at least 20 characters exactly once.
- [x] An Admin can enable or disable an account; disable revokes all Sessions but preserves domain data.
- [x] An Admin can issue a new temporary password, and every prior Session is revoked while mandatory password change is restored.
- [x] An Admin can change a normalized unique email; duplicates are rejected, Sessions are revoked, and later login uses only the new email.
- [x] An Admin can promote or demote an account; role changes revoke Sessions, take effect on the next authenticated request, and never create a stronger Admin tier.
- [x] All Admins have equal authority, but attempts to disable or demote the final enabled Admin fail atomically.
- [x] Each privileged account action appends an Audit Event with actor, target, time, action, and outcome but no password, token, or credential material.
- [x] A User cannot call account-administration contracts or inspect another account.
- [x] Account administration uses Thai copy, semantic labelled controls, keyboard access, managed focus, and clear loading/error/success states.
- [x] Black-box tests cover the role matrix, final-Admin race, temporary-password disclosure, email uniqueness, revocation, and audit record.

## Agent implementation

- Added one Admin account surface and four bounded HTTP contracts for cursor pagination, normalized filters, account creation, account mutation, and password reset.
- Serialized account mutations with live actor/Session revalidation and final-enabled-Admin protection under the bootstrap advisory lock.
- Stored only password hashes, revoked Sessions on every trust change, and emitted fixed-field attributable Audit Events without secret material.
- Added Thai semantic controls, explicit confirmation, deterministic focus restoration, one-time credential disclosure, request overlap protection, and local session invalidation after self-mutation.

## Agent verification

- Isolated PostgreSQL/RustFS HTTP journey: 1 passed, 378 assertions.
- Server and web TypeScript checks, targeted Ultracite checks, and both production builds passed.
- Real Chromium proof logged in as an Admin, preserved Forms active semantics on nested routes, made only Users active on `/admin/users`, created an account, rendered its one-time credential, and moved focus to that disclosure. Screenshot: `/tmp/ticket07-final-users.png`.
- Independent correctness and security reviews reported no surviving ticket findings.
