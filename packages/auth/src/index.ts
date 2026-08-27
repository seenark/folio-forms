// oxlint-disable func-style -- Preserve the auth factory's exported function contract.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, schema } from "@onlyoffice/db";
import { env } from "@onlyoffice/env/server";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";

const sessionDurationSeconds = 8 * 60 * 60;

const trustedOrigins = [...new Set([env.CORS_ORIGIN, env.SERVER_ORIGIN])];

export function createAuth() {
  return betterAuth({
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "none",
        secure: true,
      },
    },
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [bearer()],
    secret: env.BETTER_AUTH_SECRET,
    session: {
      expiresIn: sessionDurationSeconds,
    },
    trustedOrigins,
    user: {
      additionalFields: {
        role: {
          defaultValue: "user",
          input: false,
          type: "string",
        },
      },
    },
  });
}

export const auth = createAuth();
