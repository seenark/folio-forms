// oxlint-disable func-style prefer-destructuring no-await-in-loop no-use-before-define no-nested-ternary complexity no-shadow -- Route modules keep declaration order and sequential persistence invariants.
import { createHash, createHmac } from "node:crypto";
import path from "node:path";

import { cors } from "@elysiajs/cors";
import { auth } from "@onlyoffice/auth";
import type { OperationType } from "@onlyoffice/db";
import {
  FieldType,
  FormStatus,
  OperationStatus,
  OperationTargetType,
  PrefillPolicy,
  Prisma,
  ResponseStatus,
  prisma,
} from "@onlyoffice/db";
import { env } from "@onlyoffice/env/server";
import { Elysia } from "elysia";
import { unzipSync } from "fflate";

import {
  callbackOperationId,
  createCallbackUserdata,
  createOnlyOfficeClient,
  editorConfig,
  pluginGuid,
  verifyDocumentAccessToken,
} from "./onlyoffice";
import type { OnlyOfficeClient } from "./onlyoffice";
import {
  DOCX_CONTENT_TYPE,
  deleteObject,
  objectExists,
  objectKey,
  putObject,
  readObject,
  streamObject,
} from "./storage";

type Form = Prisma.FormGetPayload<Prisma.FormDefaultArgs>;
type Operation = Prisma.OperationGetPayload<Prisma.OperationDefaultArgs>;
type PrefillSnapshot =
  Prisma.PrefillSnapshotGetPayload<Prisma.PrefillSnapshotDefaultArgs>;
type PublishedTemplate =
  Prisma.PublishedTemplateGetPayload<Prisma.PublishedTemplateDefaultArgs>;
type Response = Prisma.ResponseGetPayload<Prisma.ResponseDefaultArgs>;
type Submission = Prisma.SubmissionGetPayload<Prisma.SubmissionDefaultArgs>;
type TemplateDraft =
  Prisma.TemplateDraftGetPayload<Prisma.TemplateDraftDefaultArgs>;

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const pluginDir = path.resolve(import.meta.dirname, "../../onlyoffice-plugin");
const fallbackTemplatePath = path.resolve(
  import.meta.dirname,
  "../../../onlyoffice-templates/template.docx"
);
const idPattern = /^[0-9a-f-]{36}$/iu;
const operationTimeoutMs = 5 * 60_000;
const maxCallbackDocumentBytes = 25 * 1024 * 1024;
const loginFailureLimit = 5;
const loginFailureWindowMs = 15 * 60_000;
const passwordMinimumLength = 12;
const passwordMaximumLength = 128;
const maxResponseDataBytes = 256 * 1024;
const callbackInternalOrigin = originOf(env.ONLYOFFICE_INTERNAL_URL);
const callbackPublicOrigin = originOf(env.ONLYOFFICE_URL);
const callbackOrigins = new Set(
  [callbackInternalOrigin, callbackPublicOrigin].filter(
    (origin): origin is string => Boolean(origin)
  )
);

type UserRole = "admin" | "user";
interface Identity {
  email: string;
  expiresAt: Date;
  id: string;
  mustChangePassword: boolean;
  name: string;
  role: UserRole;
  sessionId: string;
}

type JsonRecord = Record<string, unknown>;
type OperationAction = "save-template" | "publish" | "save-draft" | "submit";
const operationTypeForAction: Record<OperationAction, OperationType> = {
  publish: "publish_form",
  "save-draft": "save_draft",
  "save-template": "save_template_draft",
  submit: "submit_response",
};
type OperationMetadata = JsonRecord & {
  action: OperationAction;
  cleanupObjectKeys?: string[];
  formId: string;
  responseId?: string;
  submissionId?: string;
  publicId?: string;
  publishedVersion?: number;
  publishedKey?: string;
  submissionDocumentKey?: string;
  stagedObjectKey: string;
  finalObjectKey: string;
  nextDocumentKey?: string;
  data?: JsonRecord;
  result?: JsonRecord;
};

interface OperationCompletion {
  cleanupObjectKeys: string[];
}

type FormWithDocuments = Form & {
  templateDraft: TemplateDraft | null;
  publishedTemplate: PublishedTemplate | null;
};

type ResponseWithSnapshot = Response & {
  prefillSnapshot: PrefillSnapshot | null;
};
interface CallbackPayload {
  key?: unknown;
  status?: unknown;
  url?: unknown;
  userdata?: unknown;
}

export interface AppOptions {
  onlyOffice?: OnlyOfficeClient;
  onlyOfficeCallbackOrigins?: readonly string[];
  requestIp?: (request: Request) => string | null | undefined;
}

class HttpError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = status;
    this.code = code;
  }
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function asRecord(
  value: unknown,
  message = "Request body must be a JSON object"
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_request", message);
  }
  return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, "invalid_request", `${key} is required`);
  }
  return value.trim();
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(400, "invalid_request", `${key} must be a string`);
  }
  return value.trim();
}

function jsonRecord(
  value: unknown,
  message = "data must be a JSON object"
): JsonRecord {
  return asRecord(value, message);
}

function operationMetadata(value: unknown): OperationMetadata {
  const metadata = asRecord(value, "Operation metadata is invalid");
  const { action, cleanupObjectKeys, finalObjectKey, formId, stagedObjectKey } =
    metadata;
  if (
    (action !== "save-template" &&
      action !== "publish" &&
      action !== "save-draft" &&
      action !== "submit") ||
    typeof formId !== "string" ||
    typeof stagedObjectKey !== "string" ||
    typeof finalObjectKey !== "string" ||
    (cleanupObjectKeys !== undefined &&
      (!Array.isArray(cleanupObjectKeys) ||
        cleanupObjectKeys.some((key) => typeof key !== "string")))
  ) {
    fail(500, "invalid_operation", "Operation metadata is invalid");
  }
  return metadata as unknown as OperationMetadata;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Operation failed";
}
function databaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function deleteObjects(
  keys: readonly (string | null | undefined)[]
): Promise<void> {
  const uniqueKeys = [
    ...new Set(
      keys.filter(
        (key): key is string => typeof key === "string" && key.length > 0
      )
    ),
  ];
  await Promise.all(
    uniqueKeys.map(async (key) => {
      try {
        await deleteObject(key);
      } catch (error) {
        console.error(`Could not remove object ${key}`, error);
      }
    })
  );
}

async function deleteObjectUnlessCanonical(key: string): Promise<void> {
  try {
    const references = await Promise.all([
      prisma.templateDraft.findFirst({
        select: { id: true },
        where: { objectKey: key },
      }),
      prisma.publishedTemplate.findFirst({
        select: { id: true },
        where: { objectKey: key },
      }),
      prisma.response.findFirst({
        select: { id: true },
        where: { draftObjectKey: key },
      }),
      prisma.submission.findFirst({
        select: { id: true },
        where: { objectKey: key },
      }),
    ]);
    if (references.every((reference) => reference === null)) {
      await deleteObjects([key]);
    }
  } catch (error) {
    console.error(`Could not verify whether object ${key} is canonical`, error);
  }
}

async function cleanupTerminalOperationObjects(
  operation: Operation
): Promise<void> {
  if (
    operation.status !== OperationStatus.completed &&
    operation.status !== OperationStatus.failed
  ) {
    return;
  }
  const metadata = operationMetadata(operation.metadata);
  if (operation.status === OperationStatus.completed) {
    await deleteObjects(
      metadata.cleanupObjectKeys ?? [metadata.stagedObjectKey]
    );
    return;
  }
  await deleteObjects([metadata.stagedObjectKey]);
  await deleteObjectUnlessCanonical(metadata.finalObjectKey);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function editableFieldsForSnapshot(snapshot: PrefillSnapshot): JsonRecord {
  const lockedFields = jsonRecord(snapshot.lockedFields);
  return Object.fromEntries(
    Object.entries(lockedFields).map(([field, locked]) => [
      field,
      locked !== true,
    ])
  );
}

async function identityFor(request: Request): Promise<Identity | null> {
  if (!bearerTokenFor(request)) {
    return null;
  }
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result?.user || !result.session) {
    return null;
  }
  const sessionUser = result.user as unknown as {
    email?: unknown;
    enabled?: unknown;
    id?: unknown;
    mustChangePassword?: unknown;
    name?: unknown;
    role?: unknown;
  };
  const liveSession = result.session as unknown as {
    expiresAt?: unknown;
    id?: unknown;
  };
  const expiresAt =
    liveSession.expiresAt instanceof Date
      ? liveSession.expiresAt
      : new Date(String(liveSession.expiresAt));
  if (
    typeof sessionUser.id !== "string" ||
    typeof sessionUser.email !== "string" ||
    sessionUser.enabled !== true ||
    typeof liveSession.id !== "string" ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return {
    email: sessionUser.email,
    expiresAt,
    id: sessionUser.id,
    mustChangePassword: sessionUser.mustChangePassword === true,
    name:
      typeof sessionUser.name === "string" && sessionUser.name.length > 0
        ? sessionUser.name
        : sessionUser.email,
    role: sessionUser.role === "admin" ? "admin" : "user",
    sessionId: liveSession.id,
  };
}
function bearerTokenFor(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer\s+(?<token>.+)$/iu.exec(authorization);
  return match?.groups?.token;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function loginDigest(kind: "email" | "ip", value: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`${kind}:${value}`)
    .digest("hex");
}

function loginFailureKey(email: string, sourceIp: string) {
  return {
    emailDigest: loginDigest("email", email),
    ipDigest: loginDigest("ip", sourceIp.trim().toLowerCase() || "unknown"),
  };
}

async function reserveLoginAttempt(
  emailDigest: string,
  ipDigest: string
): Promise<number> {
  const now = new Date();
  await prisma.loginFailure.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const expiresAt = new Date(now.getTime() + loginFailureWindowMs);
  const [failure] = await prisma.$queryRaw<{ attempts: number }[]>`
    INSERT INTO "login_failures" AS "login_failure" (
      "id",
      "email_digest",
      "ip_digest",
      "attempts",
      "window_started_at",
      "expires_at",
      "updated_at"
    )
    VALUES (
      ${crypto.randomUUID()}::uuid,
      ${emailDigest},
      ${ipDigest},
      1,
      ${now},
      ${expiresAt},
      ${now}
    )
    ON CONFLICT ("email_digest", "ip_digest") DO UPDATE SET
      "attempts" = CASE
        WHEN "login_failure"."expires_at" <= ${now} THEN 1
        ELSE "login_failure"."attempts" + 1
      END,
      "window_started_at" = CASE
        WHEN "login_failure"."expires_at" <= ${now} THEN ${now}
        ELSE "login_failure"."window_started_at"
      END,
      "expires_at" = CASE
        WHEN "login_failure"."expires_at" <= ${now} THEN ${expiresAt}
        ELSE "login_failure"."expires_at"
      END,
      "updated_at" = ${now}
    RETURNING "attempts"
  `;
  return failure?.attempts ?? loginFailureLimit + 1;
}

async function clearLoginFailures(
  emailDigest: string,
  ipDigest: string
): Promise<void> {
  await prisma.loginFailure.deleteMany({ where: { emailDigest, ipDigest } });
}

function loginError(
  status: 401 | 429,
  error: "invalid_credentials" | "login_throttled"
): globalThis.Response {
  return Response.json(
    { error, message: "Email or password is invalid" },
    {
      headers: status === 429 ? { "Retry-After": "900" } : undefined,
      status,
    }
  );
}

async function handleEmailSignIn(
  request: Request,
  body: unknown,
  sourceIp: string
): Promise<globalThis.Response> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return loginError(401, "invalid_credentials");
  }
  const input = body as JsonRecord;
  if (typeof input.email !== "string" || typeof input.password !== "string") {
    return loginError(401, "invalid_credentials");
  }
  const email = normalizeEmail(input.email);
  const { emailDigest, ipDigest } = loginFailureKey(email, sourceIp);
  if ((await reserveLoginAttempt(emailDigest, ipDigest)) > loginFailureLimit) {
    return loginError(429, "login_throttled");
  }
  if (
    input.password.length < passwordMinimumLength ||
    input.password.length > passwordMaximumLength
  ) {
    return loginError(401, "invalid_credentials");
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const authResponse = await auth.handler(
    new Request(request.url, {
      body: JSON.stringify({ email, password: input.password }),
      headers,
      method: "POST",
    })
  );
  if (!authResponse.ok) {
    return loginError(401, "invalid_credentials");
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.enabled) {
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
    }
    return loginError(401, "invalid_credentials");
  }

  await clearLoginFailures(emailDigest, ipDigest);
  return authResponse;
}

async function requireIdentity(request: Request): Promise<Identity> {
  const identity = await identityFor(request);
  if (!identity) {
    fail(401, "unauthorized", "Authentication is required");
  }
  if (identity.mustChangePassword) {
    fail(403, "password_change_required", "Password replacement is required");
  }
  return identity;
}

function requireAdmin(identity: Identity): void {
  if (identity.role !== "admin") {
    fail(403, "forbidden", "Administrator access is required");
  }
}

function validateId(value: string, label: string): string {
  if (!idPattern.test(value)) {
    fail(404, "not_found", `${label} was not found`);
  }
  return value;
}

function formSummary(form: FormWithDocuments): JsonRecord {
  const templateDraft = form.templateDraft;
  const publishedTemplate = form.publishedTemplate;
  return {
    createdAt: form.createdAt,
    createdBy: form.createdBy,
    description: form.description,
    hasPublishedDocument: Boolean(publishedTemplate?.objectKey),
    hasTemplateDraft: Boolean(templateDraft?.objectKey),
    id: form.id,
    publicId: form.publicId,
    publishedDocumentKey: publishedTemplate?.documentKey,
    status: form.status,
    templateDocumentKey: templateDraft?.documentKey,
    title: form.title,
    updatedAt: form.updatedAt,
    version: form.version,
  };
}

function responseSummary(
  response: Response,
  extra: {
    formPublicId?: string;
    formTitle?: string;
    submissionId?: string | null;
  } = {}
): JsonRecord {
  return {
    createdAt: response.createdAt,
    formId: response.formId,
    formPublicId: extra.formPublicId,
    formTitle: extra.formTitle,
    hasDraft: Boolean(response.draftObjectKey && response.draftData),
    id: response.id,
    publishedVersion: response.publishedVersion,
    status: response.status,
    submissionId: extra.submissionId,
    updatedAt: response.updatedAt,
    userId: response.userId,
  };
}

function submissionSummary(
  submission: Submission,
  extra: {
    formTitle?: string;
    userEmail?: string;
  } = {}
): JsonRecord {
  return {
    createdAt: submission.createdAt,
    formId: submission.formId,
    formTitle: extra.formTitle,
    id: submission.id,
    responseId: submission.responseId,
    status: "submitted",
    userEmail: extra.userEmail,
    userId: submission.userId,
  };
}

async function findTemplateSource(): Promise<string | null> {
  const configuredSource = Bun.file(env.TEMPLATE_PATH);
  if (await configuredSource.exists()) {
    return env.TEMPLATE_PATH;
  }
  const fallbackSource = Bun.file(fallbackTemplatePath);
  return (await fallbackSource.exists()) ? fallbackTemplatePath : null;
}
function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}
function callbackDocumentUrl(
  value: unknown,
  allowedOrigins: ReadonlySet<string> = callbackOrigins
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    let url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !allowedOrigins.has(url.origin)
    ) {
      return null;
    }
    if (
      callbackPublicOrigin &&
      callbackInternalOrigin &&
      callbackPublicOrigin !== callbackInternalOrigin &&
      url.origin === callbackPublicOrigin
    ) {
      url = new URL(
        `${url.pathname}${url.search}${url.hash}`,
        callbackInternalOrigin
      );
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readCallbackDocument(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(
      `Failed to download ONLYOFFICE document: HTTP ${response.status}`
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > maxCallbackDocumentBytes
  ) {
    throw new Error("ONLYOFFICE document callback payload is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxCallbackDocumentBytes) {
    throw new Error("ONLYOFFICE document callback payload is too large");
  }
  return bytes;
}

function validateTemplateControls(bytes: Uint8Array): string[] {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    fail(
      422,
      "invalid_template",
      "The template is not a readable DOCX archive"
    );
  }

  const controls: string[] = [];
  const sdtPrPattern = /<w:sdtPr\b[\s\S]*?<\/w:sdtPr>/gu;
  const tagPattern =
    /<w:tag\b[^>]*\bw:val\s*=\s*(?<quote>['"])(?<tag>.*?)\k<quote>[^>]*\/?>/u;

  for (const [archivePath, content] of Object.entries(archive)) {
    if (!archivePath.startsWith("word/") || !archivePath.endsWith(".xml")) {
      continue;
    }
    const xml = new TextDecoder().decode(content);
    for (const properties of xml.matchAll(sdtPrPattern)) {
      const [propertyXml] = properties;
      const tag = tagPattern.exec(propertyXml)?.groups?.tag;
      if (!tag?.trim()) {
        fail(422, "invalid_template", "Every content control must have a tag");
      }
      controls.push(decodeXmlAttribute(tag.trim()));
    }
  }

  if (controls.length === 0) {
    fail(
      422,
      "invalid_template",
      "The template must contain at least one tagged content control"
    );
  }
  const duplicates = controls.filter(
    (tag, index) => controls.indexOf(tag) !== index
  );
  if (duplicates.length > 0) {
    fail(
      422,
      "invalid_template",
      `Content control tags must be unique: ${[...new Set(duplicates)].join(", ")}`
    );
  }
  return controls;
}
async function normalizeResponseData(
  form: FormWithDocuments,
  response: ResponseWithSnapshot,
  inputData: unknown
): Promise<JsonRecord> {
  const data = { ...jsonRecord(inputData) };
  const serialized = JSON.stringify(data);
  if (serialized.length > maxResponseDataBytes) {
    fail(413, "response_too_large", "Response data exceeds the size limit");
  }
  const publishedTemplate = form.publishedTemplate;
  if (!publishedTemplate?.objectKey) {
    fail(409, "not_published", "This form has not been published");
  }
  const templateBytes = await readObject(publishedTemplate.objectKey);
  const controls = new Set(validateTemplateControls(templateBytes));
  const unknownFields = Object.keys(data).filter(
    (field) => !controls.has(field)
  );
  if (unknownFields.length > 0) {
    fail(
      422,
      "invalid_response_data",
      `Unknown form field(s): ${unknownFields.join(", ")}`
    );
  }
  for (const [field, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    ) {
      fail(422, "invalid_response_data", `${field} must be a scalar value`);
    }
  }
  const snapshot = response.prefillSnapshot;
  if (!snapshot) {
    return data;
  }
  const snapshotData = jsonRecord(snapshot.values);
  const lockedFields = jsonRecord(snapshot.lockedFields);
  for (const [field, value] of Object.entries(snapshotData)) {
    if (lockedFields[field] === true) {
      data[field] = value;
    }
  }
  return data;
}

async function activeOperationForForm(
  formId: string,
  action: OperationType
): Promise<boolean> {
  const operation = await prisma.operation.findFirst({
    select: { id: true },
    where: {
      formId,
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
      type: action,
    },
  });
  return Boolean(operation);
}

async function activeOperationForResponse(
  responseId: string
): Promise<boolean> {
  const operation = await prisma.operation.findFirst({
    select: { id: true },
    where: {
      responseId,
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
    },
  });
  return Boolean(operation);
}

function createOperation(input: {
  type: OperationType;
  targetType: OperationTargetType;
  targetId: string;
  formId: string;
  actorId: string;
  ownerUserId: string;
  responseId?: string;
  submissionId?: string;
  documentKey: string;
  stagingObjectKey: string;
  metadata: OperationMetadata;
}): Promise<Operation> {
  return prisma.operation.create({
    data: {
      actorId: input.actorId,
      documentKey: input.documentKey,
      errorCode: null,
      formId: input.formId,
      metadata: jsonValue(input.metadata),
      ownerUserId: input.ownerUserId,
      responseId: input.responseId,
      stagingObjectKey: input.stagingObjectKey,
      status: OperationStatus.pending,
      submissionId: input.submissionId,
      targetId: input.targetId,
      targetType: input.targetType,
      type: input.type,
    },
  });
}

async function updateOperationFailed(
  operationId: string,
  message: string
): Promise<void> {
  const operation = await prisma.operation.findUnique({
    select: { metadata: true, stagingObjectKey: true },
    where: { id: operationId },
  });
  const failed = await prisma.operation.updateMany({
    data: {
      errorCode: message,
      status: OperationStatus.failed,
      updatedAt: new Date(),
    },
    where: {
      id: operationId,
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
    },
  });
  if (failed.count === 1 && operation) {
    const metadata = operationMetadata(operation.metadata);
    await deleteObjects([operation.stagingObjectKey, metadata.finalObjectKey]);
  }
}

async function expireOperationIfNeeded(
  operation: Operation
): Promise<Operation> {
  const active =
    operation.status === OperationStatus.pending ||
    operation.status === OperationStatus.processing;
  const stale =
    Date.now() - operation.updatedAt.getTime() >= operationTimeoutMs;
  if (!active || !stale) {
    return operation;
  }

  const message = "The document operation timed out. Try again.";
  await updateOperationFailed(operation.id, message);
  const metadata = operationMetadata(operation.metadata);
  if (metadata.action === "submit" && metadata.responseId) {
    await rollbackSubmit(metadata.responseId);
  }
  return { ...operation, errorCode: message, status: OperationStatus.failed };
}

async function rollbackSubmit(responseId: string): Promise<void> {
  await prisma.response.updateMany({
    data: { status: ResponseStatus.draft, updatedAt: new Date() },
    where: { id: responseId, status: ResponseStatus.submitting },
  });
}

function launchForceSave(
  operation: Operation,
  onlyOffice: OnlyOfficeClient,
  allowedCallbackOrigins: ReadonlySet<string>
): void {
  void (async () => {
    try {
      if (!operation.documentKey) {
        fail(500, "invalid_operation", "Operation has no document key");
      }
      const claimed = await prisma.operation.updateMany({
        data: { status: OperationStatus.processing, updatedAt: new Date() },
        where: { id: operation.id, status: OperationStatus.pending },
      });
      if (claimed.count !== 1) {
        return;
      }
      const hasChanges = await onlyOffice.forceSave(
        operation.documentKey,
        createCallbackUserdata(operation.id)
      );
      if (!hasChanges) {
        const currentObjectKey = await operationDocumentKey(
          operation.documentKey
        );
        if (!currentObjectKey) {
          fail(
            500,
            "document_unavailable",
            "The current document snapshot is unavailable"
          );
        }
        await finalizeCallback(
          operation.id,
          { key: operation.documentKey, status: 6 },
          await readObject(currentObjectKey),
          allowedCallbackOrigins
        );
      }
    } catch (error) {
      const metadata = operationMetadata(operation.metadata);
      await updateOperationFailed(operation.id, errorMessage(error));
      if (metadata.action === "submit" && metadata.responseId) {
        await rollbackSubmit(metadata.responseId);
      }
    }
  })();
}

async function operationDocumentKey(
  documentKey: string
): Promise<string | null> {
  const pending = await prisma.operation.findMany({
    orderBy: { updatedAt: "desc" },
    select: { metadata: true },
    take: 10,
    where: {
      documentKey,
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
    },
  });
  for (const operation of pending) {
    const metadata = operationMetadata(operation.metadata);
    if (await objectExists(metadata.stagedObjectKey)) {
      return metadata.stagedObjectKey;
    }
  }

  const templateDraft = await prisma.templateDraft.findUnique({
    where: { documentKey },
  });
  if (templateDraft) {
    return templateDraft.objectKey;
  }
  const publishedTemplate = await prisma.publishedTemplate.findUnique({
    where: { documentKey },
  });
  if (publishedTemplate) {
    return publishedTemplate.objectKey;
  }
  const response = await prisma.response.findUnique({
    select: { draftObjectKey: true },
    where: { draftDocumentKey: documentKey },
  });
  if (response?.draftObjectKey) {
    return response.draftObjectKey;
  }
  const submission = await prisma.submission.findUnique({
    select: { objectKey: true },
    where: { documentKey },
  });
  return submission?.objectKey ?? null;
}

async function markOperationCompleted(
  tx: Prisma.TransactionClient,
  operationId: string,
  result: JsonRecord,
  metadata: OperationMetadata,
  cleanupObjectKeys: string[],
  submissionId?: string
): Promise<void> {
  const completed = await tx.operation.updateMany({
    data: {
      errorCode: null,
      metadata: jsonValue({ ...metadata, cleanupObjectKeys }),
      result: jsonValue(result),
      status: OperationStatus.completed,
      ...(submissionId ? { submissionId } : {}),
      updatedAt: new Date(),
    },
    where: { id: operationId, status: OperationStatus.processing },
  });
  if (completed.count !== 1) {
    fail(409, "stale_operation", "The document operation is no longer active");
  }
}

async function completeTemplateOperation(
  operation: Operation,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<OperationCompletion> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Template operation has no document key");
  }
  const form = await prisma.form.findUnique({
    include: { templateDraft: true },
    where: { id: metadata.formId },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  const templateDraft = form.templateDraft;
  if (!templateDraft || templateDraft.documentKey !== documentKey) {
    fail(
      409,
      "stale_operation",
      "The template changed while this operation was running"
    );
  }
  const nextDocumentKey = metadata.nextDocumentKey ?? documentKey;
  const result = { documentKey: nextDocumentKey, formId: form.id };
  const cleanupObjectKeys = [metadata.stagedObjectKey, templateDraft.objectKey];
  await prisma.$transaction(
    async (tx) => {
      const updated = await tx.templateDraft.updateMany({
        data: {
          contentHash: contentHash(bytes),
          documentKey: nextDocumentKey,
          objectKey: metadata.finalObjectKey,
          updatedAt: new Date(),
        },
        where: { documentKey, id: templateDraft.id },
      });
      if (updated.count !== 1) {
        fail(
          409,
          "stale_operation",
          "The template changed while this operation was running"
        );
      }
      await markOperationCompleted(
        tx,
        operation.id,
        result,
        metadata,
        cleanupObjectKeys
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}

async function completePublishOperation(
  operation: Operation,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<OperationCompletion> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Publish operation has no document key");
  }
  const form = await prisma.form.findUnique({
    include: { templateDraft: true },
    where: { id: metadata.formId },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  if (!form.templateDraft || form.templateDraft.documentKey !== documentKey) {
    fail(409, "stale_operation", "The template changed while publishing");
  }
  const { publishedVersion, publishedKey } = metadata;
  if (
    typeof publishedVersion !== "number" ||
    typeof publishedKey !== "string"
  ) {
    fail(500, "invalid_operation", "Publish metadata is incomplete");
  }
  const controls = validateTemplateControls(bytes);
  const previousPublished = await prisma.publishedTemplate.findUnique({
    select: { objectKey: true },
    where: { formId: form.id },
  });
  const hash = contentHash(bytes);
  const result = {
    documentKey: publishedKey,
    formId: form.id,
    publicId: form.publicId,
    version: publishedVersion,
  };
  const cleanupObjectKeys = [
    metadata.stagedObjectKey,
    ...(previousPublished ? [previousPublished.objectKey] : []),
  ];
  await prisma.$transaction(
    async (tx) => {
      await tx.publishedTemplate.create({
        data: {
          contentHash: hash,
          documentKey: publishedKey,
          form: { connect: { id: form.id } },
          id: crypto.randomUUID(),
          manifest: {
            create: {
              configurationHash: hash,
              fields: {
                create: controls.map((tag) => ({
                  prefillPolicy: PrefillPolicy.editable,
                  required: false,
                  tag,
                  type: FieldType.text,
                })),
              },
            },
          },
          objectKey: metadata.finalObjectKey,
          version: publishedVersion,
        },
      });
      const updated = await tx.form.updateMany({
        data: {
          status: FormStatus.published,
          updatedAt: new Date(),
          version: publishedVersion,
        },
        where: {
          id: form.id,
          status: { in: [FormStatus.draft, FormStatus.published] },
          version: form.version,
        },
      });
      if (updated.count !== 1) {
        fail(409, "stale_operation", "The form changed while publishing");
      }
      await markOperationCompleted(
        tx,
        operation.id,
        result,
        metadata,
        cleanupObjectKeys
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}

async function completeDraftOperation(
  operation: Operation,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<OperationCompletion> {
  void bytes;
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Draft operation has no document key");
  }
  if (!metadata.responseId || !metadata.data) {
    fail(500, "invalid_operation", "Draft metadata is incomplete");
  }
  const response = await prisma.response.findUnique({
    where: { id: metadata.responseId },
  });
  if (
    !response ||
    response.status !== ResponseStatus.draft ||
    response.draftDocumentKey !== documentKey
  ) {
    fail(409, "stale_operation", "The response is no longer editable");
  }
  const result = { formId: response.formId, responseId: response.id };
  const cleanupObjectKeys = [
    metadata.stagedObjectKey,
    ...(response.draftObjectKey ? [response.draftObjectKey] : []),
  ];
  await prisma.$transaction(
    async (tx) => {
      const updated = await tx.response.updateMany({
        data: {
          draftData: jsonValue(metadata.data),
          draftObjectKey: metadata.finalObjectKey,
          updatedAt: new Date(),
        },
        where: {
          draftDocumentKey: documentKey,
          id: response.id,
          status: ResponseStatus.draft,
        },
      });
      if (updated.count !== 1) {
        fail(409, "stale_operation", "The response is no longer editable");
      }
      await markOperationCompleted(
        tx,
        operation.id,
        result,
        metadata,
        cleanupObjectKeys
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}

async function completeSubmitOperation(
  operation: Operation,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<OperationCompletion> {
  void bytes;
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Submit operation has no document key");
  }
  if (!metadata.responseId || !metadata.submissionId || !metadata.data) {
    fail(500, "invalid_operation", "Submit metadata is incomplete");
  }
  const { responseId, submissionId, data } = metadata;
  const response = await prisma.response.findUnique({
    where: { id: responseId },
  });
  if (
    !response ||
    response.status !== ResponseStatus.submitting ||
    response.draftDocumentKey !== documentKey
  ) {
    fail(
      409,
      "stale_operation",
      "The response is no longer pending submission"
    );
  }

  const submissionDocumentKey = metadata.submissionDocumentKey ?? documentKey;
  const result = {
    formId: response.formId,
    responseId: response.id,
    submissionId,
  };
  const cleanupObjectKeys = [
    metadata.stagedObjectKey,
    ...(response.draftObjectKey ? [response.draftObjectKey] : []),
  ];
  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.operation.updateMany({
        data: { updatedAt: new Date() },
        where: { id: operation.id, status: OperationStatus.processing },
      });
      if (claimed.count !== 1) {
        fail(
          409,
          "stale_operation",
          "The submission operation is no longer active"
        );
      }
      await tx.submission.create({
        data: {
          data: jsonValue(data),
          documentKey: submissionDocumentKey,
          form: { connect: { id: response.formId } },
          id: submissionId,
          objectKey: metadata.finalObjectKey,
          owner: { connect: { id: response.userId } },
          response: { connect: { id: response.id } },
        },
      });
      const updatedResponse = await tx.response.updateMany({
        data: {
          draftData: Prisma.DbNull,
          draftDocumentKey: null,
          draftObjectKey: null,
          status: ResponseStatus.submitted,
          updatedAt: new Date(),
        },
        where: { id: response.id, status: ResponseStatus.submitting },
      });
      if (updatedResponse.count !== 1) {
        fail(
          409,
          "stale_operation",
          "The response is no longer pending submission"
        );
      }
      await markOperationCompleted(
        tx,
        operation.id,
        result,
        metadata,
        cleanupObjectKeys,
        submissionId
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}

async function finalizeCallback(
  operationId: string,
  payload: CallbackPayload,
  snapshot: Uint8Array | undefined,
  allowedCallbackOrigins: ReadonlySet<string>
): Promise<void> {
  const operation = await prisma.operation.findUnique({
    where: { id: operationId },
  });
  if (!operation) {
    return;
  }
  if (
    operation.status === OperationStatus.completed ||
    operation.status === OperationStatus.failed
  ) {
    await cleanupTerminalOperationObjects(operation);
    return;
  }
  const metadata = operationMetadata(operation.metadata);
  const callbackUrl = callbackDocumentUrl(payload.url, allowedCallbackOrigins);
  if (
    typeof payload.key !== "string" ||
    payload.key !== operation.documentKey
  ) {
    await updateOperationFailed(
      operation.id,
      "ONLYOFFICE callback key did not match the initiating operation"
    );
    if (metadata.action === "submit" && metadata.responseId) {
      await rollbackSubmit(metadata.responseId);
    }
    return;
  }
  if (!snapshot && !callbackUrl) {
    await updateOperationFailed(
      operation.id,
      "ONLYOFFICE callback did not include an allowed document URL"
    );
    if (metadata.action === "submit" && metadata.responseId) {
      await rollbackSubmit(metadata.responseId);
    }
    return;
  }

  let bytes = snapshot;
  if (!bytes) {
    if (!callbackUrl) {
      throw new Error("ONLYOFFICE callback document URL is unavailable");
    }
    bytes = await readCallbackDocument(callbackUrl);
  }
  const claimed = await prisma.operation.updateMany({
    data: { status: OperationStatus.processing, updatedAt: new Date() },
    where: {
      id: operation.id,
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
    },
  });
  if (claimed.count !== 1) {
    return;
  }

  let completion: OperationCompletion | undefined;
  try {
    await putObject(metadata.stagedObjectKey, bytes, DOCX_CONTENT_TYPE);
    await putObject(metadata.finalObjectKey, bytes, DOCX_CONTENT_TYPE);

    if (metadata.action === "save-template") {
      completion = await completeTemplateOperation(operation, metadata, bytes);
    } else if (metadata.action === "publish") {
      completion = await completePublishOperation(operation, metadata, bytes);
    } else if (metadata.action === "save-draft") {
      completion = await completeDraftOperation(operation, metadata, bytes);
    } else {
      completion = await completeSubmitOperation(operation, metadata, bytes);
    }
  } catch (error) {
    await deleteObjects([metadata.stagedObjectKey]);
    await deleteObjectUnlessCanonical(metadata.finalObjectKey);
    throw error;
  }

  await deleteObjects(completion?.cleanupObjectKeys ?? []);
}

async function findFormById(id: string): Promise<FormWithDocuments> {
  validateId(id, "Form");
  const form = await prisma.form.findUnique({
    include: { publishedTemplate: true, templateDraft: true },
    where: { id },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  return form;
}

async function findFormByPublicId(
  publicId: string
): Promise<FormWithDocuments> {
  if (!publicId || publicId.length > 128) {
    fail(404, "not_found", "Form was not found");
  }
  const form = await prisma.form.findUnique({
    include: { publishedTemplate: true, templateDraft: true },
    where: { publicId },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  return form;
}

async function findOwnedResponse(
  responseId: string,
  formId: string,
  userId: string
): Promise<ResponseWithSnapshot> {
  validateId(responseId, "Response");
  const response = await prisma.response.findFirst({
    include: { prefillSnapshot: true },
    where: { formId, id: responseId, userId },
  });
  if (!response) {
    fail(404, "not_found", "Response was not found");
  }
  return response;
}

function canReadSubmission(identity: Identity, submission: Submission): void {
  if (identity.role === "admin") {
    return;
  }
  if (submission.userId !== identity.id) {
    fail(403, "forbidden", "You may only access your own submission");
  }
}

async function userEditorConfig(
  form: FormWithDocuments,
  identity: Identity,
  responseId: string | undefined,
  requestedAction?: string,
  authToken?: string
): Promise<Record<string, unknown>> {
  const publishedTemplate = form.publishedTemplate;
  if (!publishedTemplate?.objectKey || !publishedTemplate.documentKey) {
    fail(409, "not_published", "This form has no published document");
  }
  const response = responseId
    ? await prisma.response.findFirst({
        include: { prefillSnapshot: true },
        where: {
          formId: form.id,
          id: responseId,
          userId: identity.id,
        },
      })
    : await prisma.response.findFirst({
        include: { prefillSnapshot: true },
        where: { formId: form.id, userId: identity.id },
      });
  if (!response) {
    fail(404, "not_found", "Start a response before opening the editor");
  }
  if (response.status === ResponseStatus.submitted) {
    fail(409, "already_submitted", "This response has already been submitted");
  }
  if (!response.draftDocumentKey || !response.draftObjectKey) {
    fail(409, "document_unavailable", "Response document is unavailable");
  }
  if (!(await objectExists(response.draftObjectKey))) {
    fail(
      409,
      "document_unavailable",
      "Response document artifact is unavailable"
    );
  }
  const snapshot = response.prefillSnapshot;
  return editorConfig(
    {
      action:
        requestedAction === "submit"
          ? "submit"
          : requestedAction === "fill"
            ? "fill"
            : "draft",
      authToken,
      documentKey: response.draftDocumentKey,
      formId: form.id,
      prefill:
        requestedAction === "fill" && snapshot
          ? {
              data: jsonRecord(snapshot.values),
              editableFields: editableFieldsForSnapshot(snapshot),
            }
          : undefined,
      publicId: form.publicId,
      responseId: response.id,
    },
    identity
  );
}

export function createApp(options: AppOptions = {}) {
  const onlyOffice = options.onlyOffice ?? createOnlyOfficeClient();
  const allowedCallbackOrigins = options.onlyOfficeCallbackOrigins
    ? new Set(options.onlyOfficeCallbackOrigins)
    : callbackOrigins;
  const callbackClaims = new Set<string>();
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof HttpError) {
        set.status = error.httpStatus;
        return Response.json({
          error: error.code,
          message: error.message,
        });
      }
      if (databaseErrorCode(error) === "P2002") {
        set.status = 409;
        return Response.json({
          error: "operation_conflict",
          message: "Another operation is already in progress",
        });
      }
      console.error(error);
      set.status = 500;
      return Response.json({
        error: "internal_error",
        message: "An unexpected server error occurred",
      });
    })
    .use(
      cors({
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        origin: env.CORS_ORIGIN,
      })
    )
    .post("/api/auth/sign-in/email", ({ body, request, server }) => {
      const sourceIp =
        options.requestIp?.(request) ??
        server?.requestIP(request)?.address ??
        "unknown";
      return handleEmailSignIn(request, body, sourceIp);
    })
    .get("/api/session", async ({ request }) => {
      const identity = await identityFor(request);
      if (!identity) {
        fail(401, "unauthorized", "Authentication is required");
      }
      return {
        session: { expiresAt: identity.expiresAt },
        user: {
          email: identity.email,
          id: identity.id,
          mustChangePassword: identity.mustChangePassword,
          name: identity.name,
          role: identity.role,
        },
      };
    })
    .post("/api/account/password", async ({ body, request }) => {
      const identity = await identityFor(request);
      if (!identity) {
        fail(401, "unauthorized", "Authentication is required");
      }
      const input = asRecord(body);
      const { currentPassword, newPassword } = input;
      if (
        typeof currentPassword !== "string" ||
        typeof newPassword !== "string"
      ) {
        fail(
          400,
          "invalid_request",
          "currentPassword and newPassword are required"
        );
      }
      if (newPassword.length < passwordMinimumLength) {
        fail(
          400,
          "password_too_short",
          `Password must contain at least ${passwordMinimumLength} characters`
        );
      }
      if (newPassword.length > passwordMaximumLength) {
        fail(
          400,
          "password_too_long",
          `Password must contain at most ${passwordMaximumLength} characters`
        );
      }
      if (
        currentPassword.length < passwordMinimumLength ||
        currentPassword.length > passwordMaximumLength
      ) {
        fail(400, "invalid_current_password", "Current password is invalid");
      }
      const authContext = await auth.$context;

      const account = await prisma.account.findFirst({
        where: { providerId: "credential", userId: identity.id },
      });
      const currentHash = account?.password;
      if (
        !account ||
        !currentHash ||
        !(await authContext.password.verify({
          hash: currentHash,
          password: currentPassword,
        }))
      ) {
        fail(400, "invalid_current_password", "Current password is invalid");
      }

      const passwordHash = await authContext.password.hash(newPassword);
      await prisma.$transaction(async (tx) => {
        const update = await tx.account.updateMany({
          data: { password: passwordHash },
          where: { id: account.id, password: currentHash },
        });
        if (update.count !== 1) {
          fail(409, "credential_changed", "Credential changed concurrently");
        }
        await tx.user.update({
          data: { mustChangePassword: false },
          where: { id: identity.id },
        });
        await tx.session.deleteMany({ where: { userId: identity.id } });
      });
      return { ok: true };
    })
    .post("/api/auth/sign-out", async ({ request }) => {
      const identity = await identityFor(request);
      if (identity) {
        await prisma.session.deleteMany({ where: { id: identity.sessionId } });
      }
      return { ok: true };
    })
    .all("/api/auth/*", () =>
      Response.json(
        { error: "not_found", message: "Authentication route was not found" },
        { status: 404 }
      )
    )
    .get("/health", () => ({ ok: true }))
    .get("/api/admin/forms", async ({ request }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const items = await prisma.form.findMany({
        include: {
          _count: { select: { submissions: true } },
          publishedTemplate: true,
          templateDraft: true,
        },
        orderBy: { updatedAt: "desc" },
      });
      return {
        forms: items.map((item) => ({
          ...formSummary(item),
          submissionCount: item._count.submissions,
        })),
      };
    })
    .delete("/api/admin/forms/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const formId = validateId(params.id, "Form");
      const { objectKeys: objectKeysToDelete } = await prisma.$transaction(
        async (tx) => {
          const form = await tx.form.findUnique({
            where: { id: formId },
          });
          if (!form) {
            fail(404, "not_found", "Form was not found");
          }
          if (form.status !== FormStatus.draft || form.version > 0) {
            fail(
              409,
              "form_not_draft",
              "Only unpublished draft forms can be removed"
            );
          }

          const activeOperations = await tx.operation.findMany({
            select: { id: true, updatedAt: true },
            where: {
              formId: form.id,
              status: {
                in: [OperationStatus.pending, OperationStatus.processing],
              },
            },
          });
          const staleOperationIds = new Set<string>();
          const now = Date.now();
          for (const operation of activeOperations) {
            if (now - operation.updatedAt.getTime() < operationTimeoutMs) {
              continue;
            }
            staleOperationIds.add(operation.id);
            await tx.operation.updateMany({
              data: {
                errorCode: "The document operation timed out. Try again.",
                status: OperationStatus.failed,
                updatedAt: new Date(),
              },
              where: {
                id: operation.id,
                status: {
                  in: [OperationStatus.pending, OperationStatus.processing],
                },
              },
            });
          }
          if (activeOperations.some(({ id }) => !staleOperationIds.has(id))) {
            fail(
              409,
              "operation_in_progress",
              "Wait for the draft operation to finish before removing this form"
            );
          }

          if ((await tx.response.count({ where: { formId: form.id } })) > 0) {
            fail(
              409,
              "form_has_responses",
              "A form with responses cannot be removed"
            );
          }
          if (
            (await tx.prefillSnapshot.count({
              where: { formId: form.id },
            })) > 0 ||
            (await tx.submission.count({ where: { formId: form.id } })) > 0
          ) {
            fail(
              409,
              "form_has_responses",
              "A form with responses cannot be removed"
            );
          }

          const templateDraft = await tx.templateDraft.findUnique({
            select: { objectKey: true },
            where: { formId: form.id },
          });
          const formOperations = await tx.operation.findMany({
            select: { metadata: true, stagingObjectKey: true },
            where: { formId: form.id },
          });
          const objectKeys = [
            templateDraft?.objectKey,
            ...formOperations.flatMap((operation) => {
              const metadata = asRecord(operation.metadata);
              return [
                operation.stagingObjectKey,
                typeof metadata.finalObjectKey === "string"
                  ? metadata.finalObjectKey
                  : undefined,
              ];
            }),
          ];
          await tx.operation.deleteMany({ where: { formId: form.id } });
          const deleted = await tx.form.deleteMany({
            where: { id: form.id, status: FormStatus.draft },
          });
          if (deleted.count !== 1) {
            fail(409, "form_not_draft", "Only draft forms can be removed");
          }
          return { objectKeys };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      await deleteObjects(objectKeysToDelete);
      return { deleted: true, formId };
    })
    .post("/api/admin/forms", async ({ request, body }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const input = asRecord(body);
      const title = requiredString(input, "title");
      const description = optionalString(input, "description") ?? "";
      if (title.length > 200 || description.length > 2000) {
        fail(400, "invalid_request", "Title or description is too long");
      }

      const id = crypto.randomUUID();
      const publicId = crypto.randomUUID().replaceAll("-", "");
      const sourcePath = await findTemplateSource();
      const templateBytes = sourcePath
        ? await readTemplateSourceBytes(sourcePath)
        : undefined;
      const templateObjectKey = sourcePath
        ? objectKey("forms", id, "template-draft", crypto.randomUUID(), "docx")
        : undefined;
      const templateDocumentKey = sourcePath
        ? `form-${id}-draft-${crypto.randomUUID()}`
        : undefined;
      try {
        if (templateBytes && templateObjectKey) {
          await putObject(templateObjectKey, templateBytes, DOCX_CONTENT_TYPE);
        }
        const form = await prisma.form.create({
          data: {
            creator: { connect: { id: identity.id } },
            description,
            id,
            publicId,
            title,
            ...(templateBytes && templateObjectKey && templateDocumentKey
              ? {
                  templateDraft: {
                    create: {
                      contentHash: contentHash(templateBytes),
                      documentKey: templateDocumentKey,
                      objectKey: templateObjectKey,
                    },
                  },
                }
              : {}),
          },
          include: { publishedTemplate: true, templateDraft: true },
        });
        return {
          form: formSummary(form),
          templateAvailable: Boolean(sourcePath),
        };
      } catch (error) {
        if (templateObjectKey) {
          await deleteObjectUnlessCanonical(templateObjectKey);
        }
        throw error;
      }
    })
    .get("/api/admin/forms/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormById(params.id);
      const activeDraftCount = await prisma.response.count({
        where: { formId: form.id, status: ResponseStatus.draft },
      });
      return {
        editorConfigUrl: `/api/admin/forms/${form.id}/editor-config`,
        form: { ...formSummary(form), activeDraftCount },
      };
    })
    .get("/api/admin/forms/:id/editor-config", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormById(params.id);
      const templateDraft = form.templateDraft;
      if (!templateDraft) {
        fail(
          409,
          "document_unavailable",
          "No template DOCX is configured; provide TEMPLATE_PATH or upload a template"
        );
      }
      if (!(await objectExists(templateDraft.objectKey))) {
        fail(
          409,
          "document_unavailable",
          "The template DOCX artifact is unavailable"
        );
      }
      return editorConfig(
        {
          action: "template-edit",
          authToken: bearerTokenFor(request),
          documentKey: templateDraft.documentKey,
          formId: form.id,
        },
        identity
      );
    })
    .post(
      "/api/admin/forms/:id/save",
      async ({ request, params, body, set }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const form = await findFormById(params.id);
        const templateDraft = form.templateDraft;
        if (!templateDraft) {
          fail(409, "document_unavailable", "No template DOCX is configured");
        }
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
        if (templateDraft.documentKey !== documentKey) {
          fail(
            409,
            "stale_document",
            "The editor document is no longer current"
          );
        }
        if (
          await activeOperationForForm(
            form.id,
            operationTypeForAction["save-template"]
          )
        ) {
          fail(
            409,
            "operation_in_progress",
            "A template save is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const nextDocumentKey = `form-${form.id}-draft-${crypto.randomUUID()}`;
        const stagedObjectKey = objectKey(
          "operations",
          operationId,
          "template",
          crypto.randomUUID(),
          "docx"
        );
        const metadata: OperationMetadata = {
          action: "save-template",
          finalObjectKey: objectKey(
            "forms",
            form.id,
            "template-draft",
            crypto.randomUUID(),
            "docx"
          ),
          formId: form.id,
          nextDocumentKey,
          result: { documentKey: nextDocumentKey },
          stagedObjectKey,
        };
        const operation = await createOperation({
          actorId: identity.id,
          documentKey,
          formId: form.id,
          metadata,
          ownerUserId: identity.id,
          stagingObjectKey: stagedObjectKey,
          targetId: templateDraft.id,
          targetType: OperationTargetType.template_draft,
          type: operationTypeForAction["save-template"],
        });
        set.status = 202;
        launchForceSave(operation, onlyOffice, allowedCallbackOrigins);
        return { operationId: operation.id, status: operation.status };
      }
    )
    .post(
      "/api/admin/forms/:id/publish",
      async ({ request, params, body, set }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const form = await findFormById(params.id);
        const templateDraft = form.templateDraft;
        if (!templateDraft) {
          fail(409, "document_unavailable", "No template DOCX is configured");
        }
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
        if (templateDraft.documentKey !== documentKey) {
          fail(
            409,
            "stale_document",
            "The editor document is no longer current"
          );
        }
        if (
          await activeOperationForForm(form.id, operationTypeForAction.publish)
        ) {
          fail(
            409,
            "operation_in_progress",
            "A publish operation is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const version = form.version + 1;
        const publishedKey = `form-${form.id}-published-${version}-${crypto.randomUUID()}`;
        const stagedObjectKey = objectKey(
          "operations",
          operationId,
          "published",
          crypto.randomUUID(),
          "docx"
        );
        const metadata: OperationMetadata = {
          action: "publish",
          finalObjectKey: objectKey(
            "forms",
            form.id,
            "published",
            String(version),
            crypto.randomUUID(),
            "docx"
          ),
          formId: form.id,
          publishedKey,
          publishedVersion: version,
          stagedObjectKey,
        };
        const operation = await createOperation({
          actorId: identity.id,
          documentKey,
          formId: form.id,
          metadata,
          ownerUserId: identity.id,
          stagingObjectKey: stagedObjectKey,
          targetId: templateDraft.id,
          targetType: OperationTargetType.template_draft,
          type: operationTypeForAction.publish,
        });
        set.status = 202;
        launchForceSave(operation, onlyOffice, allowedCallbackOrigins);
        return { operationId: operation.id, status: operation.status };
      }
    )
    .get("/api/admin/forms/:id/submissions", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormById(params.id);
      const submissions = await prisma.submission.findMany({
        include: { form: true, owner: true },
        orderBy: { createdAt: "desc" },
        where: { formId: form.id },
      });
      return {
        submissions: submissions.map((submission) =>
          submissionSummary(submission, {
            formTitle: submission.form.title,
            userEmail: submission.owner.email,
          })
        ),
      };
    })
    .get("/api/forms/:publicId", async ({ params, request }) => {
      await requireIdentity(request);
      const form = await findFormByPublicId(params.publicId);
      return {
        form: {
          description: form.description,
          id: form.id,
          publicId: form.publicId,
          published: Boolean(
            form.publishedTemplate?.objectKey &&
            form.publishedTemplate.documentKey
          ),
          title: form.title,
          version: form.version,
        },
      };
    })
    .get(
      "/api/forms/:publicId/editor-config",
      async ({ request, params, query }) => {
        const identity = await requireIdentity(request);
        const form = await findFormByPublicId(params.publicId);
        const responseId =
          typeof query.responseId === "string" ? query.responseId : undefined;
        const requestedAction =
          typeof query.action === "string" ? query.action : undefined;
        return userEditorConfig(
          form,
          identity,
          responseId,
          requestedAction,
          bearerTokenFor(request)
        );
      }
    )
    .post("/api/forms/:publicId/start", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      const form = await findFormByPublicId(params.publicId);
      const publishedTemplate = form.publishedTemplate;
      if (
        form.status !== FormStatus.published ||
        !publishedTemplate?.objectKey ||
        !publishedTemplate.documentKey
      ) {
        fail(409, "not_published", "This form has not been published");
      }

      const existing = await prisma.response.findUnique({
        include: { prefillSnapshot: true },
        where: {
          formId_userId: { formId: form.id, userId: identity.id },
        },
      });
      if (existing?.status === ResponseStatus.submitted) {
        fail(409, "already_submitted", "You have already submitted this form");
      }
      if (existing?.status === ResponseStatus.submitting) {
        fail(
          409,
          "operation_in_progress",
          "Your submission is being processed"
        );
      }
      if (
        existing?.status === ResponseStatus.draft &&
        existing.publishedVersion === form.version &&
        existing.draftObjectKey &&
        existing.draftDocumentKey
      ) {
        if (!(await objectExists(existing.draftObjectKey))) {
          fail(
            409,
            "document_unavailable",
            "Response document artifact is unavailable"
          );
        }
        return {
          editorConfigUrl: `/api/forms/${form.publicId}/editor-config?responseId=${existing.id}&action=${existing.draftData ? "draft" : "fill"}`,
          prefill: existing.draftData ? null : undefined,
          response: responseSummary(existing),
        };
      }

      if (!(await objectExists(publishedTemplate.objectKey))) {
        fail(
          409,
          "document_unavailable",
          "The published document artifact is unavailable"
        );
      }
      const document = await readObject(publishedTemplate.objectKey);
      const responseId = existing?.id ?? crypto.randomUUID();
      const draftObjectKey = objectKey(
        "responses",
        responseId,
        "draft",
        crypto.randomUUID(),
        "docx"
      );
      const draftDocumentKey = `response-${responseId}-${crypto.randomUUID()}`;
      const snapshotId = crypto.randomUUID();
      try {
        await putObject(draftObjectKey, document, DOCX_CONTENT_TYPE);

        const response = await prisma.$transaction(
          async (tx) => {
            const lockedForm = await tx.form.findUnique({
              include: { publishedTemplate: true },
              where: { id: form.id },
            });
            if (
              !lockedForm ||
              lockedForm.status !== FormStatus.published ||
              lockedForm.version !== form.version ||
              !lockedForm.publishedTemplate ||
              lockedForm.publishedTemplate.id !== publishedTemplate.id
            ) {
              fail(409, "stale_form", "The form was published while starting");
            }
            const current = await tx.response.findUnique({
              where: {
                formId_userId: { formId: form.id, userId: identity.id },
              },
            });
            if (current?.status === ResponseStatus.submitted) {
              fail(
                409,
                "already_submitted",
                "You have already submitted this form"
              );
            }
            if (current?.status === ResponseStatus.submitting) {
              fail(
                409,
                "operation_in_progress",
                "Your submission is being processed"
              );
            }
            if (!current) {
              await tx.response.create({
                data: {
                  draftData: Prisma.DbNull,
                  draftDocumentKey,
                  draftObjectKey,
                  form: { connect: { id: form.id } },
                  id: responseId,
                  owner: { connect: { id: identity.id } },
                  publishedTemplate: {
                    connect: { id: lockedForm.publishedTemplate.id },
                  },
                  publishedVersion: form.version,
                  status: ResponseStatus.draft,
                },
              });
            }
            await tx.prefillSnapshot.deleteMany({
              where: { responseId },
            });
            await tx.prefillSnapshot.create({
              data: {
                form: { connect: { id: form.id } },
                id: snapshotId,
                lockedFields: jsonValue({}),
                owner: { connect: { id: identity.id } },
                response: { connect: { id: responseId } },
                values: jsonValue({}),
              },
            });
            const updated = await tx.response.updateMany({
              data: {
                draftData: Prisma.DbNull,
                draftDocumentKey,
                draftObjectKey,
                publishedTemplateId: lockedForm.publishedTemplate.id,
                publishedVersion: form.version,
                status: ResponseStatus.draft,
                updatedAt: new Date(),
              },
              where: { id: responseId },
            });
            if (updated.count !== 1) {
              fail(500, "start_failed", "Unable to start response");
            }
            return tx.response.findUnique({ where: { id: responseId } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        if (!response) {
          fail(500, "start_failed", "Unable to start response");
        }
        await deleteObjects([existing?.draftObjectKey]);
        return {
          editorConfigUrl: `/api/forms/${form.publicId}/editor-config?responseId=${response.id}&action=fill`,
          prefill: { data: {}, editableFields: {} },
          response: responseSummary(response),
        };
      } catch (error) {
        await deleteObjectUnlessCanonical(draftObjectKey);
        throw error;
      }
    })
    .get("/api/responses/me", async ({ request }) => {
      const identity = await requireIdentity(request);
      const responses = await prisma.response.findMany({
        include: { form: true, submission: true },
        orderBy: { updatedAt: "desc" },
        where: { userId: identity.id },
      });
      return {
        responses: responses.map((response) =>
          responseSummary(response, {
            formPublicId: response.form.publicId,
            formTitle: response.form.title,
            submissionId: response.submission?.id,
          })
        ),
      };
    })
    .post(
      "/api/forms/:publicId/draft",
      async ({ request, params, body, set }) => {
        const identity = await requireIdentity(request);
        const form = await findFormByPublicId(params.publicId);
        const input = asRecord(body);
        const responseId = requiredString(input, "responseId");
        const documentKey = requiredString(input, "documentKey");
        const response = await findOwnedResponse(
          responseId,
          form.id,
          identity.id
        );
        if (
          response.status !== ResponseStatus.draft ||
          response.draftDocumentKey !== documentKey ||
          response.publishedVersion !== form.version
        ) {
          fail(409, "stale_response", "The response is no longer editable");
        }
        const data = await normalizeResponseData(form, response, input.data);
        if (await activeOperationForResponse(response.id)) {
          fail(
            409,
            "operation_in_progress",
            "Another response operation is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const stagedObjectKey = objectKey(
          "operations",
          operationId,
          "draft",
          crypto.randomUUID(),
          "docx"
        );
        const metadata: OperationMetadata = {
          action: "save-draft",
          data,
          finalObjectKey: objectKey(
            "responses",
            response.id,
            "draft",
            crypto.randomUUID(),
            "docx"
          ),
          formId: form.id,
          publicId: form.publicId,
          responseId: response.id,
          stagedObjectKey,
        };
        const operation = await createOperation({
          actorId: identity.id,
          documentKey,
          formId: form.id,
          metadata,
          ownerUserId: identity.id,
          responseId: response.id,
          stagingObjectKey: stagedObjectKey,
          targetId: response.id,
          targetType: OperationTargetType.response,
          type: operationTypeForAction["save-draft"],
        });
        set.status = 202;
        launchForceSave(operation, onlyOffice, allowedCallbackOrigins);
        return {
          operationId: operation.id,
          responseId: response.id,
          status: operation.status,
        };
      }
    )
    .post(
      "/api/forms/:publicId/submit",
      async ({ request, params, body, set }) => {
        const identity = await requireIdentity(request);
        const form = await findFormByPublicId(params.publicId);
        const input = asRecord(body);
        const responseId = requiredString(input, "responseId");
        const documentKey = requiredString(input, "documentKey");
        const response = await findOwnedResponse(
          responseId,
          form.id,
          identity.id
        );
        if (
          response.status !== ResponseStatus.draft ||
          response.draftDocumentKey !== documentKey ||
          response.publishedVersion !== form.version
        ) {
          fail(409, "stale_response", "The response is no longer editable");
        }
        const data = await normalizeResponseData(form, response, input.data);
        if (await activeOperationForResponse(response.id)) {
          fail(
            409,
            "operation_in_progress",
            "Another response operation is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const submissionId = crypto.randomUUID();
        const submissionDocumentKey = `submission-${submissionId}-${crypto.randomUUID()}`;
        const stagedObjectKey = objectKey(
          "operations",
          operationId,
          "submission",
          crypto.randomUUID(),
          "docx"
        );
        const metadata: OperationMetadata = {
          action: "submit",
          data,
          finalObjectKey: objectKey(
            "submissions",
            submissionId,
            "filled",
            crypto.randomUUID(),
            "docx"
          ),
          formId: form.id,
          publicId: form.publicId,
          responseId: response.id,
          stagedObjectKey,
          submissionDocumentKey,
          submissionId,
        };
        const operation = await prisma.$transaction(
          async (tx) => {
            const claimed = await tx.response.updateMany({
              data: {
                status: ResponseStatus.submitting,
                updatedAt: new Date(),
              },
              where: { id: response.id, status: ResponseStatus.draft },
            });
            if (claimed.count !== 1) {
              fail(
                409,
                "operation_in_progress",
                "Another response operation is already in progress"
              );
            }
            return tx.operation.create({
              data: {
                actorId: identity.id,
                documentKey,
                errorCode: null,
                formId: form.id,
                metadata: jsonValue(metadata),
                ownerUserId: identity.id,
                responseId: response.id,
                stagingObjectKey: stagedObjectKey,
                status: OperationStatus.pending,
                submissionId: null,
                targetId: response.id,
                targetType: OperationTargetType.response,
                type: operationTypeForAction.submit,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        set.status = 202;
        launchForceSave(operation, onlyOffice, allowedCallbackOrigins);
        return {
          operationId: operation.id,
          responseId: response.id,
          status: operation.status,
          submissionId,
        };
      }
    )
    .get("/api/operations/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Operation");
      let operation = await prisma.operation.findUnique({
        where: { id: params.id },
      });
      if (!operation) {
        fail(404, "not_found", "Operation was not found");
      }
      operation = await expireOperationIfNeeded(operation);
      if (identity.role !== "admin") {
        if (!operation.responseId) {
          fail(403, "forbidden", "You may not access this operation");
        }
        const response = await prisma.response.findUnique({
          select: { userId: true },
          where: { id: operation.responseId },
        });
        if (response?.userId !== identity.id) {
          fail(403, "forbidden", "You may not access this operation");
        }
      }
      await cleanupTerminalOperationObjects(operation);
      return {
        operation: {
          createdAt: operation.createdAt,
          error: operation.errorCode,
          formId: operation.formId,
          id: operation.id,
          responseId: operation.responseId,
          result:
            operation.status === OperationStatus.completed
              ? operation.result
              : undefined,
          status: operation.status,
          submissionId: operation.submissionId,
          type: operation.type,
          updatedAt: operation.updatedAt,
        },
      };
    })
    .get("/api/submissions/:id/data", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const submission = await prisma.submission.findUnique({
        include: { form: true, owner: true },
        where: { id: params.id },
      });
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      canReadSubmission(identity, submission);
      return {
        data: jsonRecord(submission.data),
        submission: submissionSummary(submission, {
          formTitle: submission.form.title,
          userEmail: submission.owner.email,
        }),
      };
    })
    .get("/api/submissions/:id/docx", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const submission = await prisma.submission.findUnique({
        where: { id: params.id },
      });
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      canReadSubmission(identity, submission);
      if (!(await objectExists(submission.objectKey))) {
        fail(404, "not_found", "Submission document was not found");
      }
      return new Response(streamObject(submission.objectKey), {
        headers: {
          "Content-Disposition": `attachment; filename="submission-${submission.id}.docx"`,
          "Content-Type": DOCX_CONTENT_TYPE,
        },
      });
    })
    .get("/api/submissions/:id/pdf", async ({ request, params, set }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const submission = await prisma.submission.findUnique({
        where: { id: params.id },
      });
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      canReadSubmission(identity, submission);
      const pdf = await onlyOffice.convertDocxToPdf(submission.documentKey);
      set.headers["Content-Type"] = "application/pdf";
      set.headers["Content-Disposition"] =
        `attachment; filename="submission-${submission.id}.pdf"`;
      return pdf;
    })
    .get("/onlyoffice/document/:key", async ({ params, query }) => {
      const { key } = params;
      const token = typeof query.token === "string" ? query.token : "";
      if (!verifyDocumentAccessToken(token, key)) {
        fail(
          401,
          "unauthorized",
          "Document access token is invalid or expired"
        );
      }
      const objectKey = await operationDocumentKey(key);
      if (!objectKey || !(await objectExists(objectKey))) {
        fail(404, "not_found", "Document was not found");
      }
      return new Response(streamObject(objectKey), {
        headers: { "Content-Type": DOCX_CONTENT_TYPE },
      });
    })
    .get("/onlyoffice-plugin/config.json", ({ request, set }) => {
      const origin = request.headers.get("origin");
      const allowedOrigin =
        origin === env.API_BASE ||
        origin === env.ONLYOFFICE_URL ||
        origin === env.CORS_ORIGIN
          ? origin
          : env.ONLYOFFICE_URL;
      set.headers["Access-Control-Allow-Origin"] = allowedOrigin;
      set.headers.Vary = "Origin";
      return {
        guid: pluginGuid,
        name: "Form Bridge",
        variations: [
          {
            EditorsSupport: ["word"],
            buttons: [],
            description: "Form Bridge",
            events: ["onToolbarMenuClick", "onDocumentContentReady"],
            initData: "",
            initDataType: "none",
            isInsideMode: false,
            isModal: false,
            isViewer: true,
            isVisual: false,
            url: "index.html",
          },
        ],
        version: "2.1.0",
      };
    })
    .get("/onlyoffice-plugin/index.html", () =>
      Bun.file(path.resolve(pluginDir, "index.html"))
    )
    .get("/onlyoffice-plugin/plugin.js", () =>
      Bun.file(path.resolve(pluginDir, "plugin.js"))
    )
    .post("/onlyoffice/callback", async ({ body }) => {
      const payload = asRecord(body) as CallbackPayload;
      const operationId = callbackOperationId(payload.userdata);
      if (!operationId) {
        return { error: 0 };
      }
      const status =
        typeof payload.status === "number"
          ? payload.status
          : Number(payload.status);
      const operation = await prisma.operation.findUnique({
        where: { id: operationId },
      });
      if (!operation) {
        return { error: 0 };
      }
      if (
        operation.status === OperationStatus.completed ||
        operation.status === OperationStatus.failed
      ) {
        await cleanupTerminalOperationObjects(operation);
        return { error: 0 };
      }
      if (
        typeof payload.key !== "string" ||
        payload.key !== operation.documentKey
      ) {
        return { error: 1 };
      }
      if (status === 7) {
        const metadata = operationMetadata(operation.metadata);
        await updateOperationFailed(
          operation.id,
          "ONLYOFFICE reported a document error"
        );
        if (metadata.action === "submit" && metadata.responseId) {
          await rollbackSubmit(metadata.responseId);
        }
        return { error: 0 };
      }
      if (status !== 6) {
        return { error: 0 };
      }
      if (callbackClaims.has(operationId)) {
        return { error: 0 };
      }
      callbackClaims.add(operationId);
      try {
        await finalizeCallback(
          operationId,
          payload,
          undefined,
          allowedCallbackOrigins
        );
        return { error: 0 };
      } catch (error) {
        const metadata = operationMetadata(operation.metadata);
        await updateOperationFailed(operation.id, errorMessage(error));
        if (metadata.action === "submit" && metadata.responseId) {
          await rollbackSubmit(metadata.responseId);
        }
        return { error: 1 };
      } finally {
        callbackClaims.delete(operationId);
      }
    });
}

async function readTemplateSourceBytes(
  absolutePath: string
): Promise<Uint8Array> {
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    fail(404, "not_found", "Template source was not found");
  }
  return new Uint8Array(await file.arrayBuffer());
}
