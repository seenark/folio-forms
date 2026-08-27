// oxlint-disable func-style -- Preserve the seed entrypoint's exported function contract.
import "dotenv/config";
import postgres from "postgres";

function requireDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run @onlyoffice/db seed");
  }

  return databaseUrl;
}

/**
 * Run the database seed hook.
 *
 * The schema has no application fixture rows: user accounts must be created by
 * Better Auth so password hashing remains in the auth boundary. Keeping this
 * entrypoint as a connectivity-only operation makes repeated seed runs safe
 * without inventing users, forms, or submissions.
 */
export async function seedDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<void> {
  const client = postgres(requireDatabaseUrl(databaseUrl), { max: 1 });

  try {
    await client`select 1`;
  } finally {
    await client.end();
  }
}
