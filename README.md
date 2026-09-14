# Folio Forms

Production-oriented MMVP for designing, publishing, and completing DOCX forms with ONLYOFFICE Docs.

The application provides:

- Admin form design and publishing.
- Public, shareable form links.
- Authenticated user form completion.
- User-specific prefill with locked and editable field policies.
- Explicit draft save and resume.
- Immutable submissions with extracted JSON, canonical filled DOCX, and on-demand PDF exports.
- Admin submission review and authorized downloads.

The accepted deployment target is one private single-host Docker Compose stack.

## Contents

- [Stack and ports](#stack-and-ports)
- [Quick start](#quick-start)
- [Open the application](#open-the-application)
- [Run modes](#run-modes)
- [Roles and workflow](#roles-and-workflow)
- [DOCX template requirements](#docx-template-requirements)
- [Persistence and artifact storage](#persistence-and-artifact-storage)
- [Authentication and security](#authentication-and-security)
- [HTTP API](#http-api)
- [Frontend routes](#frontend-routes)
- [Repository map](#repository-map)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Production hardening](#production-hardening)

## Stack and ports

| Component | Technology | Local address |
| --- | --- | --- |
| Web app | React, Vite, TanStack Router, Tailwind CSS, shadcn-compatible primitives | `http://localhost:5173` |
| API | Bun, Elysia, TypeScript | `http://localhost:3000` |
| Document editor | ONLYOFFICE Docs Community Edition 9.4.0.1 | `http://localhost:8080` |
| Database | PostgreSQL 18 | `localhost:5432` |
| ORM and migrations | Prisma | `packages/db` |
| Authentication | Better Auth bearer sessions | API under `/api/auth/*` |
| Object storage | RustFS 1.0.0-rc.6, private S3 bucket | `localhost:9000` |

## Quick start

Use this mode when the API runs as a host Bun process and PostgreSQL, RustFS, and ONLYOFFICE run in Docker.

### 1. Install dependencies

```bash
bun install
```

### 2. Configure the API

```bash
cp apps/server/.env.example apps/server/.env
```

Replace `BETTER_AUTH_SECRET` with a random value of at least 32 characters. The checked-in example and Compose RustFS credentials are for isolated local setup only.

Canonical Template and Response DOCX objects live in the private RustFS bucket. Database rows store opaque object keys; browsers and ONLYOFFICE read them only through short-lived API authorization.

### 3. Start PostgreSQL, RustFS, and ONLYOFFICE

```bash
docker compose -f compose.yaml up -d postgres rustfs rustfs-init onlyoffice
```

### 4. Apply the checked-in Prisma migration

```bash
bun run --cwd packages/db db:generate
bun run --cwd apps/server db:migrate
```

The initial migration creates the accepted MMVP schema on an empty PostgreSQL database. Prototype data and demo accounts are intentionally not migrated or seeded.

### 5. Start the web app and host API

```bash
bun run dev
```

This runs the API and web app through Turborepo. Open `http://localhost:5173`.

Do not run the Compose `server` service at the same time as the host API; both use port `3000`.

## Open the application

Main application:

```text
http://localhost:5173
```

Create and publish a Form from the Admin interface, then use its generated opaque share link. No seeded Form or fixed share ID exists.

Main screens:

- `/login` — sign in.
- `/dashboard` — user responses and draft resume links.
- `/admin` — admin form list.
- `/admin/forms/new` — create a form.
- `/admin/forms/:formId` — edit and publish a DOCX template.
- `/admin/forms/:formId/submissions` — inspect submissions for a form.
- `/receipt/:submissionId` — read-only receipt and artifact downloads.

## Run modes

Choose exactly one API mode.

### Host API mode

PostgreSQL, RustFS, and ONLYOFFICE run in Docker. The API and web app run under Bun:

```bash
docker compose -f compose.yaml up -d postgres rustfs rustfs-init onlyoffice
bun run --cwd apps/server db:migrate
bun run dev
```

### Compose API mode

PostgreSQL, RustFS, ONLYOFFICE, and the API run in Docker. The web app remains a host process:

```bash
docker compose -f compose.yaml up -d --build postgres rustfs rustfs-init onlyoffice server
bun run --cwd apps/web dev
```

The Compose server:

1. Applies checked-in Prisma migrations with `prisma migrate deploy`.
2. Connects to the initialized private RustFS bucket.
3. Starts the compiled API on port `3000`.

Check service state with:

```bash
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 server
```

The Compose file intentionally uses local development credentials and networking. See [Production hardening](#production-hardening).

## Roles and workflow

### Admin workflow

1. Sign in with an Admin account.
2. Select **New form** and enter a title and description.
3. Open the DOCX editor.
4. Add tagged content controls to the template.
5. Use the ONLYOFFICE **Form** tab to select **Save Template**.
6. Select **Publish** when the template is ready.
7. Copy the generated share link.
8. Review submitted responses from the form's **View submissions** page.

Publishing:

- Validates that the DOCX is readable.
- Requires at least one tagged content control.
- Requires every content control to have a tag.
- Rejects duplicate tags.
- Replaces the current published template.
- Invalidates active unsubmitted drafts for the form.
- Leaves completed submissions unchanged.

The admin editor also warns before publishing when saved drafts will be invalidated.

### User workflow

1. Open the share link.
2. Sign in.
3. Wait for the user-specific prefill to appear.
4. Open the ONLYOFFICE **Form** tab.
5. Select **Save Draft** to persist a resumable response.
6. Return through the dashboard to resume the same response.
7. Select **Submit** to create the immutable receipt.

The prefill is snapshotted when the response starts. Resuming a draft does not refresh the profile. Starting again after publication invalidates an old draft and creates a new snapshot for the new published version.

Submission is complete only after the extracted field JSON and canonical filled DOCX are persisted. PDF is an on-demand export and is not durable submission state.

## DOCX template requirements

Fields are ONLYOFFICE content controls. Their tags are the stable field keys used in JSON and prefill data.

Each Form defines its own unique, non-empty tags. Supported controls include text, checkbox, date, dropdown, combo box, and picture fields.

The plugin extracts:

- Inline and block text.
- Checkbox values as booleans.
- Date picker values as `YYYY-MM-DD`.
- Dropdown and combo-box stored values.

The plugin applies prefill through ONLYOFFICE's command API, then restricts respondent sessions to form editing. The action flow temporarily switches the editor to view restriction while extracting and force-saving a draft or submission, then restores form editing.

## Persistence and artifact storage

### PostgreSQL tables

`packages/db/prisma/schema.prisma` defines:

- Better Auth `User`, `Session`, `Account`, and `Verification` models.
- Forms, Template Drafts, immutable Published Templates, Field Manifests, and Prefill Configuration.
- One Response per User/Form, immutable Submissions, Prefill snapshots, and append-only Corrections.
- Handoffs, pending claims, Operations, callback claims, and Editor Leases.
- immutable Audit Events, login-failure windows, and Deletion Tombstones.

Database constraints enforce:

- Normalized unique account email and opaque Form public IDs.
- One Response per User/Form and one Submission per Response.
- Immutable published contracts and monotonic Correction revisions.
- One active Operation and one Editor Lease per target.
- Accepted lifecycle, ownership, document-reference, and expiry invariants.

### Private object storage

RustFS stores canonical DOCX objects under opaque keys such as:

```text
forms/<formId>/template-draft/<uuid>/docx
forms/<formId>/published/<version>/<uuid>/docx
responses/<responseId>/draft/<uuid>/docx
submissions/<submissionId>/filled/<uuid>/docx
operations/<operationId>/<kind>/<uuid>/docx
```

The bucket is private. The API authorizes each request and streams bytes to browsers or ONLYOFFICE; it never exposes a public or presigned bucket URL. New documents are staged under Operation-specific keys, database references advance only after the object is durable, and superseded staging/Draft objects are removed after the transition succeeds. PDF exports are rendered on demand and discarded after the response.

## Authentication and security

- Better Auth handles email/password sign-in and PostgreSQL-backed sessions.
- Sessions use opaque Better Auth tokens, not JWTs.
- The frontend sends `Authorization: Bearer <session-token>`.
- The local web app stores the token at `localStorage["onlyoffice.sessionToken"]`.
- The server derives identity and role from Better Auth, never from client-supplied role fields.
- Admin routes require the `admin` role.
- User response and submission routes enforce ownership.
- ONLYOFFICE document URLs use a five-minute HMAC token bound to the document key.
- ONLYOFFICE callback userdata uses a server-signed HMAC envelope containing the operation ID.
- Callback document downloads are restricted to configured ONLYOFFICE origins, disallow redirects, and enforce a response-size limit.
- Response JSON is restricted to published content-control tags, scalar values, and a bounded payload size.
- Operations expire and roll back submitting responses when they remain active too long.

These protections make the local prototype behaviorally safe for the demo, but the deployment defaults below are not suitable for the public internet.

## HTTP API

All protected endpoints use the bearer session header:

```http
Authorization: Bearer <opaque-better-auth-session-token>
```

### Authentication and health

| Method | Path          | Purpose              |
| ------ | ------------- | -------------------- |
| `*`    | `/api/auth/*` | Better Auth handlers |
| `GET`  | `/health`     | API health check     |

### Public and user form operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/forms/:publicId` | Read public form metadata |
| `GET` | `/api/forms/:publicId/editor-config` | Get protected user editor config |
| `POST` | `/api/forms/:publicId/start` | Start or resume one user response |
| `POST` | `/api/forms/:publicId/draft` | Save a draft through an asynchronous operation |
| `POST` | `/api/forms/:publicId/submit` | Submit a response through an asynchronous operation |
| `GET` | `/api/responses/me` | List the current user's responses |
| `GET` | `/api/operations/:id` | Poll an owned or Admin operation |

### Admin form operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/forms` | List forms with submission counts |
| `DELETE` | `/api/admin/forms/:id` | Remove a draft form without responses |
| `POST` | `/api/admin/forms` | Create a form from the configured template |
| `GET` | `/api/admin/forms/:id` | Read form detail and draft count |
| `GET` | `/api/admin/forms/:id/editor-config` | Get template editor config |
| `POST` | `/api/admin/forms/:id/save` | Save the template draft |
| `POST` | `/api/admin/forms/:id/publish` | Publish a validated template |
| `GET` | `/api/admin/forms/:id/submissions` | List all submissions for a form |

### Submission artifacts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/submissions/:id/data` | Read authorized submission JSON and metadata |
| `GET` | `/api/submissions/:id/docx` | Download an authorized filled DOCX |
| `GET` | `/api/submissions/:id/pdf` | Download an authorized PDF |

### ONLYOFFICE integration

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/onlyoffice/document/:key` | Serve a signed document to ONLYOFFICE |
| `GET` | `/onlyoffice-plugin/config.json` | Serve plugin registration metadata |
| `GET` | `/onlyoffice-plugin/index.html` | Serve the plugin iframe |
| `GET` | `/onlyoffice-plugin/plugin.js` | Serve the form bridge |
| `POST` | `/onlyoffice/callback` | Receive signed operation callbacks |

## Frontend routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | Authenticated | Redirect Admin to `/admin`, User to `/dashboard` |
| `/login` | Public | Sign in and preserve a safe return path |
| `/dashboard` | User | View and resume responses |
| `/admin` | Admin | View forms, remove draft forms, and submission counts |
| `/admin/forms/new` | Admin | Create a form |
| `/admin/forms/:formId` | Admin | Edit, save, publish, and share a template |
| `/admin/forms/:formId/submissions` | Admin | Review form submissions |
| `/admin/forms/:formId/submissions/:submissionId` | Admin | Read a submission and download artifacts |
| `/forms/:publicId/fill` | Authenticated | Fill, save, or submit a shared form |
| `/receipt/:submissionId` | Authorized | Read a completed submission receipt |

ONLYOFFICE is a desktop-oriented editor. The dashboard and administrative shell are responsive; the fill/editor screen displays a desktop recommendation.

## Repository map

```text
apps/
  onlyoffice-plugin/       ONLYOFFICE plugin manifest, UI, extraction, prefill, actions
  server/
    src/app.ts             Elysia routes and asynchronous operation orchestration
    src/index.ts           Production listen entrypoint
    src/onlyoffice.ts      ONLYOFFICE URLs, HMAC tokens, force-save, PDF conversion
    src/storage.ts         Private RustFS object primitives
    Dockerfile             Production API image
  web/
    src/routes/            TanStack Router screens
    src/components/        App shell, editor wrapper, UI primitives
    src/lib/               API client and auth provider
packages/
  auth/                    Better Auth configuration and bearer plugin
  db/                      Prisma schema, generated client, and checked-in migration
  env/                     Server environment validation
  config/                  Shared TypeScript/project configuration
onlyoffice-templates/
  template.docx            Tracked tagged template
compose.yaml               PostgreSQL, RustFS, ONLYOFFICE, and API services
CONTEXT.md                 Canonical domain glossary
```

## Commands

Install dependencies:

```bash
bun install
```

Database:

```bash
bun run --cwd apps/server db:migrate
bun run --cwd packages/db db:generate
```

Development:

```bash
bun run dev
bun run --cwd apps/server dev
bun run --cwd apps/web dev
```

Quality:

```bash
bun x ultracite fix
bun x ultracite check
bun run check-types
bun run build
```

Docker:

```bash
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml build server
docker compose -f compose.yaml up -d --build postgres rustfs rustfs-init onlyoffice server
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 server
docker compose -f compose.yaml down
```

Run `bun run --cwd apps/server test:http` and `bun run --cwd apps/server test:storage` against an isolated PostgreSQL database and disposable private RustFS bucket.

## Troubleshooting

### API does not start

Check the services and API health:

```bash
docker compose -f compose.yaml ps
curl http://localhost:3000/health
```

If port `3000` is already occupied, stop the other API mode before starting the selected one.

### PostgreSQL does not start

Inspect the database logs:

```bash
docker compose -f compose.yaml logs --tail=100 postgres
```

PostgreSQL 18 uses the `/var/lib/postgresql` volume mount in `compose.yaml`. Do not reuse an incompatible older PostgreSQL data volume without migrating it.

### The editor says that a document is unavailable

Confirm that:

1. PostgreSQL, RustFS, and ONLYOFFICE are healthy.
2. The API can reach the configured ONLYOFFICE and `RUSTFS_ENDPOINT` URLs.
3. The configured template exists at `TEMPLATE_PATH`.
4. `RUSTFS_BUCKET` exists and the configured access key can read and write it.
5. Host API mode uses `http://localhost:9000`; Compose API mode uses `http://rustfs:9000`.

### Form actions are missing

Open the document's **Form** tab inside ONLYOFFICE. The custom actions are registered by the Form Bridge plugin. Then check:

```bash
curl http://localhost:3000/onlyoffice-plugin/config.json
curl http://localhost:3000/onlyoffice-plugin/plugin.js
```

The plugin requires a valid authenticated editor configuration and bearer token.

## Production hardening

Before exposing this system outside an isolated local workstation:

1. Enable ONLYOFFICE JWT request/inbox/outbox authentication and configure the server with the same secret.
2. Remove hardcoded database credentials and authentication secrets from `compose.yaml`.
3. Use HTTPS behind a reverse proxy with strict host and origin allowlists.
4. Replace localStorage bearer tokens with an httpOnly, secure session strategy where appropriate.
5. Restrict PostgreSQL and ONLYOFFICE network exposure; do not publish them directly.
6. Keep RustFS private, rotate its credentials, and monitor object durability.
7. Add request rate limits, audit logging, observability, backup, and retention policies.
8. Add automated integration tests for callback correlation, operation races, artifact completeness, authorization, and publish invalidation.
9. Keep the callback URL allowlist narrow and review outbound network access.
10. Rotate all local development credentials before deployment.

## Related documentation

- [Domain glossary](CONTEXT.md)
- [Frontend setup research](docs/research/frontend-setup.md)
- [Authentication setup research](docs/research/auth-setup.md)
- [Database setup notes](packages/db/README.md)
