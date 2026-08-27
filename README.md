# Folio Forms prototype

Local prototype for creating, publishing, and completing DOCX forms with ONLYOFFICE Docs.

## Stack

- Bun + Turborepo
- Elysia API on `http://localhost:3000`
- React + Vite + TanStack Router on `http://localhost:5173`
- ONLYOFFICE Docs Community Edition 9.4.0.1 on `http://localhost:8080`
- PostgreSQL 18 on `localhost:5432`
- Drizzle ORM and Better Auth bearer sessions

## Start locally

```bash
bun install
cp apps/server/.env.example apps/server/.env
# Replace BETTER_AUTH_SECRET with a random value of at least 32 characters.
docker compose -f compose.yaml up -d postgres onlyoffice
bun run --cwd apps/server db:migrate
bun run --cwd apps/server db:seed
bun run dev
```

`bun run dev` starts the API and web app through Turborepo. The server seed is idempotent and creates the demo accounts, prefill profiles, and a published `demo-employee-intake` form.

Open the prototype at [http://localhost:5173](http://localhost:5173). The ready-to-share demo form is:

```text
http://localhost:5173/forms/demo-employee-intake/fill
```

## Demo accounts

| Role  | Email                | Password            |
| ----- | -------------------- | ------------------- |
| Admin | `admin@example.com`  | `AdminPassword123!` |
| User  | `user-a@example.com` | `UserAPassword123!` |
| User  | `user-b@example.com` | `UserBPassword123!` |

The browser stores the Better Auth opaque bearer session token in `localStorage` for this local prototype. This is not the production security configuration.

## Docker API mode

To run PostgreSQL, ONLYOFFICE, and the API in Compose:

```bash
docker compose -f compose.yaml up -d --build postgres onlyoffice server
bun run --cwd apps/web dev
```

The Compose server applies migrations and runs the same seed before listening on port 3000. The web app remains a host process so the clickable UI is available on port 5173.

Local ONLYOFFICE networking intentionally keeps `JWT_ENABLED=false`, `ALLOW_PRIVATE_IP_ADDRESS=true`, and `ALLOW_META_IP_ADDRESS=true`. Enable JWT, HTTPS, protected document URLs, and a reverse proxy before any production deployment.

## Prototype workflow

1. Admin signs in and creates a Form with a title and description.
2. Admin edits the DOCX template in ONLYOFFICE and adds tagged Content Controls.
3. Admin saves the template and publishes it. Publishing invalidates unsubmitted drafts for that Form; completed submissions remain immutable.
4. Admin copies the share link and sends it to respondents.
5. A respondent signs in, receives user-specific prefill, fills editable controls, and uses the ONLYOFFICE **Form** tab to save a draft or submit.
6. Submit persists extracted JSON, DOCX, and PDF under the private runtime storage root and exposes authorized download/data APIs.

Content Control tags are the field keys in extracted JSON. Publish checks that every control is tagged and that tags are unique.

## Useful commands

```bash
bun run check-types
bun run build
bun x ultracite check
bun run --cwd apps/server db:migrate
bun run --cwd apps/server db:seed
```

Database setup details are in [`packages/db/README.md`](packages/db/README.md). Official setup research is in [`docs/research/frontend-setup.md`](docs/research/frontend-setup.md) and [`docs/research/auth-setup.md`](docs/research/auth-setup.md).
