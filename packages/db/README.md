# Database setup

The backend uses PostgreSQL and checked-in Drizzle migrations.

```sh
cp apps/server/.env.example apps/server/.env
bun run --cwd apps/server db:migrate
bun run --cwd apps/server db:seed
bun run dev
```

`apps/server db:seed` creates the Better Auth demo accounts and PostgreSQL-backed prefill profiles idempotently:

- `admin@example.com` / `AdminPassword123!`
- `user-a@example.com` / `UserAPassword123!`
- `user-b@example.com` / `UserBPassword123!`

For the complete local stack, run `docker compose -f compose.yaml up --build`; its server service applies migrations and runs the same idempotent seed before starting on port 3000. Keep `STORAGE_ROOT` on a persistent private volume or directory; database rows store only relative artifact paths.
