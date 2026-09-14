import { expect, test } from "bun:test";

import { env } from "@onlyoffice/env/server";

import {
  deleteObject,
  DOCX_CONTENT_TYPE,
  objectExists,
  objectKey,
  putObject,
  readObject,
  streamObject,
} from "../src/storage";

const requiredRustFsValues = [
  ["RUSTFS_ENDPOINT", env.RUSTFS_ENDPOINT],
  ["RUSTFS_ACCESS_KEY_ID", env.RUSTFS_ACCESS_KEY_ID],
  ["RUSTFS_SECRET_ACCESS_KEY", env.RUSTFS_SECRET_ACCESS_KEY],
  ["RUSTFS_BUCKET", env.RUSTFS_BUCKET],
] as const;

for (const [name, value] of requiredRustFsValues) {
  if (!value) {
    throw new Error(`The RustFS storage test requires ${name}`);
  }
}

const directObjectUrl = (key: string): string => {
  const endpoint = env.RUSTFS_ENDPOINT.replace(/\/+$/u, "");
  const encodedBucket = encodeURIComponent(env.RUSTFS_BUCKET);
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${endpoint}/${encodedBucket}/${encodedKey}`;
};

test("stores private RustFS objects and cleans up only its randomized keys", async () => {
  const testId = crypto.randomUUID();
  const sourceKey = objectKey("storage-tests", testId, "source.docx");
  const replacementKey = objectKey("storage-tests", testId, "replacement.docx");
  const sourceBytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  const replacementBytes = Uint8Array.from([255, 254, 128, 64, 3, 2, 1, 0]);
  let sourceCreated = false;
  let replacementCreated = false;

  try {
    expect(sourceKey).not.toBe(replacementKey);
    expect(await objectExists(sourceKey)).toBe(false);
    expect(await objectExists(replacementKey)).toBe(false);

    await putObject(sourceKey, sourceBytes, DOCX_CONTENT_TYPE);
    sourceCreated = true;
    expect(await objectExists(sourceKey)).toBe(true);
    expect(await readObject(sourceKey)).toEqual(sourceBytes);
    expect(
      new Uint8Array(await new Response(streamObject(sourceKey)).arrayBuffer())
    ).toEqual(sourceBytes);

    const directResponse = await fetch(directObjectUrl(sourceKey), {
      redirect: "manual",
    });
    expect(directResponse.ok).toBe(false);
    expect(new Uint8Array(await directResponse.arrayBuffer())).not.toEqual(
      sourceBytes
    );

    await putObject(replacementKey, replacementBytes, DOCX_CONTENT_TYPE);
    replacementCreated = true;
    expect(await objectExists(replacementKey)).toBe(true);
    expect(await readObject(replacementKey)).toEqual(replacementBytes);
    expect(await objectExists(sourceKey)).toBe(true);

    await deleteObject(sourceKey);
    expect(await objectExists(sourceKey)).toBe(false);
    expect(await objectExists(replacementKey)).toBe(true);

    await deleteObject(sourceKey);
    expect(await objectExists(sourceKey)).toBe(false);
  } finally {
    if (sourceCreated) {
      await deleteObject(sourceKey);
    }
    if (replacementCreated) {
      await deleteObject(replacementKey);
    }
  }
});
