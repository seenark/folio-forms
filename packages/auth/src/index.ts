import { env } from "@onlyoffice/env/server";
import { betterAuth } from "better-auth";

export function createAuth() {
  return betterAuth({
    database: "", // Invalid configuration
    trustedOrigins: [env.CORS_ORIGIN],
    emailAndPassword: {
      enabled: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
  });
}

export const auth = createAuth();
