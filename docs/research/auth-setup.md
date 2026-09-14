# Better Auth + Prisma configuration

## Runtime contract

- Better Auth owns accounts, credentials, sessions, and bearer-token validation.
- Prisma owns PostgreSQL access through the shared client in `packages/db`.
- Browser requests send `Authorization: Bearer <session-token>`.
- The browser stores the opaque bearer at `localStorage["onlyoffice.sessionToken"]`.
- Session lifetime is fixed at one hour from issuance; sessions do not refresh or slide. Logout and password replacement revoke sessions immediately.
- The server derives identity and role from the live Better Auth session; it never trusts client-supplied role fields.
- Session tokens and ONLYOFFICE JWTs are separate credentials for separate trust boundaries.

## First Admin bootstrap

Set all three `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` values before startup when no Admin exists. The password must be 12–128 characters. These values create the first `Admin` only; they are not a seed or demo account.

On the first successful sign-in, the bootstrapped credential requires the Admin to replace its password. Password replacement revokes every session, so the browser must sign in again. Remove all three bootstrap variables after the first successful entry. Later startups never mutate an existing Admin and cannot reset bootstrap credentials.

Public registration and direct signup are disabled. Subsequent accounts are provisioned by authenticated Admins.

## Adapter

`packages/auth/src/index.ts` uses the official adapter:

```ts
import { prismaAdapter } from "better-auth/adapters/prisma";

database: prismaAdapter(prisma, {
  provider: "postgresql",
  transaction: true,
}),
```

The Prisma schema contains Better Auth's `User`, `Session`, `Account`, and `Verification` models alongside the Folio Forms domain models. Generate the client and apply checked-in migrations before starting the API:

```bash
bun run --cwd packages/db db:generate
bun run --cwd apps/server db:migrate
```

Production startup uses `prisma migrate deploy`. It never runs a demo seed.

## Authentication routes

The HTTP surface exposes only provisioned sign-in at `POST /api/auth/sign-in/email`, live-session lookup at `GET /api/session`, self-password replacement at `POST /api/account/password`, and sign-out at `POST /api/auth/sign-out`. Public signup and the rest of Better Auth's handler surface are not mounted. Session lookup forwards the bearer header to Better Auth so the plugin verifies the signed opaque value and resolves the live database Session. Form metadata and all product routes require that live Session; sign-out deletes its database row.

## Authorization boundary

Server route guards enforce the two application roles:

- `Admin`: Form, Template, publish, and review operations.
- `User`: Share Link, Response, draft, submit, Receipt, and own-artifact operations.

Database constraints protect lifecycle invariants independently of route checks. Authentication proves identity; route policy and ownership checks decide access.

## Provisioning

The checked-in migration supports an empty PostgreSQL database and creates no demo data. On startup, configured one-time bootstrap credentials create the first Admin only when none exists; after that, authenticated Admins provision accounts. Public sign-up stays disabled.
