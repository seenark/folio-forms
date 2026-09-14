// oxlint-disable oxc/no-barrel-file -- This package entrypoint intentionally exposes the database client and generated model types.
export { disconnectDatabase, prisma } from "./client";
export * from "@prisma/client";
