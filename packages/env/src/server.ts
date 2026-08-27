import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const localDatabaseUrl =
  "postgresql://postgres:postgres@localhost:5432/onlyoffice";
const localServerOrigin = "http://localhost:3000";
const localOnlyOfficeUrl = "http://localhost:8080";

export const env = createEnv({
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
  server: {
    API_BASE: z.url().default(localServerOrigin),

    BETTER_AUTH_SECRET: z.string().min(32),

    BETTER_AUTH_URL: z.url().default(localServerOrigin),

    CONVERTER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

    CONVERTER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1000),

    CONVERTER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    CORS_ORIGIN: z.url().default("http://localhost:5173"),

    DATABASE_URL: z.url().default(localDatabaseUrl),

    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),

    ONLYOFFICE_API_BASE: z.url().default(localOnlyOfficeUrl),

    ONLYOFFICE_DOCUMENT_BASE_URL: z
      .url()
      .default("http://host.docker.internal:3000"),

    ONLYOFFICE_INTERNAL_URL: z.url().default(localOnlyOfficeUrl),

    ONLYOFFICE_URL: z.url().default(localOnlyOfficeUrl),

    SERVER_ORIGIN: z.url().default("http://host.docker.internal:3000"),

    STORAGE_ROOT: z.string().default("./onlyoffice-submissions"),

    TEMPLATE_PATH: z.string().default("./onlyoffice-templates/template.docx"),
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
