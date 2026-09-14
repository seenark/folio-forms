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
| Authentication | Better Auth opaque bearer sessions | Explicit sign-in, sign-out, Session, and password routes |
| Object storage | RustFS 1.0.0-rc.6, private S3 bucket | `localhost:9000` |

## Quick start

Use this mode when the API runs as a host Bun process and PostgreSQL, RustFS, and ONLYOFFICE run in Docker.

### 1. Install dependencies

```bash
bun install
```

### 2. Configure API

```bash
cp apps/server/.env.example apps/server/.env
```

Replace `BETTER_AUTH_SECRET`, `EDITOR_CAPABILITY_SECRET`, and `ONLYOFFICE_JWT_SECRET` with three different random values of at least 32 characters. The first signs browser Sessions, the second signs five-minute editor action capabilities, and the third is shared only with ONLYOFFICE Document Server. Compose RustFS credentials are for isolated local setup only.

For the first startup when no Admin exists, set all three `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` values in `apps/server/.env`. Together they create the first `Admin` only; the password must be 12–128 characters. The bootstrapped credential forces a password replacement on first successful entry. Remove all three variables after that entry. Do not commit `.env` or put a usable password in `.env.example`.

There is no public registration or direct signup. Later accounts are provisioned by authenticated Admins, and later startups never mutate an existing Admin. Admins manage accounts at `/admin/users`. Creation and reset disclose a server-generated temporary password once; the account must replace it at the next sign-in. Disabling an account, changing its email or role, and resetting its password revoke every active Session.

Canonical Template and Response DOCX objects live in the private RustFS bucket. Database rows store opaque object keys; browsers and ONLYOFFICE read them only through short-lived API authorization.

### 3. Start PostgreSQL, RustFS, and ONLYOFFICE

```bash
docker compose --env-file apps/server/.env -f compose.yaml up -d postgres rustfs rustfs-init onlyoffice
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
- `/admin/users` — search, provision, and administer accounts.
- `/admin/forms/new` — create a form.
- `/admin/forms/:formId` — edit and publish a DOCX template.
- `/admin/forms/:formId/submissions` — inspect submissions for a form.
- `/receipt/:submissionId` — read-only receipt and artifact downloads.

## Run modes

Choose exactly one API mode.

### Host API mode

PostgreSQL, RustFS, and ONLYOFFICE run in Docker. The API and web app run under Bun:

```bash
docker compose --env-file apps/server/.env -f compose.yaml up -d postgres rustfs rustfs-init onlyoffice
bun run --cwd apps/server db:migrate
bun run dev
```

### Compose API mode

PostgreSQL, RustFS, ONLYOFFICE, and the API run in Docker. The web app remains a host process:

```bash
docker compose --env-file apps/server/.env -f compose.yaml up -d --build postgres rustfs rustfs-init onlyoffice server
bun run --cwd apps/web dev
```

The Compose server:

1. Applies checked-in Prisma migrations with `prisma migrate deploy`.
2. Connects to the initialized private RustFS bucket.
3. Starts the compiled API on port `3000`.

Check service state with:

```bash
docker compose --env-file apps/server/.env -f compose.yaml ps
docker compose --env-file apps/server/.env -f compose.yaml logs --tail=100 server
```

The Compose file intentionally uses local development credentials and networking. See [Production hardening](#production-hardening).

## Roles and workflow

### Account administration

Every Admin has the same account authority. Use `/admin/users` to search by normalized email, filter by role or enabled state, provision an account, correct its email, enable or disable access, change its role, or reset its password. Creation and reset show a generated temporary password only in that response; copy it before leaving the result. The final enabled Admin cannot be disabled or demoted.

Each privileged account attempt appends an immutable Audit Event with its actor, target, action, outcome, and safe metadata. Passwords, hashes, tokens, and other credential material are excluded.

### Admin workflow

1. Sign in with an Admin account.
2. Select **New form**, enter a title and description, then choose the bundled starter DOCX or upload a `.docx` no larger than 25 MiB.
3. The API validates the file type, size, and required DOCX package parts before creating the Form.
4. Open the leased DOCX editor. A second Admin sees a blocked, non-editable state until the active lease is released or expires.
5. Add tagged content controls to the template.
6. Select **Save Template** and wait for its Operation. A completed save is the exact Draft reopened later; a failed save leaves the prior Draft available for retry.
7. Select **Publish** when the template is ready.
8. Copy the generated share link.
9. Review submitted responses from the form's **View submissions** page.

The Admin Form list shows lifecycle state plus active Draft and Submission counts without exposing database IDs or RustFS object keys. Only a never-published Draft with no Response data can be hard-deleted; deletion removes its Template Draft objects. Create, save, and delete outcomes append attributable, secret-free Form Audit Events.

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
- Handoffs, pending claims, Operations, callback claims, Editor Leases, and durable Object Cleanup Intents.
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

Form creation and hard deletion record Object Cleanup Intents before an object can become unreachable. A committed create clears its intent atomically with the canonical database reference; a new create has a 15-minute in-flight grace so another server cannot clean it prematurely. Failed RustFS deletion leaves the intent durable, and startup plus minute reconciliation retries eligible cleanup.

- Better Auth handles email/password sign-in and PostgreSQL-backed sessions.
- Sessions use opaque Better Auth tokens, not JWTs.
- The frontend sends `Authorization: Bearer <session-token>`.
- The local web app stores the token at `localStorage["onlyoffice.sessionToken"]`.
- Opening an editor configuration atomically claims or renews a 90-second lease for that Template Draft or Response under the live browser Session. A competing Session receives no editable configuration until the holder releases the lease or it expires.
- The browser Session token and editor capabilities are never included in the signed ONLYOFFICE or plugin configuration. Before each action, the browser parent obtains a fresh five-minute capability bound to the actor, role, Form, document target, action, and active lease, then sends only that capability over the source/origin-pinned bridge.
- ONLYOFFICE Document Server uses `ONLYOFFICE_JWT_SECRET` for signed editor configuration, command/conversion requests, private document downloads, and callbacks. It never accepts a Better Auth Session or editor capability at that boundary.
- Each session expires one hour after issuance; sessions do not refresh or slide. The client clears the token at expiry and warns during the final five minutes.
- Logout and password replacement revoke sessions immediately. Password replacement revokes every session, so the Admin must sign in again.
- Admin account creation, disablement, email/role changes, and password resets are attributable Audit Events. Account disablement and credential or identity changes revoke all target Sessions immediately.
- A serialized database invariant prevents concurrent requests from disabling or demoting the final enabled Admin.
- The server derives identity and role from Better Auth, never from client-supplied role fields.
- Admin routes require the `admin` role.
- User response and submission routes enforce ownership.
- ONLYOFFICE document URLs use a five-minute HMAC token bound to the document key.
- ONLYOFFICE callback userdata uses a server-signed HMAC envelope containing the Operation ID. Its exact token digest and single-use consumption are persisted, so replay protection survives process restarts.
- Callback document downloads are restricted to configured ONLYOFFICE origins, disallow redirects, and enforce a response-size limit.
- Response JSON is restricted to published content-control tags, scalar values, and a bounded payload size.
- Operations expire with stable error codes and atomically roll back submitting Responses when they remain active too long. Startup reconciliation expires stale Operations, callback claims, editor leases, and leases backed by expired Sessions without replacing committed object references.

These protections cover the current local stack, but the deployment defaults below are not suitable for the public internet.

## HTTP API

Protected browser endpoints use the opaque bearer Session header:

```http
Authorization: Bearer <opaque-better-auth-session-token>
```

Mutating editor requests require the active lease-bound action capability returned through the validated editor bridge. Plugin Operation polling uses a separate Operation-bound capability:

```http
X-Editor-Capability: <signed-action-or-operation-capability>
```

### Authentication and health

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/sign-in/email` | Provisioned email/password sign-in |
| `POST` | `/api/auth/sign-out` | Revoke the current live Session |
| `GET` | `/api/session` | Read the current live Session and absolute expiry |
| `POST` | `/api/account/password` | Replace the authenticated account password and revoke its Sessions |
| `POST` | `/api/editor-leases/:id/renew` | Renew the current Session's active editor lease |
| `DELETE` | `/api/editor-leases/:id` | Release the current Session's editor lease |
| `GET` | `/health` | API health check |

### Authenticated user form operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/forms/:publicId` | Read Form metadata after authentication |
| `GET` | `/api/forms/:publicId/editor-config` | Get protected user editor config |
| `POST` | `/api/forms/:publicId/start` | Start or resume one user response |
| `POST` | `/api/forms/:publicId/draft` | Save a draft through an asynchronous operation |
| `POST` | `/api/forms/:publicId/submit` | Submit a response through an asynchronous operation |
| `GET` | `/api/responses/me` | List the current user's responses |
| `GET` | `/api/operations/:id` | Poll an owned or Admin operation |

### Admin account operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/users` | Cursor-page and filter accounts by normalized email, role, and enabled state |
| `POST` | `/api/admin/users` | Provision an account and disclose its temporary password once |
| `PATCH` | `/api/admin/users/:id` | Enable/disable or change one email/role value and revoke affected Sessions |
| `POST` | `/api/admin/users/:id/password-reset` | Rotate the credential, revoke Sessions, and disclose a temporary password once |

### Admin form operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/forms` | List lifecycle state plus active Draft and Submission counts |
| `DELETE` | `/api/admin/forms/:publicId` | Remove a never-published Draft without Response data |
| `POST` | `/api/admin/forms` | Create from the starter or an uploaded validated DOCX |
| `GET` | `/api/admin/forms/:publicId` | Read safe form detail and counts |
| `GET` | `/api/admin/forms/:publicId/editor-config` | Claim the exclusive lease and get template editor config |
| `POST` | `/api/admin/forms/:publicId/save` | Save the Template Draft through an asynchronous Operation |
| `POST` | `/api/admin/forms/:publicId/publish` | Publish a validated template |
| `GET` | `/api/admin/forms/:publicId/submissions` | List all submissions for a form |

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
| `/admin` | Admin | View lifecycle state and Draft/Submission counts; remove eligible Draft forms |
| `/admin/forms/new` | Admin | Create from the starter or upload a validated DOCX |
| `/admin/forms/:formId` | Admin | Edit under an exclusive lease, save, publish, and share a template |
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
docker compose --env-file apps/server/.env -f compose.yaml config --quiet
docker compose --env-file apps/server/.env -f compose.yaml build server
docker compose --env-file apps/server/.env -f compose.yaml up -d --build postgres rustfs rustfs-init onlyoffice server
docker compose --env-file apps/server/.env -f compose.yaml ps
docker compose --env-file apps/server/.env -f compose.yaml logs --tail=100 server
docker compose --env-file apps/server/.env -f compose.yaml down
```

Run `bun run --cwd apps/server test:http` and `bun run --cwd apps/server test:storage` against an isolated PostgreSQL database and disposable private RustFS bucket.

## Troubleshooting

### API does not start

Check the services and API health:

```bash
docker compose --env-file apps/server/.env -f compose.yaml ps
curl http://localhost:3000/health
```

If port `3000` is already occupied, stop the other API mode before starting the selected one.

### PostgreSQL does not start

Inspect the database logs:

```bash
docker compose --env-file apps/server/.env -f compose.yaml logs --tail=100 postgres
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

The plugin receives only action-scoped editor capabilities. It never receives or reads the browser Session bearer token.

## Production hardening

Before exposing this system outside an isolated local workstation:

1. Keep ONLYOFFICE JWT inbox/outbox authentication enabled and provision the same dedicated `ONLYOFFICE_JWT_SECRET` to the API and Document Server.
2. Remove hardcoded local database and RustFS credentials from `compose.yaml`.
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
