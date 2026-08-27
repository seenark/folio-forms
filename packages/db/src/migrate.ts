// oxlint-disable func-style -- Preserve the migration entrypoint's exported function contract.
import "dotenv/config";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { schema } from "./schema";

export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url)
);

function requireDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to run @onlyoffice/db migrations"
    );
  }

  return databaseUrl;
}

/** Apply checked-in migrations using a short-lived migration connection. */
export async function migrateDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<void> {
  const client = postgres(requireDatabaseUrl(databaseUrl), { max: 1 });

  try {
    await runMigrations(drizzle(client, { schema }), {
      migrationsFolder,
    });
  } finally {
    await client.end();
  }
}
