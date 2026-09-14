import { env } from "@onlyoffice/env/server";

export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const client = new Bun.S3Client({
  accessKeyId: env.RUSTFS_ACCESS_KEY_ID,
  bucket: env.RUSTFS_BUCKET,
  endpoint: env.RUSTFS_ENDPOINT,
  region: env.RUSTFS_REGION,
  secretAccessKey: env.RUSTFS_SECRET_ACCESS_KEY,
});

const validateObjectKey = (key: string): string => {
  const segments = key.split("/");
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Object key must be a non-empty relative slash-separated value"
    );
  }
  return key;
};

export const objectKey = (...parts: string[]): string =>
  validateObjectKey(parts.join("/"));

export const putObject = async (
  key: string,
  data: ArrayBuffer | Uint8Array | Blob | string,
  contentType?: string
): Promise<void> => {
  const validKey = validateObjectKey(key);
  if (contentType === undefined) {
    await client.write(validKey, data);
    return;
  }
  await client.write(validKey, data, { type: contentType });
};

export const readObject = async (key: string): Promise<Uint8Array> => {
  const bytes = await client.file(validateObjectKey(key)).bytes();
  return bytes;
};

export const streamObject = (key: string): ReadableStream<Uint8Array> =>
  client.file(validateObjectKey(key)).stream();

export const objectExists = (key: string): Promise<boolean> =>
  client.exists(validateObjectKey(key));

export const deleteObject = async (key: string): Promise<void> => {
  await client.delete(validateObjectKey(key));
};
