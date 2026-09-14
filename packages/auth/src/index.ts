// oxlint-disable func-style -- Preserve the auth factory's exported function contract.
import { prisma } from "@onlyoffice/db";
import { env } from "@onlyoffice/env/server";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
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
    database: prismaAdapter(prisma, {
      provider: "postgresql",
      transaction: true,
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
