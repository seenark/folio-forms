// oxlint-disable func-style -- Preserve database factory declaration contracts and initialization order.
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export type PostgresClient = postgres.Sql;

export interface CreateDbOptions {
  /** PostgreSQL connection string; defaults to DATABASE_URL or local PostgreSQL. */
  url?: string;
  /** Reuse a caller-owned postgres-js client instead of opening a connection. */
  client?: PostgresClient;
  /** Maximum number of connections for a newly created postgres-js client. */
  max?: number;
}

export interface DatabaseConnection {
  db: Database;
  client: PostgresClient;
}

function resolveOptions(
  optionsOrUrl: CreateDbOptions | string | undefined
): CreateDbOptions {
  if (typeof optionsOrUrl === "string") {
    return { url: optionsOrUrl };
  }

  return optionsOrUrl ?? {};
}

/** Create a Drizzle database backed by postgres-js. */
export function createDbConnection(
  optionsOrUrl?: CreateDbOptions | string
): DatabaseConnection {
  const options = resolveOptions(optionsOrUrl);

  if (options.client) {
    return {
      client: options.client,
      db: drizzle(options.client, { schema }),
    };
  }

  const url =
    options.url ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/onlyoffice";

  const client = postgres(url, {
    max: options.max ?? 10,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

/** Create a database handle; callers creating connections own client shutdown. */
export function createDb(optionsOrUrl?: CreateDbOptions | string): Database {
  return createDbConnection(optionsOrUrl).db;
}

const sharedConnection = createDbConnection();

/** Shared application database handle, configured from DATABASE_URL. */
export const { db } = sharedConnection;
export const dbClient = sharedConnection.client;

/** Close the shared handle for one-shot scripts such as database seeding. */
export async function closeDb(): Promise<void> {
  await dbClient.end();
}
