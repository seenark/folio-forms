# Better Auth 1.7.x + PostgreSQL/Drizzle + Bearer JWT research

**Scope and version.** The repository currently pins Better Auth `1.7.1`. The versioned package manifest confirms `1.7.1` and exports the `better-auth/plugins` surface ([v1.7.1 package manifest](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.1/packages/better-auth/package.json)). Better Auth's live pages currently render v1.8 beta in places; therefore examples below are checked against the v1.7.1 source where noted, and beta-only options are not requirements.

## Recommended architecture (verified)

Use Better Auth's **Bearer plugin alone** for this SPA/API requirement. It converts a Bearer token into the normal Better Auth session cookie internally, then `auth.api.getSession({ headers })` performs the usual database-backed session lookup. It is not a JWT verifier. The v1.7.1 implementation HMAC-verifies the session token and exposes a newly issued session token as `set-auth-token` ([bearer source, v1.7.1](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.1/packages/better-auth/src/plugins/bearer/index.ts)).

The JWT plugin is a separate feature for services that need independently verifiable signed JWTs: it adds `/token` and `/jwks`, and the token is signed with the plugin's JWK key pair ([JWT docs](https://better-auth.com/docs/plugins/jwt), [JWT source, v1.7.1](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.1/packages/better-auth/src/plugins/jwt/index.ts)). Better Auth explicitly says JWT is not a replacement for sessions and points authentication use cases to Bearer. Do **not** assume `jwt()` + `bearer()` means the Bearer plugin will verify a JWT: v1.7.1 Bearer's HMAC check is incompatible with the JWT plugin's EdDSA/JWK signature path. If an external service truly needs a signed JWT, use `jwt()` and call `/token`, then verify it using `/jwks`; use a separate API boundary or explicit JWT verifier rather than treating that JWT as a Better Auth session token.

## Server configuration

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { bearer } from "better-auth/plugins";
import { db } from "./db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [bearer()],
  user: {
    additionalFields: {
      // Server-owned: clients must not submit or change authorization.
      role: { type: "string", input: false, defaultValue: "user" },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // explicit seven-day session
    updateAge: 60 * 60 * 24, // rolling refresh at most daily
  },
});
```

`emailAndPassword.enabled: true` enables the built-in authenticator ([email/password docs](https://better-auth.com/docs/authentication/email-password)). The Drizzle adapter is `drizzleAdapter(db, { provider: "pg" })`; install the adapter package and generate/apply schema with Bun-equivalent commands (the docs show the underlying CLI commands):

```sh
bun add better-auth @better-auth/drizzle-adapter
bunx auth@latest generate
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

The adapter documentation requires the Better Auth tables/fields and says the CLI can generate the schema; if using a custom Drizzle schema, pass it through the adapter and ensure relations are defined ([Drizzle adapter docs](https://better-auth.com/docs/adapters/drizzle)). The JWT plugin would additionally require its JWK table/schema; Bearer alone does not require JWT/JWKS tables.

Mount the handler in Elysia:

```ts
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";

const app = new Elysia()
  .use(
    cors({
      origin: "http://localhost:3001", // production: exact SPA origin
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["set-auth-token"],
    })
  )
  .mount(auth.handler)
  .listen(3000);
```

The official Elysia integration verifies `.mount(auth.handler)` and its CORS example allows `Authorization` and credentials ([Elysia integration](https://better-auth.com/docs/integrations/elysia)). `exposeHeaders` is needed when browser code reads `set-auth-token`; include it explicitly because the Bearer plugin adds the header and an `Access-Control-Expose-Headers` value in its after-hook (v1.7.1 source above).

## SPA flow and exact endpoints

1. **Sign up:** `POST /api/auth/sign-up/email` with `{ name, email, password }` (password defaults to 8–128 characters). **Sign in:** `POST /api/auth/sign-in/email` with `{ email, password, rememberMe }`. The client APIs are `authClient.signUp.email(...)` and `authClient.signIn.email(...)` ([email/password docs](https://better-auth.com/docs/authentication/email-password)).
2. With `bearer()` enabled, successful sign-in response exposes the opaque **session token** in `set-auth-token`. Store it only if choosing header-based API calls; the official Bearer example uses `localStorage`, but that is an XSS risk (see Security below).
3. Send `Authorization: Bearer <session-token>` to `/api/auth/*` and application routes. Bearer converts it to the session cookie for the request; the server then resolves `auth.api.getSession({ headers: request.headers })`.
4. **Logout:** `POST /api/auth/sign-out` via `authClient.signOut()` and remove the local token. Logout ends the current server session. A copied token is rejected on the next server-side session lookup (in-flight requests are not retroactively cancellable); always clear the client copy and use HTTPS.

Client setup for automatic headers (official API shape):

```ts
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000/api/auth",
  fetchOptions: {
    auth: {
      type: "Bearer",
      token: () => localStorage.getItem("bearer_token") ?? "",
    },
  },
});
```

The plugin's documented alternative is to read `set-auth-token` in `onSuccess` after sign-in, then send `Authorization: Bearer ${token}` per request ([Bearer docs](https://better-auth.com/docs/plugins/bearer)). Prefer an in-memory token where possible; if persistence across reloads is required, localStorage is the documented but weaker choice.

## Token distinctions (important)

- **Session token:** opaque, database-backed identifier; the `session.token` value is also the primary session cookie. Session expiry is controlled by `session.expiresIn` (default 7 days) and may roll forward when `updateAge` is reached ([session management](https://better-auth.com/docs/beta/concepts/session-management)). Bearer's `set-auth-token` is this token, not a signed JWT.
- **JWT plugin token:** signed JWT from `GET /api/auth/token` (requires an existing session), independently verifiable by consumers using public keys from `GET /api/auth/jwks`; the JWT docs show `authClient.token()` and `Authorization: Bearer ${token}` for an external service ([JWT docs](https://better-auth.com/docs/plugins/jwt)). In v1.7.1, the signing implementation defaults JWT `exp` to `options.jwt.expirationTime` or `"15m"` when no explicit `exp` is supplied ([v1.7.1 signing source](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.1/packages/better-auth/src/plugins/jwt/sign.ts)). Claims/signing-key rotation are JWT-plugin concerns, not the session cookie's opaque token semantics.
- **Cookie-cache JWT:** if `session.cookieCache.strategy = "jwt"`, Better Auth writes a separate `session_data` cache cookie; it is distinct from both the primary `session_token` and JWT plugin `/token` output ([session management](https://better-auth.com/docs/beta/concepts/session-management)).

## Roles and authorization

Store `role` as a user additional field (or use the Admin plugin for its built-in role model). Set `input: false`; Better Auth documents that additional fields default to accepting user input, which can permit privilege escalation. Run schema generation after adding the field, and enforce role checks on the server after `getSession`; a client-visible role is a display hint, never authorization ([TypeScript/additional fields](https://better-auth.com/docs/concepts/typescript), [Admin plugin](https://better-auth.com/docs/plugins/admin)).

## Security and compatibility caveats

- `localStorage` is readable by any JavaScript executing in the origin. An XSS bug or compromised dependency can exfiltrate the bearer token; unlike an HttpOnly cookie, JavaScript cannot be prevented from reading it. CSP, output encoding, dependency hygiene, short expirations, and server-side revocation reduce (but do not eliminate) impact. Better Auth's own Bearer page says to use the plugin cautiously and labels localStorage as its example, not as a guarantee of safety.
- Bearer v1.7.1 defaults `requireSignature` to `false`, but still HMAC-validates the transformed session token. `requireSignature: true` rejects opaque unsigned bearer values; it does not make Bearer verify JWT/JWKS signatures.
- CORS must use a specific allowed origin (not `*` with credentials), allow `Authorization`, and expose `set-auth-token` if the SPA reads it. Use HTTPS in production.
- The live documentation is currently v1.8 beta while this repo uses 1.7.1. Verify the exact installed package's generated types/source before upgrading; notably endpoint paths, cookie/header behavior, and plugin composition are version-sensitive. The v1.7.1 source confirms the Bearer HMAC path and JWT JWK path cited above.

**Conclusion:** for the stated requirement—React SPA sends `Authorization: Bearer` and Elysia authenticates it—the simplest verified implementation is `emailAndPassword + drizzleAdapter(pg) + bearer()`, with the opaque session token. Add `jwt()` only when a separate consumer needs independently verifiable JWTs; do not compose both as though JWT output were a Bearer session token.
