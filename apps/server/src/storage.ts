// oxlint-disable func-style -- Preserve function declaration contracts for storage consumers.
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { env } from "@onlyoffice/env/server";

const storageRoot = path.resolve(env.STORAGE_ROOT);

/** The configured runtime storage root, kept private from static serving. */
export function getStorageRoot(): string {
  return storageRoot;
}

/**
 * Resolve a database-relative artifact path while rejecting path traversal.
 * Database rows must never contain an absolute path.
 */
export function resolveArtifactPath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be a non-empty relative path");
  }

  const resolved = path.resolve(storageRoot, relativePath);
  const escaped =
    path.relative(storageRoot, resolved).startsWith("..") ||
    path.isAbsolute(path.relative(storageRoot, resolved));
  if (escaped) {
    throw new Error("Artifact path escapes the configured storage root");
  }
  return resolved;
}

export function artifactExists(relativePath: string): Promise<boolean> {
  return Bun.file(resolveArtifactPath(relativePath)).exists();
}

/** Write bytes atomically so a failed operation cannot replace a good artifact. */
export async function writeArtifact(
  relativePath: string,
  data: ArrayBuffer | Uint8Array | Blob | string
): Promise<void> {
  const outputPath = resolveArtifactPath(relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, data);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readArtifact(relativePath: string): Promise<Uint8Array> {
  const bytes = await Bun.file(resolveArtifactPath(relativePath)).arrayBuffer();
  return new Uint8Array(bytes);
}

export async function readArtifactJson<T>(relativePath: string): Promise<T> {
  const file = Bun.file(resolveArtifactPath(relativePath));
  if (!(await file.exists())) {
    throw new Error("Artifact not found");
  }
  return (await file.json()) as T;
}

export async function removeArtifact(
  relativePath: string | null | undefined
): Promise<void> {
  if (!relativePath) {
    return;
  }
  await rm(resolveArtifactPath(relativePath), { force: true });
}
/** Remove an artifact directory and everything stored below it. */
export async function removeArtifactDirectory(
  relativePath: string
): Promise<void> {
  await rm(resolveArtifactPath(relativePath), { force: true, recursive: true });
}

export async function ensureStorageRoot(): Promise<void> {
  await mkdir(storageRoot, { recursive: true });
}

export function artifactPath(...parts: string[]): string {
  const joinedPath = parts.join("/");
  // Resolve once here to validate all generated paths before persisting them.
  resolveArtifactPath(joinedPath);
  return joinedPath;
}
