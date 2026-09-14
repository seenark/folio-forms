# Database setup

PostgreSQL state is managed only by Prisma. The checked-in initial migration creates the complete accepted MMVP schema on an empty database; prototype data is intentionally not migrated.

```sh
cp apps/server/.env.example apps/server/.env
bun install
bun run --cwd packages/db db:generate
bun run --cwd packages/db db:migrate
bun run dev
```

`db:migrate` runs `prisma migrate deploy` and is the production startup command. Use `bun run --cwd packages/db db:migrate:dev -- --name <change>` only when authoring a new checked-in migration.

There is no database seed or demo account. The application creates the first Admin from one-time bootstrap configuration only when no Admin exists; authenticated Admins provision later accounts.

The Prisma baseline includes Better Auth Sessions and Accounts; Forms with Template Draft field rules and immutable Published Templates/Field Manifests; one Response per User/Form with a stable external-reference digest; repeatable one-time Handoffs and immutable Prefill snapshots; append-only Corrections; Operations and Editor Leases; Audit Events, Login Failures, and Deletion Tombstones. Canonical document columns are opaque object keys; generated PDFs are not durable database state.
