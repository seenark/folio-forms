# Better Auth + Prisma configuration

## Runtime contract

- Better Auth owns accounts, credentials, sessions, and bearer-token validation.
- Prisma owns PostgreSQL access through the shared client in `packages/db`.
- Browser requests send `Authorization: Bearer <session-token>`.
- Application authorization reads `session.user.role`; it never trusts a role supplied by the client.
- Session tokens and ONLYOFFICE JWTs are separate credentials for separate trust boundaries.

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

Better Auth is mounted below `/api/auth/*`. The server forwards request headers to `auth.api.getSession`, so the bearer plugin can resolve the live database session. Sign-out revokes that session instead of maintaining an application-side token cache.

## Authorization boundary

Server route guards enforce the two application roles:

- `Admin`: Form, Template, publish, and review operations.
- `User`: Share Link, Response, draft, submit, Receipt, and own-artifact operations.

Database constraints protect lifecycle invariants independently of route checks. Authentication proves identity; route policy and ownership checks decide access.

## Provisioning

The checked-in migration supports an empty PostgreSQL database and creates no demo data. On startup, configured one-time bootstrap credentials create the first Admin only when none exists; after that, authenticated Admins provision accounts. Public sign-up stays disabled.
