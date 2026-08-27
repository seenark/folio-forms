// oxlint-disable oxc/no-barrel-file -- This package entrypoint intentionally exposes the database API.
export { closeDb, db, createDb, createDbConnection } from "./client";
export { migrateDatabase, migrationsFolder } from "./migrate";
export { seedDatabase } from "./seed";
export type {
  CreateDbOptions,
  Database,
  DatabaseConnection,
  PostgresClient,
} from "./client";
export * from "./schema";
