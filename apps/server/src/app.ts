// oxlint-disable func-style prefer-destructuring no-await-in-loop no-use-before-define no-nested-ternary complexity no-shadow -- Route modules keep declaration order and sequential persistence invariants.
import { createHash, createHmac, randomBytes } from "node:crypto";
import path from "node:path";

import { cors } from "@elysiajs/cors";
import { auth } from "@onlyoffice/auth";
import type { OperationType } from "@onlyoffice/db";
import {
  AuditOutcome,
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
import { SaxesParser } from "saxes";

import {
  callbackClaim,
  createCallbackUserdata,
  createEditorCapability,
  createOnlyOfficeAuthorization,
  createOnlyOfficeClient,
  editorConfig,
  pluginGuid,
  verifyDocumentAccessToken,
  verifyEditorCapability,
  verifyOnlyOfficeAuthorization,
} from "./onlyoffice";
import type {
  EditorCapabilityAction,
  EditorCapabilityClaims,
  EditorCapabilityTarget,
  OnlyOfficeClient,
} from "./onlyoffice";
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
type DraftFieldRule =
  Prisma.DraftFieldRuleGetPayload<Prisma.DraftFieldRuleDefaultArgs>;

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
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const publicIdPattern = /^[0-9a-f]{32}$/u;
const accountEmailPattern = /^[^\s@]+@[^\s@]+$/u;
const operationTimeoutMs = 4 * 60_000;
const editorLeaseDurationMs = 90_000;
const callbackClaimLifetimeSeconds = 5 * 60;
// ponytail: 15 minutes bounds an abandoned upload; use claimed cleanup jobs if uploads can exceed it.
const objectCleanupIntentGraceMs = 15 * 60_000;
const maxTemplateUploadBytes = 25 * 1024 * 1024;
const maxTemplateMultipartOverheadBytes = 64 * 1024;
const maxTemplateMultipartBodyBytes =
  maxTemplateUploadBytes + maxTemplateMultipartOverheadBytes;
const maxTemplateArchiveExpandedBytes = 64 * 1024 * 1024;
const maxTemplateArchiveEntries = 2048;
const maxCallbackDocumentBytes = maxTemplateUploadBytes;
const maxCallbackBodyBytes = 64 * 1024;
const loginFailureLimit = 5;
const loginFailureWindowMs = 15 * 60_000;
const passwordMinimumLength = 12;
const passwordMaximumLength = 128;
const maxResponseDataBytes = 256 * 1024;
const maxResponseTextLength = 10_000;
const fieldRuleBodyMaximumBytes = 8 * 1024;
const dateFieldPattern = /^\d{4}-\d{2}-\d{2}$/u;
const isValidDateFieldValue = (value: string): boolean => {
  if (!dateFieldPattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};
const fieldTagMaximumLength = 512;
const fieldPointerMaximumLength = 2048;
const schemaPageSize = 5;
const schemaQueryMaximumLength = 200;
const accountUserPageSize = 20;
const accountBodyMaximumBytes = 64 * 1024;
const documentActionBodyMaximumBytes = 8 * 1024;
const accountEmailMaximumLength = 254;
const accountNameMaximumLength = 120;
// ponytail: one global account lock caps mutation throughput; shard locks only if needed.
const accountMutationLockId = 1_604_619_418;
const callbackInternalOrigin = originOf(env.ONLYOFFICE_INTERNAL_URL);
const callbackPublicOrigin = originOf(env.ONLYOFFICE_URL);
const callbackOrigins = new Set(
  [callbackInternalOrigin, callbackPublicOrigin].filter(
    (origin): origin is string => Boolean(origin)
  )
);
const pluginOrigins = new Set(
  [env.API_BASE, env.ONLYOFFICE_URL, env.CORS_ORIGIN]
    .map(originOf)
    .filter((origin): origin is string => Boolean(origin))
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
type Actor = Pick<
  Identity,
  "email" | "id" | "mustChangePassword" | "name" | "role"
>;
type AccountAuditAction =
  | "create_user"
  | "enable_user"
  | "disable_user"
  | "change_user_email"
  | "promote_user"
  | "demote_user"
  | "reset_user_password"
  | "update_user";
const adminUserSelect = {
  createdAt: true,
  email: true,
  enabled: true,
  id: true,
  mustChangePassword: true,
  name: true,
  role: true,
  updatedAt: true,
} as const;
type AdminUser = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;
interface EditorAuthorization {
  actor: Actor;
  capability: EditorCapabilityClaims | null;
}
type ActionEditorAuthorization = EditorAuthorization & {
  capability: EditorCapabilityClaims;
};
interface EditorCapabilityScope {
  action: EditorCapabilityAction;
  documentKey: string;
  formId: string;
  operationId?: string;
  targetId: string;
  targetType: EditorCapabilityTarget;
}
interface ClaimedEditorLease {
  expiresAt: Date;
  id: string;
}
interface EditorLeaseGrant extends ClaimedEditorLease {
  proof: string;
}
interface ActiveEditorLease {
  capabilityDigest: string;
  holderSessionId: string;
  holderUserId: string;
}
type JsonRecord = Record<string, unknown>;
type ExternalSchemaType = "string" | "number" | "boolean" | "null";
interface ExternalSchemaItem {
  pointer: string;
  type: ExternalSchemaType;
}

const externalMockSchema = {
  account: {
    active: true,
    address: {
      city: "",
      country: "",
      postalCode: "",
    },
    consent: {
      privacy: true,
      terms: true,
    },
    contact: {
      email: "",
      phone: "",
    },
    contacts: [{ name: "" }],
    "display/name": "",
    id: "",
    loginCount: 0,
    score: 0,
    settings: {
      language: "",
      timezone: "",
    },
    "tilde~key": "",
  },
  ignoredObject: {
    nested: {
      value: null,
    },
  },
  person: {
    birthDate: "",
    "contact/details": {
      "line~1": "",
    },
    name: "",
  },
} as const;

function externalSchemaPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function externalSchemaLeafType(value: unknown): ExternalSchemaType | null {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return null;
}

function flattenExternalSchema(
  value: unknown,
  parentPointer = "",
  items: ExternalSchemaItem[] = []
): ExternalSchemaItem[] {
  const type = externalSchemaLeafType(value);
  if (type) {
    items.push({ pointer: parentPointer, type });
    return items;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return items;
  }
  for (const key of Object.keys(value).sort()) {
    const pointer = `${parentPointer}/${externalSchemaPointerSegment(key)}`;
    flattenExternalSchema(
      (value as Record<string, unknown>)[key],
      pointer,
      items
    );
  }
  return items;
}

const externalSchemaItems = flattenExternalSchema(externalMockSchema);

function schemaCursor(query: string, offset: number): string {
  const payload = Buffer.from(JSON.stringify({ offset, query })).toString(
    "base64url"
  );
  const unsigned = `schema-v1.${payload}`;
  const signature = createHmac("sha256", env.EDITOR_CAPABILITY_SECRET)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

function schemaCursorOffset(cursor: string, query: string): number {
  const [version, payload, signature, extra] = cursor.split(".");
  if (!version || !payload || !signature || extra || version !== "schema-v1") {
    fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  }
  const unsigned = `${version}.${payload}`;
  const expected = createHmac("sha256", env.EDITOR_CAPABILITY_SECRET)
    .update(unsigned)
    .digest("base64url");
  if (signature !== expected) {
    fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    !("offset" in decoded) ||
    !("query" in decoded) ||
    typeof decoded.offset !== "number" ||
    !Number.isInteger(decoded.offset) ||
    decoded.offset < 0 ||
    typeof decoded.query !== "string" ||
    decoded.query !== query ||
    decoded.offset > externalSchemaItems.length
  ) {
    fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  }
  return decoded.offset;
}

function schemaQueryValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    fail(400, "invalid_schema_query", "Schema query must be a string");
  }
  const query = value.trim().toLowerCase();
  if (query.length > schemaQueryMaximumLength) {
    fail(400, "invalid_schema_query", "Schema query is too long");
  }
  return query;
}

function schemaPage(
  queryValue: unknown,
  cursorValue: unknown
): { items: ExternalSchemaItem[]; nextCursor: string | null } {
  const query = schemaQueryValue(queryValue);
  const matching = externalSchemaItems.filter((item) =>
    item.pointer.toLowerCase().includes(query)
  );
  const offset =
    cursorValue === undefined
      ? 0
      : typeof cursorValue === "string"
        ? schemaCursorOffset(cursorValue, query)
        : fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  if (offset > matching.length) {
    fail(400, "invalid_schema_cursor", "Schema cursor is invalid");
  }
  const items = matching.slice(offset, offset + schemaPageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor:
      nextOffset < matching.length ? schemaCursor(query, nextOffset) : null,
  };
}
type OperationAction = "save-template" | "publish" | "save-draft" | "submit";
const operationTypeForAction: Record<OperationAction, OperationType> = {
  publish: "publish_form",
  "save-draft": "save_draft",
  "save-template": "save_template_draft",
  submit: "submit_response",
};
type OperationErrorCode =
  | "callback_claim_invalid"
  | "callback_document_unavailable"
  | "callback_key_mismatch"
  | "callback_processing_failed"
  | "force_save_failed"
  | "invalid_template"
  | "onlyoffice_document_error"
  | "operation_timeout";
type FormSource = "blank" | "upload";
type FormAuditAction =
  | "archive_form"
  | "configure_field_rule"
  | "create_form"
  | "delete_form"
  | "duplicate_form"
  | "publish_form"
  | "save_template_draft"
  | "unarchive_form"
  | "update_form_metadata";
type FormAuditErrorCode =
  | "callback_claim_invalid"
  | "blank_template_unavailable"
  | "callback_document_unavailable"
  | "callback_key_mismatch"
  | "callback_processing_failed"
  | "document_unavailable"
  | "editor_capability_required"
  | "editor_capability_scope_mismatch"
  | "editor_in_use"
  | "editor_lease_inactive"
  | "force_save_failed"
  | "form_has_responses"
  | "form_not_draft"
  | "internal_error"
  | "invalid_editor_capability"
  | "invalid_file_type"
  | "invalid_request"
  | "invalid_template"
  | "not_found"
  | "onlyoffice_document_error"
  | "operation_in_progress"
  | "operation_timeout"
  | "payload_too_large"
  | "published_immutable"
  | "stale_document"
  | "stale_operation";
interface FormAuditMetadata {
  errorCode?: FormAuditErrorCode;
  source?: FormSource;
  sourcePublicId?: string;
  status?: FormStatus;
}
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
  onlyOfficeCallbackMaxBytes?: number;
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
async function readRequestBytes(
  request: Request,
  maximumBytes: number,
  missingMessage = "Request body is required"
): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    fail(413, "payload_too_large", "Request body is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    fail(400, "invalid_request", missingMessage);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      fail(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonRecord(
  request: Request,
  maximumBytes: number
): Promise<JsonRecord> {
  const bytes = await readRequestBytes(
    request,
    maximumBytes,
    "Request body must be a JSON object"
  );
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    fail(400, "invalid_request", "Request body must be valid JSON");
  }
}

interface TemplateCreationInput {
  description: string;
  source: FormSource;
  templateBytes?: Uint8Array;
  title: string;
}

async function readTemplateCreationInput(
  request: Request
): Promise<TemplateCreationInput> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^multipart\/form-data(?:\s*;|$)/iu.test(contentType)) {
    fail(
      415,
      "invalid_file_type",
      "Form creation requires multipart form data"
    );
  }
  const requestBytes = await readRequestBytes(
    request,
    maxTemplateMultipartBodyBytes,
    "Multipart form data is required"
  );
  const multipartRequest = new Request(request.url, {
    body: requestBytes,
    headers: { "content-type": contentType },
    method: "POST",
  });
  let formData: Awaited<ReturnType<typeof multipartRequest.formData>>;
  try {
    formData = await multipartRequest.formData();
  } catch {
    fail(400, "invalid_request", "Multipart form data is invalid");
  }

  const entries = new Map<string, unknown>();
  for (const [key, value] of formData.entries()) {
    if (
      key !== "description" &&
      key !== "source" &&
      key !== "template" &&
      key !== "title"
    ) {
      fail(
        400,
        "invalid_request",
        "Only title, description, source, and template are accepted"
      );
    }
    if (entries.has(key)) {
      fail(400, "invalid_request", `${key} must be provided once`);
    }
    entries.set(key, value);
  }

  const titleValue = entries.get("title");
  const sourceValue = entries.get("source");
  if (typeof titleValue !== "string" || titleValue.trim().length === 0) {
    fail(400, "invalid_request", "title is required");
  }
  if (typeof sourceValue !== "string" || sourceValue.trim().length === 0) {
    fail(400, "invalid_request", "source is required");
  }
  const title = titleValue.trim();
  const source = sourceValue.trim();
  if (title.length > 200) {
    fail(400, "invalid_request", "Title is too long");
  }
  if (source !== "blank" && source !== "upload") {
    fail(400, "invalid_request", "source must be blank or upload");
  }
  const descriptionValue = entries.get("description");
  if (
    descriptionValue !== undefined &&
    (typeof descriptionValue !== "string" ||
      descriptionValue.trim().length > 2000)
  ) {
    fail(400, "invalid_request", "Description is too long");
  }
  const description =
    typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  const template = entries.get("template");
  if (source === "blank") {
    if (template !== undefined) {
      fail(400, "invalid_request", "template is only accepted for upload");
    }
    return { description, source, title };
  }
  if (!(template instanceof File)) {
    fail(400, "invalid_request", "template is required for upload");
  }
  if (!/\.docx$/iu.test(template.name)) {
    fail(415, "invalid_file_type", "Template must be a DOCX file");
  }
  const normalizedType = template.type.trim().toLowerCase();
  if (
    normalizedType !== "" &&
    normalizedType !== "application/octet-stream" &&
    normalizedType !== DOCX_CONTENT_TYPE
  ) {
    fail(415, "invalid_file_type", "Template must be a DOCX file");
  }
  if (template.size > maxTemplateUploadBytes) {
    fail(413, "payload_too_large", "Template upload is too large");
  }
  const templateBytes = new Uint8Array(await template.arrayBuffer());
  if (templateBytes.byteLength > maxTemplateUploadBytes) {
    fail(413, "payload_too_large", "Template upload is too large");
  }
  return { description, source, templateBytes, title };
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, "invalid_request", `${key} is required`);
  }
  return value.trim();
}

async function readDocumentKeyInput(request: Request): Promise<string> {
  const input = await readJsonRecord(request, documentActionBodyMaximumBytes);
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "documentKey")) {
    fail(400, "invalid_request", "Only documentKey is accepted");
  }

  return requiredString(input, "documentKey");
}
interface FormMetadataInput {
  description?: string | null;
  status?: FormStatus;
  title?: string;
}

async function readFormMetadataInput(
  request: Request
): Promise<FormMetadataInput> {
  const input = await readJsonRecord(request, documentActionBodyMaximumBytes);
  const keys = Object.keys(input);
  if (
    keys.length === 0 ||
    keys.some(
      (key) => key !== "description" && key !== "status" && key !== "title"
    )
  ) {
    fail(
      400,
      "invalid_request",
      "Only title, description, and status are accepted"
    );
  }
  if (Object.hasOwn(input, "status") && keys.length !== 1) {
    fail(
      400,
      "invalid_request",
      "Status changes must not include title or description"
    );
  }
  const metadata: FormMetadataInput = {};
  if (Object.hasOwn(input, "title")) {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      fail(400, "invalid_request", "title must be a non-empty string");
    }
    if (input.title.trim().length > 200) {
      fail(400, "invalid_request", "Title is too long");
    }
    metadata.title = input.title.trim();
  }
  if (Object.hasOwn(input, "description")) {
    if (input.description !== null && typeof input.description !== "string") {
      fail(400, "invalid_request", "description must be a string or null");
    }
    if (
      typeof input.description === "string" &&
      input.description.trim().length > 2000
    ) {
      fail(400, "invalid_request", "Description is too long");
    }
    metadata.description =
      typeof input.description === "string"
        ? input.description.trim() || null
        : null;
  }
  if (Object.hasOwn(input, "status")) {
    if (
      input.status !== FormStatus.archived &&
      input.status !== FormStatus.published
    ) {
      fail(400, "invalid_request", "status must be archived or published");
    }
    metadata.status = input.status;
  }
  return metadata;
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
function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueObjectKeys(
  keys: readonly (string | null | undefined)[]
): string[] {
  return [
    ...new Set(
      keys.filter(
        (key): key is string => typeof key === "string" && key.length > 0
      )
    ),
  ];
}

async function deleteObjects(
  keys: readonly (string | null | undefined)[]
): Promise<void> {
  const uniqueKeys = uniqueObjectKeys(keys);
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

async function drainObjectCleanupIntents(
  objectKeys?: readonly string[]
): Promise<void> {
  const cleanupAfter = new Date();
  const intents = await prisma.objectCleanupIntent.findMany({
    orderBy: { createdAt: "asc" },
    where: {
      cleanupAfter: { lte: cleanupAfter },
      ...(objectKeys ? { objectKey: { in: [...objectKeys] } } : {}),
    },
  });
  for (const intent of intents) {
    try {
      await deleteObject(intent.objectKey);
      await prisma.objectCleanupIntent.deleteMany({
        where: { id: intent.id, objectKey: intent.objectKey },
      });
    } catch (error) {
      console.error(
        `Could not drain object cleanup intent ${intent.id}`,
        error
      );
    }
  }
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
async function editorAuthorization(
  request: Request
): Promise<EditorAuthorization> {
  const token = request.headers.get("x-editor-capability")?.trim();
  if (!token) {
    return { actor: await requireIdentity(request), capability: null };
  }
  const capability = verifyEditorCapability(token);
  if (!capability) {
    fail(
      401,
      "invalid_editor_capability",
      "Editor capability is invalid or expired"
    );
  }
  const user = await prisma.user.findUnique({
    select: {
      email: true,
      enabled: true,
      id: true,
      mustChangePassword: true,
      name: true,
      role: true,
    },
    where: { id: capability.actorId },
  });
  if (
    !user?.enabled ||
    user.mustChangePassword ||
    user.role !== capability.role
  ) {
    fail(
      401,
      "invalid_editor_capability",
      "Editor capability is invalid or expired"
    );
  }
  return {
    actor: {
      email: user.email,
      id: user.id,
      mustChangePassword: false,
      name: user.name,
      role: user.role,
    },
    capability,
  };
}
async function requireActionEditorAuthorization(
  request: Request
): Promise<ActionEditorAuthorization> {
  const authorization = await editorAuthorization(request);
  const { capability } = authorization;
  if (!capability) {
    fail(
      401,
      "editor_capability_required",
      "An editor capability is required for this action"
    );
  }
  return { actor: authorization.actor, capability };
}

function requireEditorScope(
  authorization: EditorAuthorization,
  scope: EditorCapabilityScope
): void {
  const { capability } = authorization;
  if (!capability) {
    return;
  }
  if (
    capability.action !== scope.action ||
    capability.documentKey !== scope.documentKey ||
    capability.formId !== scope.formId ||
    capability.operationId !== scope.operationId ||
    capability.targetId !== scope.targetId ||
    capability.targetType !== scope.targetType
  ) {
    fail(
      403,
      "editor_capability_scope_mismatch",
      "Editor capability does not permit this action"
    );
  }
}

function actionEditorCapability(
  actor: Actor,
  scope: Omit<EditorCapabilityScope, "action" | "operationId">,
  action: Exclude<EditorCapabilityAction, "poll-operation">,
  lease: EditorLeaseGrant
): string {
  return createEditorCapability({
    ...scope,
    action,
    actorId: actor.id,
    leaseId: lease.id,
    leaseProof: lease.proof,
    role: actor.role,
  });
}

function operationEditorCapability(
  actor: Actor,
  scope: Omit<EditorCapabilityScope, "action" | "operationId">,
  operationId: string
): string {
  return createEditorCapability({
    ...scope,
    action: "poll-operation",
    actorId: actor.id,
    operationId,
    role: actor.role,
  });
}

function editorLeaseTargetType(
  targetType: EditorCapabilityTarget
): OperationTargetType {
  return targetType === "template-draft"
    ? OperationTargetType.template_draft
    : OperationTargetType.response;
}

function editorLeaseProof(
  holder: Pick<Identity, "id" | "sessionId">,
  targetType: EditorCapabilityTarget,
  targetId: string
): string {
  return createHmac("sha256", env.EDITOR_CAPABILITY_SECRET)
    .update(
      [
        "editor-lease-v1",
        targetType,
        targetId,
        holder.sessionId,
        holder.id,
      ].join("\0")
    )
    .digest("base64url");
}

function nextEditorLeaseExpiry(identity: Identity, now: Date): Date {
  const expiresAt = new Date(
    Math.min(
      now.getTime() + editorLeaseDurationMs,
      identity.expiresAt.getTime()
    )
  );
  if (expiresAt.getTime() <= now.getTime()) {
    fail(401, "unauthorized", "Authentication is required");
  }
  return expiresAt;
}

function editorLeaseBridge(lease: ClaimedEditorLease) {
  return {
    expiresAt: lease.expiresAt.toISOString(),
    id: lease.id,
    releaseUrl: `/api/editor-leases/${lease.id}`,
    renewUrl: `/api/editor-leases/${lease.id}/renew`,
  };
}

async function claimEditorLease(
  identity: Identity,
  targetType: EditorCapabilityTarget,
  targetId: string,
  formId: string
): Promise<EditorLeaseGrant> {
  const now = new Date();
  const expiresAt = nextEditorLeaseExpiry(identity, now);
  const proof = editorLeaseProof(identity, targetType, targetId);
  const capabilityDigest = tokenDigest(proof);
  const leaseId = crypto.randomUUID();
  const databaseTargetType = editorLeaseTargetType(targetType);
  const activeOperation = await prisma.operation.findFirst({
    where: {
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
      targetId,
      targetType: databaseTargetType,
    },
  });
  if (activeOperation) {
    await expireOperationIfNeeded(activeOperation);
  }
  const lease = await prisma.$transaction(async (tx) => {
    const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT "id"
        FROM "forms"
        WHERE "id" = ${formId}::uuid
        FOR UPDATE
      `
    );
    if (!lockedForm) {
      fail(404, "not_found", "Form was not found");
    }
    const [current] = await tx.$queryRaw<
      (ActiveEditorLease & ClaimedEditorLease)[]
    >(
      Prisma.sql`
        SELECT
          "id",
          "capability_digest" AS "capabilityDigest",
          "expires_at" AS "expiresAt",
          "holder_session_id" AS "holderSessionId",
          "holder_user_id" AS "holderUserId"
        FROM "editor_leases"
        WHERE
          "target_type" = CAST(${databaseTargetType} AS "OperationTargetType")
          AND "target_id" = ${targetId}::uuid
        FOR UPDATE
      `
    );
    const sameHolder =
      current?.holderSessionId === identity.sessionId &&
      current.holderUserId === identity.id;
    if (!sameHolder) {
      const activeOperation = await tx.operation.findFirst({
        select: { id: true },
        where: {
          status: {
            in: [OperationStatus.pending, OperationStatus.processing],
          },
          targetId,
          targetType: databaseTargetType,
        },
      });
      if (activeOperation) {
        return null;
      }
    }
    const [claimed] = await tx.$queryRaw<ClaimedEditorLease[]>(
      Prisma.sql`
        INSERT INTO "editor_leases" (
          "id",
          "target_type",
          "target_id",
          "holder_session_id",
          "holder_user_id",
          "capability_digest",
          "expires_at",
          "renewed_at"
        )
        VALUES (
          ${leaseId}::uuid,
          CAST(${databaseTargetType} AS "OperationTargetType"),
          ${targetId}::uuid,
          ${identity.sessionId},
          ${identity.id},
          ${capabilityDigest},
          ${expiresAt},
          ${now}
        )
        ON CONFLICT ("target_type", "target_id") DO UPDATE SET
          "id" = CASE
            WHEN "editor_leases"."expires_at" <= ${now} THEN EXCLUDED."id"
            ELSE "editor_leases"."id"
          END,
          "holder_session_id" = EXCLUDED."holder_session_id",
          "holder_user_id" = EXCLUDED."holder_user_id",
          "capability_digest" = EXCLUDED."capability_digest",
          "expires_at" = EXCLUDED."expires_at",
          "created_at" = CASE
            WHEN "editor_leases"."expires_at" <= ${now}
              THEN EXCLUDED."created_at"
            ELSE "editor_leases"."created_at"
          END,
          "renewed_at" = EXCLUDED."renewed_at"
        WHERE
          "editor_leases"."expires_at" <= ${now}
          OR (
            "editor_leases"."holder_session_id" = ${identity.sessionId}
            AND "editor_leases"."holder_user_id" = ${identity.id}
          )
        RETURNING "id", "expires_at" AS "expiresAt"
      `
    );
    return claimed ?? null;
  });
  if (!lease) {
    fail(409, "editor_in_use", "This document is open in another session");
  }
  return { ...lease, proof };
}

async function renewEditorLease(
  identity: Identity,
  leaseId: string
): Promise<ClaimedEditorLease> {
  const now = new Date();
  const expiresAt = nextEditorLeaseExpiry(identity, now);
  const renewed = await prisma.editorLease.updateMany({
    data: { expiresAt, renewedAt: now },
    where: {
      expiresAt: { gt: now },
      holderSessionId: identity.sessionId,
      holderUserId: identity.id,
      id: leaseId,
    },
  });
  if (renewed.count !== 1) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
  return { expiresAt, id: leaseId };
}

async function releaseEditorLease(
  identity: Identity,
  leaseId: string
): Promise<void> {
  const released = await prisma.editorLease.deleteMany({
    where: {
      holderSessionId: identity.sessionId,
      holderUserId: identity.id,
      id: leaseId,
    },
  });
  if (released.count !== 1) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
}

function editorLeaseClaims(authorization: ActionEditorAuthorization): {
  id: string;
  proof: string;
} {
  const { leaseId, leaseProof } = authorization.capability;
  if (!leaseId || !leaseProof) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
  return { id: leaseId, proof: leaseProof };
}

function requireEditorLeaseProof(
  scope: Omit<EditorCapabilityScope, "action" | "operationId">,
  lease: ActiveEditorLease,
  proof: string
): void {
  const expectedProof = editorLeaseProof(
    { id: lease.holderUserId, sessionId: lease.holderSessionId },
    scope.targetType,
    scope.targetId
  );
  if (
    proof !== expectedProof ||
    tokenDigest(proof) !== lease.capabilityDigest
  ) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
}

async function requireActiveEditorLease(
  authorization: ActionEditorAuthorization,
  scope: Omit<EditorCapabilityScope, "action" | "operationId">
): Promise<void> {
  const claim = editorLeaseClaims(authorization);
  const now = new Date();
  const lease = await prisma.editorLease.findFirst({
    select: {
      capabilityDigest: true,
      holderSessionId: true,
      holderUserId: true,
    },
    where: {
      expiresAt: { gt: now },
      holderSession: { expiresAt: { gt: now } },
      holderUserId: authorization.actor.id,
      id: claim.id,
      targetId: scope.targetId,
      targetType: editorLeaseTargetType(scope.targetType),
    },
  });
  if (!lease) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
  requireEditorLeaseProof(scope, lease, claim.proof);
}

async function lockActiveEditorLease(
  tx: Prisma.TransactionClient,
  authorization: ActionEditorAuthorization,
  scope: Omit<EditorCapabilityScope, "action" | "operationId">
): Promise<void> {
  const claim = editorLeaseClaims(authorization);
  const databaseTargetType = editorLeaseTargetType(scope.targetType);
  const [lease] = await tx.$queryRaw<ActiveEditorLease[]>(
    Prisma.sql`
      SELECT
        "editor_leases"."capability_digest" AS "capabilityDigest",
        "editor_leases"."holder_session_id" AS "holderSessionId",
        "editor_leases"."holder_user_id" AS "holderUserId"
      FROM "editor_leases"
      INNER JOIN "session"
        ON "session"."id" = "editor_leases"."holder_session_id"
      WHERE
        "editor_leases"."id" = ${claim.id}::uuid
        AND "editor_leases"."target_type" =
          CAST(${databaseTargetType} AS "OperationTargetType")
        AND "editor_leases"."target_id" = ${scope.targetId}::uuid
        AND "editor_leases"."holder_user_id" = ${authorization.actor.id}
        AND "editor_leases"."expires_at" > NOW()
        AND "session"."expires_at" > NOW()
      FOR UPDATE OF "editor_leases"
    `
  );
  if (!lease) {
    fail(409, "editor_lease_inactive", "The editor lease is no longer active");
  }
  requireEditorLeaseProof(scope, lease, claim.proof);
}

function requireAdmin(identity: Pick<Actor, "role">): void {
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
function queryString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(400, "invalid_request", `${key} must be a string`);
  }
  return value;
}
function normalizedAccountEmail(value: string): string {
  const email = normalizeEmail(value);
  if (
    email.length > accountEmailMaximumLength ||
    !accountEmailPattern.test(email)
  ) {
    fail(400, "invalid_request", "email must be a valid email address");
  }
  return email;
}
function accountAuditTargetId(value: string): string | null {
  return idPattern.test(value) ? value : null;
}

function accountUserSummary(user: AdminUser): AdminUser {
  return {
    createdAt: user.createdAt,
    email: user.email,
    enabled: user.enabled,
    id: user.id,
    mustChangePassword: user.mustChangePassword,
    name: user.name,
    role: user.role,
    updatedAt: user.updatedAt,
  };
}

function generateTemporaryPassword(): string {
  return randomBytes(24).toString("base64url");
}

async function lockAccountMutationActor(
  tx: Prisma.TransactionClient,
  identity: Identity
): Promise<void> {
  const [actor] = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`
      SELECT "account_actor"."id"
      FROM "user" AS "account_actor"
      INNER JOIN "session" AS "account_session"
        ON "account_session"."user_id" = "account_actor"."id"
      WHERE
        "account_actor"."id" = ${identity.id}
        AND "account_actor"."role" = CAST('admin' AS "UserRole")
        AND "account_actor"."enabled" = TRUE
        AND "account_actor"."must_change_password" = FALSE
        AND "account_session"."id" = ${identity.sessionId}
        AND "account_session"."expires_at" > NOW()
      FOR UPDATE OF "account_actor", "account_session"
    `
  );
  if (!actor) {
    fail(403, "forbidden", "Administrator authorization changed");
  }
}

function accountTransaction<T>(
  identity: Identity,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${accountMutationLockId})`;
    await lockAccountMutationActor(tx, identity);
    return operation(tx);
  });
}

async function lockAccountUser(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<AdminUser> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${userId} FOR UPDATE`
  );
  if (!locked) {
    fail(404, "not_found", "User was not found");
  }
  const user = await tx.user.findUnique({
    select: adminUserSelect,
    where: { id: userId },
  });
  if (!user) {
    fail(404, "not_found", "User was not found");
  }
  return user;
}

interface AccountAuditMetadata {
  change?: string;
  errorCode?: string;
}

async function createAccountAudit(
  tx: Prisma.TransactionClient,
  {
    action,
    actorId,
    outcome,
    safeMetadata,
    targetId,
  }: {
    action: AccountAuditAction;
    actorId: string | null;
    outcome: AuditOutcome;
    safeMetadata: AccountAuditMetadata;
    targetId: string | null;
  }
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      action,
      actorId,
      outcome,
      safeMetadata: jsonValue(safeMetadata),
      targetId,
      targetType: "user",
    },
  });
}

function accountErrorCode(error: unknown): string {
  if (databaseErrorCode(error) === "P2002") {
    return "email_in_use";
  }
  return error instanceof HttpError ? error.code : "internal_error";
}

async function createAccountFailureAudit({
  action,
  actorId,
  error,
  targetId,
}: {
  action: AccountAuditAction;
  actorId: string | null;
  error: unknown;
  targetId: string | null;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      action,
      actorId,
      outcome: AuditOutcome.failure,
      safeMetadata: jsonValue({ errorCode: accountErrorCode(error) }),
      targetId,
      targetType: "user",
    },
  });
}

async function withAdminMutation<T>(
  request: Request,
  action: AccountAuditAction,
  targetId: string | null,
  operation: (
    identity: Identity,
    setAction: (action: AccountAuditAction) => void
  ) => Promise<T>
): Promise<T> {
  const identity = await identityFor(request);
  if (!identity) {
    fail(401, "unauthorized", "Authentication is required");
  }
  requireAdmin(identity);
  let auditAction = action;
  try {
    if (identity.mustChangePassword) {
      fail(403, "password_change_required", "Password replacement is required");
    }
    return await operation(identity, (nextAction) => {
      auditAction = nextAction;
    });
  } catch (error) {
    const normalizedError =
      databaseErrorCode(error) === "P2002"
        ? new HttpError(409, "email_in_use", "Email is already in use")
        : error;
    try {
      await createAccountFailureAudit({
        action: auditAction,
        actorId: identity.id,
        error: normalizedError,
        targetId,
      });
    } catch {
      // Preserve the route error if the failure audit cannot be persisted.
    }
    throw normalizedError;
  }
}

const formAuditErrorCodes: Record<string, true> = {
  blank_template_unavailable: true,
  callback_claim_invalid: true,
  callback_document_unavailable: true,
  callback_key_mismatch: true,
  callback_processing_failed: true,
  document_unavailable: true,
  editor_capability_required: true,
  editor_capability_scope_mismatch: true,
  editor_in_use: true,
  editor_lease_inactive: true,
  force_save_failed: true,
  form_has_responses: true,
  form_not_draft: true,
  internal_error: true,
  invalid_editor_capability: true,
  invalid_file_type: true,
  invalid_request: true,
  invalid_template: true,
  not_found: true,
  onlyoffice_document_error: true,
  operation_in_progress: true,
  operation_timeout: true,
  payload_too_large: true,
  published_immutable: true,
  stale_document: true,
  stale_operation: true,
};

function formAuditErrorCode(error: unknown): FormAuditErrorCode {
  const code = error instanceof HttpError ? error.code : "internal_error";
  return formAuditErrorCodes[code]
    ? (code as FormAuditErrorCode)
    : "internal_error";
}

async function createFormAudit(
  tx: Prisma.TransactionClient,
  {
    action,
    actorId,
    outcome,
    safeMetadata,
    targetId,
  }: {
    action: FormAuditAction;
    actorId: string | null;
    outcome: AuditOutcome;
    safeMetadata: FormAuditMetadata;
    targetId: string | null;
  }
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      action,
      actorId,
      outcome,
      safeMetadata: jsonValue(safeMetadata),
      targetId,
      targetType: "form",
    },
  });
}

async function createFormFailureAudit({
  action,
  actorId,
  error,
  source,
  targetId,
}: {
  action: FormAuditAction;
  actorId: string | null;
  error: unknown;
  source?: FormSource;
  targetId: string | null;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      action,
      actorId,
      outcome: AuditOutcome.failure,
      safeMetadata: jsonValue({
        ...(source ? { source } : {}),
        errorCode: formAuditErrorCode(error),
      }),
      targetId,
      targetType: "form",
    },
  });
}

interface FormCounts {
  activeDraftCount: number;
  submissionCount: number;
}

function formDto(
  form: FormWithDocuments,
  { activeDraftCount, submissionCount }: FormCounts
): JsonRecord {
  return {
    activeDraftCount,
    createdAt: form.createdAt,
    description: form.description ?? "",
    hasTemplateDraft: Boolean(form.templateDraft),
    publicId: form.publicId,
    status: form.status,
    submissionCount,
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
    submittedAt?: Date | null;
  } = {}
): JsonRecord {
  return {
    createdAt: response.createdAt,
    formPublicId: extra.formPublicId,
    formTitle: extra.formTitle,
    hasDraft: Boolean(response.draftObjectKey && response.draftData),
    id: response.id,
    publishedVersion: response.publishedVersion,
    status: response.status,
    submissionId: extra.submissionId,
    submittedAt: extra.submittedAt,
    updatedAt: response.updatedAt,
  };
}

function submissionSummary(
  submission: Submission,
  extra: {
    formPublicId?: string;
    formTitle?: string;
    userEmail?: string;
  } = {}
): JsonRecord {
  return {
    createdAt: submission.createdAt,
    formPublicId: extra.formPublicId,
    formTitle: extra.formTitle,
    id: submission.id,
    responseId: submission.responseId,
    status: "submitted",
    submittedAt: submission.createdAt,
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
export function resolveCallbackDocumentUrl(
  value: unknown,
  allowedOrigins: ReadonlySet<string> = callbackOrigins,
  publicOrigin: string | null = callbackPublicOrigin,
  internalOrigin: string | null = callbackInternalOrigin
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    let url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      !allowedOrigins.has(url.origin)
    ) {
      return null;
    }
    if (
      publicOrigin &&
      internalOrigin &&
      publicOrigin !== internalOrigin &&
      url.origin === publicOrigin
    ) {
      const internalUrl = new URL(internalOrigin);
      internalUrl.pathname = url.pathname;
      internalUrl.search = url.search;
      url = internalUrl;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readCallbackDocument(
  url: string,
  maximumBytes = maxCallbackDocumentBytes
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Authorization: createOnlyOfficeAuthorization({ url }) },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download ONLYOFFICE document: HTTP ${response.status}`
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("ONLYOFFICE document callback payload is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error("ONLYOFFICE document callback payload is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const templatePackageRelationshipNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const templatePackageContentTypesNamespace =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const templateOfficeDocumentRelationships = new Set([
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
]);
const templateWordMainNamespace =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const templateWordStrictNamespace =
  "http://purl.oclc.org/ooxml/wordprocessingml/main";
const templateCheckboxNamespace =
  "http://schemas.microsoft.com/office/word/2010/wordml";
const templateWord2012Namespace =
  "http://schemas.microsoft.com/office/word/2012/wordml";
const templateWordNamespaces = new Set([
  templateWordStrictNamespace,
  templateWordMainNamespace,
]);
const templateControlNamespaces = new Set([
  ...templateWordNamespaces,
  templateCheckboxNamespace,
  templateWord2012Namespace,
]);
const templateControlKey = (namespace: string, local: string): string =>
  `${namespace}#${local}`;
const templateDocumentContentType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

interface TemplateXmlAttribute {
  local: string;
  uri: string;
  value: string;
}

interface TemplateXmlElement {
  attributes: TemplateXmlAttribute[];
  local: string;
  uri: string;
}

interface TemplateXmlVisitor {
  close?: (element: TemplateXmlElement) => void;
  open?: (element: TemplateXmlElement) => void;
}

function templateXmlElement(tag: {
  attributes: Record<string, { local: string; uri: string; value: string }>;
  local: string;
  uri: string;
}): TemplateXmlElement {
  return {
    attributes: Object.values(tag.attributes).map((attribute) => ({
      local: attribute.local,
      uri: attribute.uri,
      value: attribute.value,
    })),
    local: tag.local,
    uri: tag.uri,
  };
}

function parseTemplateXml(xml: string, visitor: TemplateXmlVisitor = {}): void {
  const parser = new SaxesParser({ position: false, xmlns: true });
  parser.on("doctype", () => {
    throw new Error("DOCX XML document types are not allowed");
  });
  parser.on("opentag", (tag) => {
    visitor.open?.(templateXmlElement(tag));
  });
  parser.on("closetag", (tag) => {
    visitor.close?.(templateXmlElement(tag));
  });
  try {
    parser.write(xml).close();
  } catch {
    fail(422, "invalid_template", "The DOCX package contains invalid XML");
  }
}

function templateAttribute(
  element: TemplateXmlElement,
  local: string,
  uri = ""
): string | undefined {
  return element.attributes.find(
    (attribute) => attribute.local === local && attribute.uri === uri
  )?.value;
}

function readTemplateArchive(
  bytes: Uint8Array,
  include: (archivePath: string) => boolean
): Record<string, Uint8Array> {
  let expandedBytes = 0;
  let entryCount = 0;
  const names = new Set<string>();
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        entryCount += 1;
        const archivePath = file.name;
        const segments = archivePath.split("/");
        if (
          !archivePath ||
          archivePath.startsWith("/") ||
          archivePath.includes("\\") ||
          archivePath.includes("\0") ||
          segments.some(
            (segment, index) =>
              segment === "." ||
              segment === ".." ||
              (segment.length === 0 && index !== segments.length - 1)
          ) ||
          names.has(archivePath)
        ) {
          throw new Error("Unsafe DOCX archive path");
        }
        names.add(archivePath);
        if (
          !Number.isSafeInteger(file.originalSize) ||
          file.originalSize < 0 ||
          expandedBytes > maxTemplateArchiveExpandedBytes - file.originalSize
        ) {
          throw new Error("DOCX archive expands beyond the safety limit");
        }
        expandedBytes += file.originalSize;
        if (entryCount > maxTemplateArchiveEntries) {
          throw new Error("DOCX archive contains too many entries");
        }
        return include(archivePath);
      },
    });
  } catch {
    fail(422, "invalid_template", "The template is not a safe DOCX archive");
  }
}

function templateArchiveText(
  archive: Record<string, Uint8Array>,
  archivePath: string
): string {
  const bytes = archive[archivePath];
  if (!bytes || bytes.byteLength === 0) {
    fail(422, "invalid_template", "The DOCX package is incomplete");
  }
  try {
    let decodedBytes = bytes;
    let encoding: "utf-16" | "utf-8" = "utf-8";
    if (
      (bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0x3c && bytes[1] === 0x00)
    ) {
      encoding = "utf-16";
    } else if (
      (bytes[0] === 0xfe && bytes[1] === 0xff) ||
      (bytes[0] === 0x00 && bytes[1] === 0x3c)
    ) {
      if (bytes.byteLength % 2 !== 0) {
        throw new Error("UTF-16 XML must contain complete code units");
      }
      decodedBytes = new Uint8Array(bytes);
      for (let index = 0; index < decodedBytes.byteLength; index += 2) {
        const firstByte = decodedBytes[index] ?? 0;
        decodedBytes[index] = decodedBytes[index + 1] ?? 0;
        decodedBytes[index + 1] = firstByte;
      }
      encoding = "utf-16";
    }
    return new TextDecoder(encoding, { fatal: true }).decode(decodedBytes);
  } catch {
    fail(422, "invalid_template", "The DOCX package contains invalid XML");
  }
}
const externalRelationshipTargetPattern = /^[a-z][a-z\d+.-]*:/iu;

function isExternalRelationshipTarget(target: string | undefined): boolean {
  const normalized = target?.trim() ?? "";
  return (
    normalized.startsWith("//") ||
    normalized.startsWith("\\\\") ||
    externalRelationshipTargetPattern.test(normalized)
  );
}

function validateOfficeRelationships(
  archive: Record<string, Uint8Array>
): void {
  for (const archivePath of Object.keys(archive)) {
    if (!archivePath.toLowerCase().endsWith(".rels")) {
      continue;
    }
    parseTemplateXml(templateArchiveText(archive, archivePath), {
      open: (element) => {
        if (
          element.local !== "Relationship" ||
          element.uri !== templatePackageRelationshipNamespace
        ) {
          return;
        }
        const targetMode = templateAttribute(element, "TargetMode");
        const target = templateAttribute(element, "Target");
        if (
          targetMode?.trim().toLowerCase() === "external" ||
          isExternalRelationshipTarget(target)
        ) {
          fail(
            422,
            "invalid_template",
            "External DOCX relationships are not allowed"
          );
        }
      },
    });
  }
}

function validateOfficeRelationshipsBytes(bytes: Uint8Array): void {
  const archive = readTemplateArchive(bytes, (archivePath) =>
    archivePath.toLowerCase().endsWith(".rels")
  );
  validateOfficeRelationships(archive);
}

function isTemplateXmlContentType(contentType: string | undefined): boolean {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    normalized === "application/xml" ||
    normalized === "text/xml" ||
    normalized === "application/vnd.openxmlformats-officedocument.vmldrawing" ||
    normalized?.endsWith("+xml") === true
  );
}

function templateRelationshipPartPath(partPath: string): string {
  const separator = partPath.lastIndexOf("/");
  const directory = separator !== -1 ? partPath.slice(0, separator + 1) : "";
  const filename = partPath.slice(separator + 1);
  return `${directory}_rels/${filename}.rels`;
}

function resolveTemplateRelationshipTarget(
  sourcePath: string,
  target: string | undefined
): string | null {
  const normalizedTarget = target?.trim().split("#", 1)[0] ?? "";
  if (!normalizedTarget || isExternalRelationshipTarget(normalizedTarget)) {
    return null;
  }
  const separator = sourcePath.lastIndexOf("/");
  const directory = separator !== -1 ? sourcePath.slice(0, separator + 1) : "";
  const segments =
    `${normalizedTarget.startsWith("/") ? "" : directory}${normalizedTarget.replace(/^\/+/u, "")}`.split(
      "/"
    );
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalizedSegments.length === 0) {
        return null;
      }
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments.join("/");
}

function reachableTemplateParts(
  archive: Record<string, Uint8Array>,
  startPath: string
): Set<string> {
  const reachable = new Set<string>([startPath]);
  const queue = [startPath];
  while (queue.length > 0) {
    const sourcePath = queue.shift();
    if (!sourcePath) {
      continue;
    }
    const relationshipPath = templateRelationshipPartPath(sourcePath);
    const relationshipBytes = archive[relationshipPath];
    if (!relationshipBytes) {
      continue;
    }
    parseTemplateXml(templateArchiveText(archive, relationshipPath), {
      open: (element) => {
        if (
          element.local !== "Relationship" ||
          element.uri !== templatePackageRelationshipNamespace ||
          templateAttribute(element, "TargetMode") !== undefined
        ) {
          return;
        }
        const targetPath = resolveTemplateRelationshipTarget(
          sourcePath,
          templateAttribute(element, "Target")
        );
        if (
          targetPath &&
          Object.hasOwn(archive, targetPath) &&
          !reachable.has(targetPath)
        ) {
          reachable.add(targetPath);
          queue.push(targetPath);
        }
      },
    });
  }
  return reachable;
}

function reachableTemplateControlParts(
  archive: Record<string, Uint8Array>,
  xmlPaths: Set<string>
): Set<string> {
  const reachable = reachableTemplateParts(archive, "word/document.xml");
  return new Set(
    [...xmlPaths].filter(
      (archivePath) =>
        reachable.has(archivePath) &&
        templateControlPartPattern.test(archivePath)
    )
  );
}

function validateTemplatePackageArchive(
  archive: Record<string, Uint8Array>
): Set<string> {
  const contentTypes = templateArchiveText(archive, "[Content_Types].xml");
  const relationships = templateArchiveText(archive, "_rels/.rels");
  const document = templateArchiveText(archive, "word/document.xml");
  const defaultContentTypes = new Map<string, string>();
  const overrideContentTypes = new Map<string, string>();
  let contentTypesRoot = false;
  let contentTypesRootSeen = false;
  parseTemplateXml(contentTypes, {
    open: (element) => {
      if (!contentTypesRootSeen) {
        contentTypesRootSeen = true;
        contentTypesRoot =
          element.local === "Types" &&
          element.uri === templatePackageContentTypesNamespace;
      }
      if (element.uri !== templatePackageContentTypesNamespace) {
        return;
      }
      const contentType = templateAttribute(element, "ContentType");
      if (element.local === "Default") {
        const extension = templateAttribute(
          element,
          "Extension"
        )?.toLowerCase();
        if (!extension || !contentType || defaultContentTypes.has(extension)) {
          fail(422, "invalid_template", "The DOCX content types are invalid");
        }
        defaultContentTypes.set(extension, contentType);
      } else if (element.local === "Override") {
        const partName = templateAttribute(element, "PartName");
        if (
          !partName?.startsWith("/") ||
          !contentType ||
          overrideContentTypes.has(partName)
        ) {
          fail(422, "invalid_template", "The DOCX content types are invalid");
        }
        overrideContentTypes.set(partName, contentType);
      }
    },
  });
  const documentOverride =
    overrideContentTypes.get("/word/document.xml") ===
    templateDocumentContentType;

  let relationshipsRoot = false;
  let relationshipsRootSeen = false;
  let officeDocumentRelationship = false;
  parseTemplateXml(relationships, {
    open: (element) => {
      if (!relationshipsRootSeen) {
        relationshipsRootSeen = true;
        relationshipsRoot =
          element.local === "Relationships" &&
          element.uri === templatePackageRelationshipNamespace;
      }
      const target = templateAttribute(element, "Target");
      if (
        element.local === "Relationship" &&
        element.uri === templatePackageRelationshipNamespace &&
        templateOfficeDocumentRelationships.has(
          templateAttribute(element, "Type") ?? ""
        ) &&
        templateAttribute(element, "TargetMode") === undefined &&
        (target === "word/document.xml" || target === "/word/document.xml")
      ) {
        officeDocumentRelationship = true;
      }
    },
  });

  let documentBody = false;
  let documentRoot = false;
  let documentRootSeen = false;
  parseTemplateXml(document, {
    open: (element) => {
      if (!documentRootSeen) {
        documentRootSeen = true;
        documentRoot =
          element.local === "document" &&
          templateWordNamespaces.has(element.uri);
      }
      if (element.local === "body" && templateWordNamespaces.has(element.uri)) {
        documentBody = true;
      }
    },
  });

  if (
    !contentTypesRoot ||
    !documentOverride ||
    !relationshipsRoot ||
    !officeDocumentRelationship ||
    !documentRoot ||
    !documentBody
  ) {
    fail(
      422,
      "invalid_template",
      "The DOCX package is missing required document parts"
    );
  }

  const xmlPaths = new Set([
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
  ]);
  for (const archivePath of Object.keys(archive)) {
    const lowercasePath = archivePath.toLowerCase();
    const extension = lowercasePath.slice(lowercasePath.lastIndexOf(".") + 1);
    const contentType =
      overrideContentTypes.get(`/${archivePath}`) ??
      defaultContentTypes.get(extension);
    if (
      lowercasePath.endsWith(".xml") ||
      lowercasePath.endsWith(".rels") ||
      lowercasePath.endsWith(".vml") ||
      isTemplateXmlContentType(contentType)
    ) {
      xmlPaths.add(archivePath);
    }
  }
  for (const archivePath of xmlPaths) {
    if (
      archivePath !== "[Content_Types].xml" &&
      archivePath !== "_rels/.rels" &&
      archivePath !== "word/document.xml"
    ) {
      parseTemplateXml(templateArchiveText(archive, archivePath));
    }
  }
  return xmlPaths;
}

function safeTemplateArchive(bytes: Uint8Array): {
  archive: Record<string, Uint8Array>;
  xmlPaths: Set<string>;
} {
  const archive = readTemplateArchive(bytes, () => true);
  validateOfficeRelationships(archive);
  return {
    archive,
    xmlPaths: validateTemplatePackageArchive(archive),
  };
}

function validateTemplatePackage(bytes: Uint8Array): void {
  safeTemplateArchive(bytes);
}

interface ParsedTemplateField {
  options: { displayText: string; value: string }[] | null;
  pictureMaxBytes: number | null;
  pictureMaxHeight: number | null;
  pictureMaxWidth: number | null;
  tag: string;
  type: FieldType;
}

interface TemplateControlFrame {
  inPropertiesDepth: number;
  markers: Set<FieldType>;
  options: { displayText: string; value: string }[];
  propertyStack: string[];
  duplicateMarker: boolean;
  duplicateTag: boolean;
  tag: string | null;
  unsupported: string | null;
}

const templateControlTypeMarkers = new Map<string, FieldType>([
  [templateControlKey(templateWordMainNamespace, "comboBox"), FieldType.combo],
  [templateControlKey(templateWordMainNamespace, "date"), FieldType.date],
  [
    templateControlKey(templateWordMainNamespace, "dropDownList"),
    FieldType.dropdown,
  ],
  [templateControlKey(templateWordMainNamespace, "picture"), FieldType.picture],
  [templateControlKey(templateWordMainNamespace, "text"), FieldType.text],
  [
    templateControlKey(templateWordStrictNamespace, "comboBox"),
    FieldType.combo,
  ],
  [templateControlKey(templateWordStrictNamespace, "date"), FieldType.date],
  [
    templateControlKey(templateWordStrictNamespace, "dropDownList"),
    FieldType.dropdown,
  ],
  [
    templateControlKey(templateWordStrictNamespace, "picture"),
    FieldType.picture,
  ],
  [templateControlKey(templateWordStrictNamespace, "text"), FieldType.text],
  [
    templateControlKey(templateCheckboxNamespace, "checkbox"),
    FieldType.checkbox,
  ],
]);
const templateUnsupportedControlMarkers = new Set([
  templateControlKey(templateWordMainNamespace, "citation"),
  templateControlKey(templateWordMainNamespace, "docPartGallery"),
  templateControlKey(templateWordMainNamespace, "docPartList"),
  templateControlKey(templateWordMainNamespace, "docPartObj"),
  templateControlKey(templateWordMainNamespace, "equation"),
  templateControlKey(templateWordMainNamespace, "group"),
  templateControlKey(templateWordMainNamespace, "richText"),
  templateControlKey(templateWord2012Namespace, "repeatingSection"),
  templateControlKey(templateWord2012Namespace, "repeatingSectionItem"),
]);
const templateControlTypeLocals = new Set([
  "checkbox",
  "comboBox",
  "date",
  "dropDownList",
  "picture",
  "text",
]);
const templateUnsupportedControlLocals = new Set([
  "citation",
  "docPartGallery",
  "docPartList",
  "docPartObj",
  "equation",
  "group",
  "richText",
  "repeatingSection",
  "repeatingSectionItem",
]);
const templateControlPartPattern =
  /^word\/(?:document|endnotes|footnotes|footer\d+|header\d+)\.xml$/u;
const templateControlMetadataProperties = new Set([
  "alias",
  "appearance",
  "calendar",
  "checked",
  "checkedState",
  "color",
  "dataBinding",
  "dateFormat",
  "id",
  "lock",
  "placeholder",
  "rPr",
  "showingPlcHdr",
  "tag",
  "temporary",
  "uncheckedState",
]);

function templateControlAttribute(
  element: TemplateXmlElement,
  local: string
): string | undefined {
  return element.attributes.find(
    (attribute) => attribute.local === local && attribute.uri === element.uri
  )?.value;
}

function parsedTemplateField(frame: TemplateControlFrame): ParsedTemplateField {
  if (!frame.tag?.trim()) {
    fail(422, "invalid_template", "Every content control must have a tag");
  }
  if (frame.unsupported) {
    fail(
      422,
      "invalid_template",
      `Unsupported content control type: ${frame.unsupported}`
    );
  }
  if (frame.duplicateTag) {
    fail(
      422,
      "invalid_template",
      "A content control cannot repeat its tag property"
    );
  }
  if (frame.duplicateMarker) {
    fail(
      422,
      "invalid_template",
      "A content control cannot repeat a field type marker"
    );
  }
  if (frame.markers.size > 1) {
    fail(
      422,
      "invalid_template",
      "A content control cannot declare multiple field types"
    );
  }
  const type = frame.markers.values().next().value ?? FieldType.text;
  if (
    (type === FieldType.dropdown || type === FieldType.combo) &&
    frame.options.length === 0
  ) {
    fail(
      422,
      "invalid_template",
      "Dropdown and combo fields must define options"
    );
  }
  if (
    type !== FieldType.dropdown &&
    type !== FieldType.combo &&
    frame.options.length > 0
  ) {
    fail(
      422,
      "invalid_template",
      "Only dropdown and combo fields may define options"
    );
  }
  const uniqueOptionLabels = new Set(
    frame.options.map((option) => option.displayText)
  );
  const uniqueOptionValues = new Set(
    frame.options.map((option) => option.value)
  );
  if (
    uniqueOptionLabels.size !== frame.options.length ||
    uniqueOptionValues.size !== frame.options.length
  ) {
    fail(422, "invalid_template", "Dropdown and combo options must be unique");
  }
  const tag = frame.tag.trim();
  return {
    options: frame.options.length > 0 ? frame.options : null,
    pictureMaxBytes: type === FieldType.picture ? 10 * 1024 * 1024 : null,
    pictureMaxHeight: type === FieldType.picture ? 4096 : null,
    pictureMaxWidth: type === FieldType.picture ? 4096 : null,
    tag,
    type,
  };
}

function parseTemplateFields(bytes: Uint8Array): ParsedTemplateField[] {
  const { archive, xmlPaths } = safeTemplateArchive(bytes);
  const fields: ParsedTemplateField[] = [];
  const controlPaths = reachableTemplateControlParts(archive, xmlPaths);
  for (const archivePath of controlPaths) {
    const controls: TemplateControlFrame[] = [];
    parseTemplateXml(templateArchiveText(archive, archivePath), {
      close: (element) => {
        const frame = controls.at(-1);
        if (!frame) {
          return;
        }
        if (
          element.local === "sdtPr" &&
          templateWordNamespaces.has(element.uri)
        ) {
          frame.inPropertiesDepth = 0;
          frame.propertyStack.length = 0;
          return;
        }
        if (frame.inPropertiesDepth > 0) {
          frame.propertyStack.pop();
          frame.inPropertiesDepth -= 1;
        }
        if (
          element.local === "sdt" &&
          templateWordNamespaces.has(element.uri)
        ) {
          controls.pop();
          fields.push(parsedTemplateField(frame));
        }
      },
      open: (element) => {
        if (
          element.local === "sdt" &&
          templateWordNamespaces.has(element.uri)
        ) {
          controls.push({
            duplicateMarker: false,
            duplicateTag: false,
            inPropertiesDepth: 0,
            markers: new Set(),
            options: [],
            propertyStack: [],
            tag: null,
            unsupported: null,
          });
          return;
        }
        const frame = controls.at(-1);
        if (!frame) {
          return;
        }
        if (
          element.local === "sdtPr" &&
          templateWordNamespaces.has(element.uri)
        ) {
          frame.inPropertiesDepth = 1;
          return;
        }
        if (frame.inPropertiesDepth === 0) {
          return;
        }
        const isControlElement = templateControlNamespaces.has(element.uri);
        const isDirectProperty = frame.inPropertiesDepth === 1;
        const parentProperty = frame.propertyStack.at(-1);
        if (parentProperty === "listItem") {
          fail(422, "invalid_template", "Field options are malformed");
        }
        const controlKey = templateControlKey(element.uri, element.local);
        const marker = templateControlTypeMarkers.get(controlKey);
        const isUnsupportedControl =
          templateUnsupportedControlMarkers.has(controlKey);
        const isTag =
          templateWordNamespaces.has(element.uri) && element.local === "tag";
        const isListItem =
          templateWordNamespaces.has(element.uri) &&
          element.local === "listItem";
        const isAllowedMetadata =
          (templateWordNamespaces.has(element.uri) &&
            templateControlMetadataProperties.has(element.local)) ||
          (element.uri === templateWord2012Namespace &&
            element.local === "appearance");
        const isWrongNamespaceSemantic =
          (element.local === "tag" && !isTag) ||
          (templateControlTypeLocals.has(element.local) &&
            marker === undefined) ||
          (templateUnsupportedControlLocals.has(element.local) &&
            !isUnsupportedControl);
        if (
          (isTag ||
            marker !== undefined ||
            isUnsupportedControl ||
            isWrongNamespaceSemantic) &&
          !isDirectProperty
        ) {
          fail(
            422,
            "invalid_template",
            `Misplaced content control property: ${element.local}`
          );
        }
        if (isTag) {
          if (frame.tag !== null) {
            frame.duplicateTag = true;
          }
          frame.tag = templateControlAttribute(element, "val") ?? null;
        }
        if (marker !== undefined) {
          if (frame.markers.has(marker)) {
            frame.duplicateMarker = true;
          }
          frame.markers.add(marker);
        }
        if (isUnsupportedControl) {
          frame.unsupported = element.local;
        }
        if (element.local === "listItem") {
          if (
            !isListItem ||
            frame.inPropertiesDepth !== 2 ||
            (parentProperty !== "comboBox" && parentProperty !== "dropDownList")
          ) {
            fail(422, "invalid_template", "Field options are malformed");
          }
          if (
            !frame.markers.has(FieldType.dropdown) &&
            !frame.markers.has(FieldType.combo)
          ) {
            fail(
              422,
              "invalid_template",
              "Only dropdown and combo fields may define options"
            );
          }
          const displayText = templateControlAttribute(element, "displayText");
          const value = templateControlAttribute(element, "value");
          if (!displayText?.trim() || value === undefined) {
            fail(422, "invalid_template", "Field options are malformed");
          }
          frame.options.push({
            displayText: displayText.trim(),
            value,
          });
        }
        if (
          isDirectProperty &&
          (!isControlElement ||
            (marker === undefined &&
              !isUnsupportedControl &&
              !isAllowedMetadata))
        ) {
          fail(
            422,
            "invalid_template",
            `Unknown content control type: ${element.local}`
          );
        }
        frame.propertyStack.push(element.local);
        frame.inPropertiesDepth += 1;
      },
    });
  }

  if (fields.length === 0) {
    fail(
      422,
      "invalid_template",
      "The template must contain at least one tagged content control"
    );
  }
  const duplicates = fields.filter(
    (field, index) =>
      fields.findIndex((candidate) => candidate.tag === field.tag) !== index
  );
  if (duplicates.length > 0) {
    fail(
      422,
      "invalid_template",
      `Content control tags must be unique: ${[...new Set(duplicates.map((field) => field.tag))].join(", ")}`
    );
  }
  return fields;
}

function validateTemplateControls(bytes: Uint8Array): string[] {
  return parseTemplateFields(bytes).map((field) => field.tag);
}
async function normalizeResponseData(
  form: FormWithDocuments,
  response: ResponseWithSnapshot,
  inputData: unknown,
  requireRequired = false
): Promise<JsonRecord> {
  const data = { ...jsonRecord(inputData) };
  const serialized = JSON.stringify(data);
  if (new TextEncoder().encode(serialized).byteLength > maxResponseDataBytes) {
    fail(413, "response_too_large", "Response data exceeds the size limit");
  }
  const publishedTemplate = form.publishedTemplate;
  if (!publishedTemplate?.objectKey) {
    fail(409, "not_published", "This form has not been published");
  }
  const manifest = await prisma.fieldManifest.findUnique({
    include: { fields: { orderBy: { tag: "asc" } } },
    where: { publishedTemplateId: publishedTemplate.id },
  });
  if (!manifest) {
    fail(500, "internal_error", "The published Field Manifest is unavailable");
  }
  const fieldsByTag = new Map(
    manifest.fields.map((field) => [field.tag, field])
  );
  const unknownFields = Object.keys(data).filter(
    (field) => !fieldsByTag.has(field)
  );
  if (unknownFields.length > 0) {
    fail(
      422,
      "invalid_response_data",
      `Unknown form field(s): ${unknownFields.join(", ")}`
    );
  }
  for (const [fieldTag, value] of Object.entries(data)) {
    const field = fieldsByTag.get(fieldTag);
    if (!field || value === null) {
      continue;
    }
    let valid = false;
    if (field.type === FieldType.checkbox) {
      valid = typeof value === "boolean";
    } else if (field.type === FieldType.dropdown) {
      const optionValues = new Set(
        Array.isArray(field.options)
          ? field.options.flatMap((option) => {
              if (
                !option ||
                typeof option !== "object" ||
                Array.isArray(option)
              ) {
                return [];
              }
              const optionValue = (option as Record<string, unknown>).value;
              return typeof optionValue === "string" ? [optionValue] : [];
            })
          : []
      );
      valid = typeof value === "string" && optionValues.has(value);
    } else if (field.type === FieldType.date) {
      valid = typeof value === "string" && isValidDateFieldValue(value);
    } else if (
      field.type === FieldType.combo ||
      field.type === FieldType.picture ||
      field.type === FieldType.text
    ) {
      valid =
        typeof value === "string" &&
        ((field.type !== FieldType.combo && field.type !== FieldType.text) ||
          value.length <= maxResponseTextLength);
    } else {
      valid = false;
    }
    if (!valid) {
      fail(
        422,
        "invalid_response_data",
        `${fieldTag} does not match the published Field Manifest`
      );
    }
  }
  const snapshot = response.prefillSnapshot;
  if (snapshot) {
    const snapshotData = jsonRecord(snapshot.values);
    const lockedFields = jsonRecord(snapshot.lockedFields);
    for (const [field, value] of Object.entries(snapshotData)) {
      if (lockedFields[field] === true) {
        data[field] = value;
      }
    }
  }
  if (requireRequired) {
    for (const field of manifest.fields) {
      const value = data[field.tag];
      if (
        field.required &&
        (!Object.hasOwn(data, field.tag) ||
          value === null ||
          (typeof value === "string" && value.trim().length === 0) ||
          (field.type === FieldType.checkbox && value !== true))
      ) {
        fail(
          422,
          "invalid_response_data",
          `${field.tag} is required by the published Field Manifest`
        );
      }
    }
  }
  return data;
}

async function activeAfterRecovery(
  operation: Operation | null
): Promise<boolean> {
  if (!operation) {
    return false;
  }
  const current = await expireOperationIfNeeded(operation);
  return (
    current.status === OperationStatus.pending ||
    current.status === OperationStatus.processing
  );
}

async function activeOperationForForm(formId: string): Promise<boolean> {
  return activeAfterRecovery(
    await prisma.operation.findFirst({
      where: {
        formId,
        status: { in: [OperationStatus.pending, OperationStatus.processing] },
        targetType: OperationTargetType.template_draft,
      },
    })
  );
}

async function activeOperationForResponse(
  responseId: string
): Promise<boolean> {
  return activeAfterRecovery(
    await prisma.operation.findFirst({
      where: {
        responseId,
        status: { in: [OperationStatus.pending, OperationStatus.processing] },
      },
    })
  );
}

async function createOperation(input: {
  actorId: string;
  authorization: ActionEditorAuthorization;
  capabilityScope: Omit<EditorCapabilityScope, "action" | "operationId">;
  documentKey: string;
  formId: string;
  metadata: OperationMetadata;
  ownerUserId: string;
  responseId?: string;
  stagingObjectKey: string;
  submissionId?: string;
  targetId: string;
  targetType: OperationTargetType;
  type: OperationType;
}): Promise<Operation> {
  try {
    return await prisma.$transaction(async (tx) => {
      const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          SELECT "id"
          FROM "forms"
          WHERE "id" = ${input.formId}::uuid
          FOR UPDATE
        `
      );
      if (!lockedForm) {
        fail(404, "not_found", "Form was not found");
      }
      await lockActiveEditorLease(
        tx,
        input.authorization,
        input.capabilityScope
      );
      const activeOperation = await tx.operation.findFirst({
        select: { id: true },
        where: {
          status: { in: [OperationStatus.pending, OperationStatus.processing] },
          targetId: input.targetId,
          targetType: input.targetType,
        },
      });
      if (activeOperation) {
        fail(
          409,
          "operation_in_progress",
          "Another document operation is already in progress"
        );
      }
      return tx.operation.create({
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
    });
  } catch (error) {
    if (databaseErrorCode(error) === "P2002") {
      fail(
        409,
        "operation_in_progress",
        "Another document operation is already in progress"
      );
    }
    throw error;
  }
}

async function updateOperationFailed(
  operationId: string,
  errorCode: OperationErrorCode,
  updatedBefore?: Date
): Promise<boolean> {
  const operation = await prisma.$transaction(async (tx) => {
    const current = await tx.operation.findUnique({
      select: { actorId: true, metadata: true, stagingObjectKey: true },
      where: { id: operationId },
    });
    if (!current) {
      return null;
    }
    const metadata = operationMetadata(current.metadata);
    const failed = await tx.operation.updateMany({
      data: {
        errorCode,
        status: OperationStatus.failed,
        updatedAt: new Date(),
      },
      where: {
        id: operationId,
        ...(updatedBefore ? { updatedAt: { lte: updatedBefore } } : {}),
        status: { in: [OperationStatus.pending, OperationStatus.processing] },
      },
    });
    if (failed.count !== 1) {
      return null;
    }
    if (metadata.action === "save-template" || metadata.action === "publish") {
      let targetId =
        typeof metadata.publicId === "string" &&
        publicIdPattern.test(metadata.publicId)
          ? metadata.publicId
          : null;
      if (!targetId) {
        const targetForm = await tx.form.findUnique({
          select: { publicId: true },
          where: { id: metadata.formId },
        });
        targetId = targetForm?.publicId ?? null;
      }
      await createFormAudit(tx, {
        action:
          metadata.action === "publish"
            ? "publish_form"
            : "save_template_draft",
        actorId: current.actorId,
        outcome: AuditOutcome.failure,
        safeMetadata: { errorCode },
        targetId,
      });
    }
    if (metadata.action === "submit" && metadata.responseId) {
      await tx.response.updateMany({
        data: { status: ResponseStatus.draft, updatedAt: new Date() },
        where: {
          id: metadata.responseId,
          status: ResponseStatus.submitting,
        },
      });
    }
    return { ...current, metadata };
  });
  if (!operation) {
    return false;
  }
  await deleteObjects([operation.stagingObjectKey]);
  await deleteObjectUnlessCanonical(operation.metadata.finalObjectKey);
  return true;
}

async function expireOperationIfNeeded(
  operation: Operation
): Promise<Operation> {
  const active =
    operation.status === OperationStatus.pending ||
    operation.status === OperationStatus.processing;
  const staleBefore = new Date(Date.now() - operationTimeoutMs);
  const stale = operation.updatedAt <= staleBefore;
  if (!active || !stale) {
    return operation;
  }
  await updateOperationFailed(operation.id, "operation_timeout", staleBefore);
  return (
    (await prisma.operation.findUnique({ where: { id: operation.id } })) ??
    operation
  );
}

type CallbackClaimConsumption = "claimed" | "invalid" | "replayed";

async function consumeCallbackClaim(
  operationId: string,
  userdata: string
): Promise<CallbackClaimConsumption> {
  const digest = tokenDigest(userdata);
  const consumed = await prisma.callbackClaim.updateMany({
    data: { consumedAt: new Date() },
    where: {
      consumedAt: null,
      expiresAt: { gt: new Date() },
      operationId,
      tokenDigest: digest,
    },
  });
  if (consumed.count === 1) {
    return "claimed";
  }
  const existing = await prisma.callbackClaim.findFirst({
    select: { consumedAt: true },
    where: { operationId, tokenDigest: digest },
  });
  return existing?.consumedAt ? "replayed" : "invalid";
}

export async function reconcileRecoverableState(): Promise<void> {
  await drainObjectCleanupIntents();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - operationTimeoutMs);
  await prisma.editorLease.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { holderSession: { expiresAt: { lte: now } } },
      ],
    },
  });
  const staleOperations = await prisma.operation.findMany({
    select: { id: true },
    where: {
      status: { in: [OperationStatus.pending, OperationStatus.processing] },
      updatedAt: { lte: staleBefore },
    },
  });
  for (const operation of staleOperations) {
    await updateOperationFailed(operation.id, "operation_timeout", staleBefore);
  }
  await prisma.callbackClaim.deleteMany({
    where: { expiresAt: { lte: now } },
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
      const expiresAtSeconds =
        Math.floor(Date.now() / 1000) + callbackClaimLifetimeSeconds;
      const userdata = createCallbackUserdata({
        documentKey: operation.documentKey,
        expiresAt: expiresAtSeconds,
        operationId: operation.id,
        operationType: operation.type,
      });
      const claimed = await prisma.$transaction(async (tx) => {
        const activated = await tx.operation.updateMany({
          data: { status: OperationStatus.processing, updatedAt: new Date() },
          where: { id: operation.id, status: OperationStatus.pending },
        });
        if (activated.count !== 1) {
          return false;
        }
        await tx.callbackClaim.create({
          data: {
            expiresAt: new Date(expiresAtSeconds * 1000),
            operationId: operation.id,
            tokenDigest: tokenDigest(userdata),
          },
        });
        return true;
      });
      if (!claimed) {
        return;
      }
      const hasChanges = await onlyOffice.forceSave(
        operation.documentKey,
        userdata
      );
      if (!hasChanges) {
        const consumption = await consumeCallbackClaim(operation.id, userdata);
        if (consumption === "replayed") {
          return;
        }
        if (consumption === "invalid") {
          await updateOperationFailed(operation.id, "callback_claim_invalid");
          return;
        }
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
      await updateOperationFailed(
        operation.id,
        error instanceof HttpError && error.code === "invalid_template"
          ? "invalid_template"
          : "force_save_failed"
      );
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
    include: { publishedTemplate: true, templateDraft: true },
    where: { id: metadata.formId },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  if (form.status === FormStatus.published || form.publishedTemplate) {
    fail(
      409,
      "published_immutable",
      "Published forms cannot be structurally edited"
    );
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
  const result = { documentKey: nextDocumentKey, publicId: form.publicId };
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
      const formUpdated = await tx.form.updateMany({
        data: { updatedAt: new Date() },
        where: { id: form.id },
      });
      if (formUpdated.count !== 1) {
        fail(
          409,
          "stale_operation",
          "The form changed while this operation was running"
        );
      }
      await markOperationCompleted(
        tx,
        operation.id,
        result,
        metadata,
        cleanupObjectKeys
      );
      await createFormAudit(tx, {
        action: "save_template_draft",
        actorId: operation.actorId,
        outcome: AuditOutcome.success,
        safeMetadata: {},
        targetId: form.publicId,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}

function publishedContractFields(
  controls: ParsedTemplateField[],
  draftRules: DraftFieldRule[]
): {
  manifestFields: {
    options?: Prisma.InputJsonValue;
    pictureMaxBytes: number | null;
    pictureMaxHeight: number | null;
    pictureMaxWidth: number | null;
    prefillPolicy: PrefillPolicy;
    required: boolean;
    tag: string;
    type: FieldType;
  }[];
  prefillFields: {
    pointer: string;
    policy: PrefillPolicy;
    tag: string;
  }[];
} {
  const controlsByTag = new Map(controls.map((field) => [field.tag, field]));
  const rulesByTag = new Map<string, DraftFieldRule>();
  for (const rule of draftRules) {
    if (rulesByTag.has(rule.tag) || !controlsByTag.has(rule.tag)) {
      fail(
        422,
        "invalid_template",
        `Field policy does not match a published content control: ${rule.tag}`
      );
    }
    validateFieldRulePointer(rule.prefillPointer);
    if (
      rule.prefillPolicy === PrefillPolicy.lock_when_available &&
      rule.prefillPointer === null
    ) {
      fail(
        422,
        "invalid_template",
        `Locked Prefill policy requires a pointer: ${rule.tag}`
      );
    }
    rulesByTag.set(rule.tag, rule);
  }
  return {
    manifestFields: controls.map((field) => {
      const rule = rulesByTag.get(field.tag);
      return {
        ...(field.options ? { options: jsonValue(field.options) } : {}),
        pictureMaxBytes: field.pictureMaxBytes,
        pictureMaxHeight: field.pictureMaxHeight,
        pictureMaxWidth: field.pictureMaxWidth,
        prefillPolicy: rule?.prefillPolicy ?? PrefillPolicy.editable,
        required: rule?.required ?? false,
        tag: field.tag,
        type: field.type,
      };
    }),
    prefillFields: draftRules
      .filter((rule) => rule.prefillPointer !== null)
      .map((rule) => ({
        pointer: rule.prefillPointer as string,
        policy: rule.prefillPolicy,
        tag: rule.tag,
      })),
  };
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
    include: { publishedTemplate: true, templateDraft: true },
    where: { id: metadata.formId },
  });
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  if (form.status === FormStatus.published || form.publishedTemplate) {
    fail(
      409,
      "published_immutable",
      "A Published Template already exists for this Form"
    );
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
  const controls = parseTemplateFields(bytes);
  const hash = contentHash(bytes);
  const result = {
    documentKey: publishedKey,
    publicId: form.publicId,
    version: publishedVersion,
  };
  const cleanupObjectKeys = [metadata.stagedObjectKey];
  await prisma.$transaction(
    async (tx) => {
      const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          SELECT "id"
          FROM "forms"
          WHERE "id" = ${form.id}::uuid
          FOR UPDATE
        `
      );
      if (!lockedForm) {
        fail(404, "not_found", "Form was not found");
      }
      const currentForm = await tx.form.findUnique({
        include: { publishedTemplate: true, templateDraft: true },
        where: { id: form.id },
      });
      if (!currentForm) {
        fail(404, "not_found", "Form was not found");
      }
      if (
        currentForm.status === FormStatus.published ||
        currentForm.publishedTemplate
      ) {
        fail(
          409,
          "published_immutable",
          "A Published Template already exists for this Form"
        );
      }
      if (
        currentForm.version !== form.version ||
        !currentForm.templateDraft ||
        currentForm.templateDraft.documentKey !== documentKey
      ) {
        fail(409, "stale_operation", "The form changed while publishing");
      }
      const draftRules = await tx.draftFieldRule.findMany({
        orderBy: { tag: "asc" },
        where: { templateDraftId: currentForm.templateDraft.id },
      });
      const { manifestFields, prefillFields } = publishedContractFields(
        controls,
        draftRules
      );
      const publishedTemplate = await tx.publishedTemplate.create({
        data: {
          contentHash: hash,
          documentKey: publishedKey,
          form: { connect: { id: currentForm.id } },
          id: crypto.randomUUID(),
          manifest: {
            create: {
              configurationHash: hash,
              fields: { create: manifestFields },
            },
          },
          objectKey: metadata.finalObjectKey,
          version: publishedVersion,
        },
      });
      const prefillConfiguration = await tx.prefillConfiguration.create({
        data: {
          configurationHash: hash,
          formId: currentForm.id,
        },
      });
      if (prefillFields.length > 0) {
        await tx.prefillField.createMany({
          data: prefillFields.map((field) => ({
            ...field,
            configurationId: prefillConfiguration.id,
          })),
        });
      }
      await tx.prefillConfiguration.update({
        data: { publishedTemplateId: publishedTemplate.id },
        where: { id: prefillConfiguration.id },
      });
      const updated = await tx.form.updateMany({
        data: {
          status: FormStatus.published,
          updatedAt: new Date(),
          version: publishedVersion,
        },
        where: {
          id: currentForm.id,
          status: FormStatus.draft,
          version: currentForm.version,
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
      await createFormAudit(tx, {
        action: "publish_form",
        actorId: operation.actorId,
        outcome: AuditOutcome.success,
        safeMetadata: {},
        targetId: currentForm.publicId,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { cleanupObjectKeys };
}
async function validateResponseDocument(
  publishedTemplateId: string,
  bytes: Uint8Array
): Promise<void> {
  const fields = parseTemplateFields(bytes);
  const manifest = await prisma.fieldManifest.findUnique({
    include: { fields: { orderBy: { tag: "asc" } } },
    where: { publishedTemplateId },
  });
  if (!manifest || manifest.fields.length !== fields.length) {
    fail(
      422,
      "invalid_template",
      "The response document does not match the published manifest"
    );
  }
  const fieldsByTag = new Map(fields.map((field) => [field.tag, field]));
  for (const manifestField of manifest.fields) {
    const field = fieldsByTag.get(manifestField.tag);
    const fieldOptions = field?.options;
    const manifestOptions = manifestField.options;
    const optionsMatch =
      (fieldOptions === null && manifestOptions === null) ||
      (Array.isArray(fieldOptions) &&
        Array.isArray(manifestOptions) &&
        manifestOptions.length === fieldOptions.length &&
        fieldOptions.every((option, index) => {
          const manifestOption = manifestOptions[index];
          return (
            typeof manifestOption === "object" &&
            manifestOption !== null &&
            !Array.isArray(manifestOption) &&
            manifestOption.displayText === option.displayText &&
            manifestOption.value === option.value
          );
        }));
    if (
      !field ||
      field.type !== manifestField.type ||
      !optionsMatch ||
      field.pictureMaxBytes !== manifestField.pictureMaxBytes ||
      field.pictureMaxHeight !== manifestField.pictureMaxHeight ||
      field.pictureMaxWidth !== manifestField.pictureMaxWidth
    ) {
      fail(
        422,
        "invalid_template",
        "The response document does not match the published manifest"
      );
    }
  }
}

async function completeDraftOperation(
  operation: Operation,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<OperationCompletion> {
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
  await validateResponseDocument(response.publishedTemplateId, bytes);
  const result = { publicId: metadata.publicId, responseId: response.id };
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
  await validateResponseDocument(response.publishedTemplateId, bytes);

  const submissionDocumentKey = metadata.submissionDocumentKey ?? documentKey;
  const result = {
    publicId: metadata.publicId,
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
  allowedCallbackOrigins: ReadonlySet<string>,
  maximumBytes = maxCallbackDocumentBytes
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
  const callbackUrl = resolveCallbackDocumentUrl(
    payload.url,
    allowedCallbackOrigins
  );
  if (
    typeof payload.key !== "string" ||
    payload.key !== operation.documentKey
  ) {
    await updateOperationFailed(operation.id, "callback_key_mismatch");
    return;
  }
  if (!snapshot && !callbackUrl) {
    await updateOperationFailed(operation.id, "callback_document_unavailable");
    return;
  }

  let bytes = snapshot;
  if (!bytes) {
    if (!callbackUrl) {
      throw new Error("ONLYOFFICE callback document URL is unavailable");
    }
    bytes = await readCallbackDocument(callbackUrl, maximumBytes);
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
    if (metadata.action === "save-template") {
      validateTemplatePackage(bytes);
    } else if (metadata.action === "publish") {
      validateTemplateControls(bytes);
    } else {
      validateOfficeRelationshipsBytes(bytes);
    }
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

type FieldRulePolicy = "editable" | "lock-when-available";
interface FieldRuleInput {
  documentKey: string;
  previousTag: string | null;
  prefillPointer: string | null;
  prefillPolicy: FieldRulePolicy;
  required: boolean;
  tag: string;
}

function fieldRuleDto(rule: {
  prefillPointer: string | null;
  prefillPolicy: PrefillPolicy;
  required: boolean;
  tag: string;
}): {
  prefillPointer: string | null;
  prefillPolicy: FieldRulePolicy;
  required: boolean;
  tag: string;
} {
  return {
    prefillPointer: rule.prefillPointer,
    prefillPolicy:
      rule.prefillPolicy === PrefillPolicy.lock_when_available
        ? "lock-when-available"
        : "editable",
    required: rule.required,
    tag: rule.tag,
  };
}

function fieldRuleTag(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > fieldTagMaximumLength
  ) {
    fail(400, "invalid_field_selection", `${field} is invalid`);
  }
  return value;
}

function fieldRuleInput(input: JsonRecord): FieldRuleInput {
  const expectedKeys = new Set([
    "documentKey",
    "previousTag",
    "tag",
    "required",
    "prefillPointer",
    "prefillPolicy",
  ]);
  const keys = Object.keys(input);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key))
  ) {
    fail(
      400,
      "invalid_field_config",
      "documentKey, previousTag, tag, required, prefillPointer, and prefillPolicy are required"
    );
  }
  if (
    typeof input.documentKey !== "string" ||
    input.documentKey.trim().length === 0
  ) {
    fail(400, "invalid_field_config", "documentKey is required");
  }
  if (typeof input.required !== "boolean") {
    fail(400, "invalid_field_config", "required must be a boolean");
  }
  const tag = fieldRuleTag(input.tag, "tag");
  const previousTag =
    input.previousTag === null
      ? null
      : fieldRuleTag(input.previousTag, "previousTag");
  let prefillPointer: string | null;
  if (input.prefillPointer === null) {
    prefillPointer = null;
  } else if (
    typeof input.prefillPointer !== "string" ||
    input.prefillPointer.length === 0 ||
    input.prefillPointer.length > fieldPointerMaximumLength
  ) {
    fail(400, "invalid_field_config", "prefillPointer is invalid");
  } else {
    prefillPointer = input.prefillPointer;
  }
  if (
    input.prefillPolicy !== "editable" &&
    input.prefillPolicy !== "lock-when-available"
  ) {
    fail(400, "invalid_field_config", "prefillPolicy is invalid");
  }
  if (
    input.prefillPolicy === "lock-when-available" &&
    prefillPointer === null
  ) {
    fail(
      400,
      "invalid_field_config",
      "lock-when-available requires prefillPointer"
    );
  }
  return {
    documentKey: input.documentKey,
    prefillPointer,
    prefillPolicy: input.prefillPolicy,
    previousTag,
    required: input.required,
    tag,
  };
}

function fieldRulePrefillPolicy(policy: FieldRulePolicy): PrefillPolicy {
  return policy === "lock-when-available"
    ? PrefillPolicy.lock_when_available
    : PrefillPolicy.editable;
}

function requireTemplateDraft(
  form: FormWithDocuments,
  missingMessage = "No template DOCX is configured"
): TemplateDraft {
  if (!form.templateDraft) {
    fail(409, "document_unavailable", missingMessage);
  }
  return form.templateDraft;
}

function fieldRuleCapabilityScope(
  form: FormWithDocuments,
  templateDraft: TemplateDraft
): Omit<EditorCapabilityScope, "action" | "operationId"> {
  return {
    documentKey: templateDraft.documentKey,
    formId: form.id,
    targetId: templateDraft.id,
    targetType: "template-draft",
  };
}

function validateFieldRulePointer(prefillPointer: string | null): void {
  if (
    prefillPointer !== null &&
    !externalSchemaItems.some((item) => item.pointer === prefillPointer)
  ) {
    fail(
      400,
      "invalid_field_selection",
      "prefillPointer is not a selectable schema field"
    );
  }
}
async function findFormByPublicId(
  publicId: string
): Promise<FormWithDocuments> {
  if (!publicIdPattern.test(publicId)) {
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
  requestedAction?: string
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
  const capabilityScope = {
    documentKey: response.draftDocumentKey,
    formId: form.id,
    targetId: response.id,
    targetType: "response",
  } as const;
  const lease = await claimEditorLease(
    identity,
    capabilityScope.targetType,
    capabilityScope.targetId,
    form.id
  );
  return editorConfig(
    {
      action:
        requestedAction === "submit"
          ? "submit"
          : requestedAction === "fill"
            ? "fill"
            : "draft",
      capabilities: {
        "save-draft": actionEditorCapability(
          identity,
          capabilityScope,
          "save-draft",
          lease
        ),
        submit: actionEditorCapability(
          identity,
          capabilityScope,
          "submit",
          lease
        ),
      },
      documentKey: response.draftDocumentKey,
      lease: editorLeaseBridge(lease),
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
  const callbackMaximumBytes =
    options.onlyOfficeCallbackMaxBytes ?? maxCallbackDocumentBytes;
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
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-Editor-Capability",
        ],
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
    .post("/api/editor-leases/:id/renew", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Editor lease");
      const lease = await renewEditorLease(identity, params.id);
      return {
        lease: { expiresAt: lease.expiresAt.toISOString(), id: lease.id },
      };
    })
    .delete("/api/editor-leases/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Editor lease");
      await releaseEditorLease(identity, params.id);
      return { ok: true };
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
    .get("/api/admin/users", async ({ request, query }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const queryRecord = query as unknown as JsonRecord;
      const cursor = queryString(queryRecord, "cursor");
      const emailQuery = queryString(queryRecord, "email");
      const roleQuery = queryString(queryRecord, "role");
      const enabledQuery = queryString(queryRecord, "enabled");
      if (cursor !== undefined && !idPattern.test(cursor)) {
        fail(400, "invalid_request", "cursor is invalid");
      }
      const email = emailQuery ? normalizeEmail(emailQuery) : undefined;
      if (email && email.length > accountEmailMaximumLength) {
        fail(400, "invalid_request", "email filter is too long");
      }
      let role: UserRole | undefined;
      if (roleQuery !== undefined) {
        if (roleQuery !== "admin" && roleQuery !== "user") {
          fail(400, "invalid_request", "role must be admin or user");
        }
        role = roleQuery;
      }
      let enabled: boolean | undefined;
      if (enabledQuery !== undefined) {
        if (enabledQuery !== "true" && enabledQuery !== "false") {
          fail(400, "invalid_request", "enabled must be true or false");
        }
        enabled = enabledQuery === "true";
      }
      const where: Prisma.UserWhereInput = {};
      if (cursor) {
        where.id = { gt: cursor };
      }
      if (email) {
        where.email = { contains: email };
      }
      if (role) {
        where.role = role;
      }
      if (enabled !== undefined) {
        where.enabled = enabled;
      }
      const users = await prisma.user.findMany({
        orderBy: { id: "asc" },
        select: adminUserSelect,
        take: accountUserPageSize + 1,
        where,
      });
      const page = users.slice(0, accountUserPageSize);
      return {
        nextCursor:
          users.length > accountUserPageSize ? (page.at(-1)?.id ?? null) : null,
        users: page.map(accountUserSummary),
      };
    })
    .post(
      "/api/admin/users",
      ({ request }) =>
        withAdminMutation(request, "create_user", null, async (identity) => {
          const input = await readJsonRecord(request, accountBodyMaximumBytes);
          const keys = Object.keys(input);
          if (
            keys.length !== 3 ||
            keys.some(
              (key) => key !== "name" && key !== "email" && key !== "role"
            )
          ) {
            fail(400, "invalid_request", "name, email, and role are required");
          }
          const name = requiredString(input, "name");
          if (name.length > accountNameMaximumLength) {
            fail(400, "invalid_request", "name is too long");
          }
          const email = normalizedAccountEmail(requiredString(input, "email"));
          const roleValue = requiredString(input, "role");
          if (roleValue !== "admin" && roleValue !== "user") {
            fail(400, "invalid_request", "role must be admin or user");
          }
          const temporaryPassword = generateTemporaryPassword();
          const user = await accountTransaction(identity, async (tx) => {
            const existing = await tx.user.findUnique({
              select: { id: true },
              where: { email },
            });
            if (existing) {
              fail(409, "email_in_use", "Email is already in use");
            }
            const authContext = await auth.$context;
            const passwordHash =
              await authContext.password.hash(temporaryPassword);
            const userId = crypto.randomUUID();
            const created = await tx.user.create({
              data: {
                accounts: {
                  create: {
                    accountId: userId,
                    id: crypto.randomUUID(),
                    issuer: "local:credential",
                    password: passwordHash,
                    providerId: "credential",
                  },
                },
                email,
                emailVerified: true,
                enabled: true,
                id: userId,
                mustChangePassword: true,
                name,
                role: roleValue,
              },
              select: adminUserSelect,
            });
            await createAccountAudit(tx, {
              action: "create_user",
              actorId: identity.id,
              outcome: AuditOutcome.success,
              safeMetadata: { change: "created" },
              targetId: created.id,
            });
            return created;
          });
          return {
            temporaryPassword,
            user: accountUserSummary(user),
          };
        }),
      { parse: "none" }
    )
    .patch(
      "/api/admin/users/:id",
      ({ request, params }) =>
        withAdminMutation(
          request,
          "update_user",
          accountAuditTargetId(params.id),
          async (identity, setAction) => {
            const userId = validateId(params.id, "User");
            const input = await readJsonRecord(
              request,
              accountBodyMaximumBytes
            );
            const keys = Object.keys(input);
            const key = keys[0];
            if (
              keys.length !== 1 ||
              (key !== "enabled" && key !== "email" && key !== "role")
            ) {
              fail(
                400,
                "invalid_request",
                "Exactly one of enabled, email, or role is required"
              );
            }
            let action: AccountAuditAction = "update_user";
            let change = "updated";
            let updateData: Prisma.UserUpdateInput;
            let newEmail: string | undefined;
            let revokeSessions = false;
            if (key === "enabled") {
              if (typeof input.enabled !== "boolean") {
                fail(400, "invalid_request", "enabled must be a boolean");
              }
              action = input.enabled ? "enable_user" : "disable_user";
              change = input.enabled ? "enabled" : "disabled";
              revokeSessions = !input.enabled;
              updateData = { enabled: input.enabled };
            } else if (key === "email") {
              if (typeof input.email !== "string") {
                fail(400, "invalid_request", "email is required");
              }
              newEmail = normalizedAccountEmail(input.email);
              action = "change_user_email";
              change = "email_changed";
              revokeSessions = true;
              updateData = { email: newEmail };
            } else {
              if (input.role !== "admin" && input.role !== "user") {
                fail(400, "invalid_request", "role must be admin or user");
              }
              action = input.role === "admin" ? "promote_user" : "demote_user";
              change = input.role === "admin" ? "promoted" : "demoted";
              revokeSessions = true;
              updateData = { role: input.role };
            }
            setAction(action);
            const user = await accountTransaction(identity, async (tx) => {
              const target = await lockAccountUser(tx, userId);
              const removesFinalAdmin =
                target.role === "admin" &&
                target.enabled &&
                (updateData.enabled === false || updateData.role === "user");
              if (removesFinalAdmin) {
                const enabledAdminCount = await tx.user.count({
                  where: { enabled: true, role: "admin" },
                });
                if (enabledAdminCount <= 1) {
                  fail(
                    409,
                    "final_admin_required",
                    "At least one enabled Admin is required"
                  );
                }
              }
              if (newEmail !== undefined) {
                const existing = await tx.user.findUnique({
                  select: { id: true },
                  where: { email: newEmail },
                });
                if (existing && existing.id !== target.id) {
                  fail(409, "email_in_use", "Email is already in use");
                }
              }
              const updated = await tx.user.update({
                data: updateData,
                select: adminUserSelect,
                where: { id: target.id },
              });
              if (revokeSessions) {
                await tx.session.deleteMany({ where: { userId: target.id } });
              }
              await createAccountAudit(tx, {
                action,
                actorId: identity.id,
                outcome: AuditOutcome.success,
                safeMetadata: { change },
                targetId: target.id,
              });
              return updated;
            });
            return { user: accountUserSummary(user) };
          }
        ),
      { parse: "none" }
    )
    .post(
      "/api/admin/users/:id/password-reset",
      ({ request, params }) =>
        withAdminMutation(
          request,
          "reset_user_password",
          accountAuditTargetId(params.id),
          async (identity) => {
            const userId = validateId(params.id, "User");
            const temporaryPassword = generateTemporaryPassword();
            const user = await accountTransaction(identity, async (tx) => {
              const target = await lockAccountUser(tx, userId);
              const account = await tx.account.findFirst({
                where: { providerId: "credential", userId: target.id },
              });
              if (!account?.password) {
                fail(500, "credential_missing", "Credential is unavailable");
              }
              const authContext = await auth.$context;
              const passwordHash =
                await authContext.password.hash(temporaryPassword);
              await tx.account.update({
                data: { password: passwordHash },
                where: { id: account.id },
              });
              const updated = await tx.user.update({
                data: { mustChangePassword: true },
                select: adminUserSelect,
                where: { id: target.id },
              });
              await tx.session.deleteMany({ where: { userId: target.id } });
              await createAccountAudit(tx, {
                action: "reset_user_password",
                actorId: identity.id,
                outcome: AuditOutcome.success,
                safeMetadata: { change: "password_reset" },
                targetId: target.id,
              });
              return updated;
            });
            return {
              temporaryPassword,
              user: accountUserSummary(user),
            };
          }
        ),
      { parse: "none" }
    )

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
          _count: {
            select: {
              responses: { where: { status: ResponseStatus.draft } },
              submissions: true,
            },
          },
          publishedTemplate: true,
          templateDraft: true,
        },
        orderBy: { updatedAt: "desc" },
      });
      const forms = items.map((item) =>
        formDto(item, {
          activeDraftCount: item._count.responses,
          submissionCount: item._count.submissions,
        })
      );
      return { forms };
    })
    .patch("/api/admin/forms/:publicId", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const auditTarget = publicIdPattern.test(params.publicId)
        ? params.publicId
        : null;
      let auditAction: FormAuditAction = "update_form_metadata";
      try {
        const input = await readFormMetadataInput(request);
        auditAction =
          input.status === FormStatus.archived
            ? "archive_form"
            : input.status === FormStatus.published
              ? "unarchive_form"
              : "update_form_metadata";
        const updated = await prisma.$transaction(async (tx) => {
          if (!publicIdPattern.test(params.publicId)) {
            fail(404, "not_found", "Form was not found");
          }
          const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
            Prisma.sql`
              SELECT "id"
              FROM "forms"
              WHERE "public_id" = ${params.publicId}
              FOR UPDATE
            `
          );
          if (!lockedForm) {
            fail(404, "not_found", "Form was not found");
          }
          const current = await tx.form.findUnique({
            include: { publishedTemplate: true, templateDraft: true },
            where: { id: lockedForm.id },
          });
          if (!current) {
            fail(404, "not_found", "Form was not found");
          }
          if (
            input.status !== undefined &&
            (!current.publishedTemplate ||
              (current.status !== FormStatus.published &&
                current.status !== FormStatus.archived))
          ) {
            fail(
              409,
              "form_not_published",
              "Only a published Form can change archive state"
            );
          }
          const form = await tx.form.update({
            data: {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(Object.hasOwn(input, "description")
                ? { description: input.description }
                : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
            },
            include: { publishedTemplate: true, templateDraft: true },
            where: { id: current.id },
          });
          await createFormAudit(tx, {
            action: auditAction,
            actorId: identity.id,
            outcome: AuditOutcome.success,
            safeMetadata:
              input.status === undefined ? {} : { status: input.status },
            targetId: form.publicId,
          });
          return form;
        });
        const [activeDraftCount, submissionCount] = await Promise.all([
          prisma.response.count({
            where: { formId: updated.id, status: ResponseStatus.draft },
          }),
          prisma.submission.count({ where: { formId: updated.id } }),
        ]);
        return {
          form: formDto(updated, { activeDraftCount, submissionCount }),
        };
      } catch (error) {
        try {
          await createFormFailureAudit({
            action: auditAction,
            actorId: identity.id,
            error,
            targetId: auditTarget,
          });
        } catch {
          // Preserve the route error if the failure audit cannot be persisted.
        }
        throw error;
      }
    })
    .post(
      "/api/admin/forms/:publicId/duplicate",
      async ({ request, params }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const auditTarget = publicIdPattern.test(params.publicId)
          ? params.publicId
          : null;
        let duplicateObjectKey: string | undefined;
        try {
          const input = await readJsonRecord(
            request,
            documentActionBodyMaximumBytes
          );
          if (Object.keys(input).length !== 0) {
            fail(400, "invalid_request", "Duplicate requests must be empty");
          }
          if (!publicIdPattern.test(params.publicId)) {
            fail(404, "not_found", "Form was not found");
          }
          const source = await prisma.form.findUnique({
            include: {
              publishedTemplate: {
                include: {
                  manifest: { include: { fields: true } },
                  prefillConfiguration: { include: { fields: true } },
                },
              },
              templateDraft: { include: { fieldRules: true } },
            },
            where: { publicId: params.publicId },
          });
          if (!source) {
            fail(404, "not_found", "Form was not found");
          }
          const sourceDocument =
            source.publishedTemplate ?? source.templateDraft;
          if (!sourceDocument) {
            fail(409, "document_unavailable", "The Form DOCX is unavailable");
          }
          if (!(await objectExists(sourceDocument.objectKey))) {
            fail(409, "document_unavailable", "The Form DOCX is unavailable");
          }
          const sourceBytes = await readObject(sourceDocument.objectKey);
          const duplicateId = crypto.randomUUID();
          const duplicatePublicId = crypto.randomUUID().replaceAll("-", "");
          duplicateObjectKey = objectKey(
            "forms",
            duplicateId,
            "template-draft",
            crypto.randomUUID(),
            "docx"
          );
          const duplicateDocumentKey = `template-${crypto.randomUUID()}`;
          const sourcePrefillFields =
            source.publishedTemplate?.prefillConfiguration?.fields ?? [];
          const sourceRules =
            source.publishedTemplate?.manifest?.fields.map((field) => {
              const prefill = sourcePrefillFields.find(
                (candidate) => candidate.tag === field.tag
              );
              return {
                prefillPointer: prefill?.pointer ?? null,
                prefillPolicy: prefill?.policy ?? field.prefillPolicy,
                required: field.required,
                tag: field.tag,
              };
            }) ??
            source.templateDraft?.fieldRules.map((field) => ({
              prefillPointer: field.prefillPointer,
              prefillPolicy: field.prefillPolicy,
              required: field.required,
              tag: field.tag,
            })) ??
            [];
          await prisma.objectCleanupIntent.create({
            data: {
              cleanupAfter: new Date(Date.now() + objectCleanupIntentGraceMs),
              objectKey: duplicateObjectKey,
            },
          });
          await putObject(duplicateObjectKey, sourceBytes, DOCX_CONTENT_TYPE);
          const duplicate = await prisma.$transaction(async (tx) => {
            const created = await tx.form.create({
              data: {
                creator: { connect: { id: identity.id } },
                description: source.description,
                id: duplicateId,
                publicId: duplicatePublicId,
                templateDraft: {
                  create: {
                    contentHash:
                      sourceDocument.contentHash ?? contentHash(sourceBytes),
                    documentKey: duplicateDocumentKey,
                    fieldRules: { create: sourceRules },
                    objectKey: duplicateObjectKey as string,
                  },
                },
                title: source.title,
              },
              include: { publishedTemplate: true, templateDraft: true },
            });
            await createFormAudit(tx, {
              action: "duplicate_form",
              actorId: identity.id,
              outcome: AuditOutcome.success,
              safeMetadata: { sourcePublicId: source.publicId },
              targetId: duplicatePublicId,
            });
            await tx.objectCleanupIntent.delete({
              where: { objectKey: duplicateObjectKey },
            });
            return created;
          });
          return {
            form: formDto(duplicate, {
              activeDraftCount: 0,
              submissionCount: 0,
            }),
          };
        } catch (error) {
          if (duplicateObjectKey) {
            await prisma.objectCleanupIntent.updateMany({
              data: { cleanupAfter: new Date() },
              where: { objectKey: duplicateObjectKey },
            });
            await drainObjectCleanupIntents([duplicateObjectKey]);
          }
          try {
            await createFormFailureAudit({
              action: "duplicate_form",
              actorId: identity.id,
              error,
              targetId: auditTarget,
            });
          } catch {
            // Preserve the route error if the failure audit cannot be persisted.
          }
          throw error;
        }
      }
    )
    .delete("/api/admin/forms/:publicId", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const publicId = params.publicId;
      const auditTarget = publicIdPattern.test(publicId) ? publicId : null;
      try {
        const { objectKeys: objectKeysToDelete } = await prisma.$transaction(
          async (tx) => {
            if (!publicIdPattern.test(publicId)) {
              fail(404, "not_found", "Form was not found");
            }
            const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
              Prisma.sql`
                  SELECT "id"
                  FROM "forms"
                  WHERE "public_id" = ${publicId}
                  FOR UPDATE
                `
            );
            if (!lockedForm) {
              fail(404, "not_found", "Form was not found");
            }
            const form = await tx.form.findUnique({
              include: {
                publishedTemplate: true,
                templateDraft: true,
              },
              where: { id: lockedForm.id },
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
            if (form.templateDraft) {
              const now = new Date();
              const activeLease = await tx.editorLease.findFirst({
                select: {
                  holderSessionId: true,
                  holderUserId: true,
                },
                where: {
                  expiresAt: { gt: now },
                  holderSession: { expiresAt: { gt: now } },
                  targetId: form.templateDraft.id,
                  targetType: OperationTargetType.template_draft,
                },
              });
              const competingLease =
                activeLease &&
                (activeLease.holderUserId !== identity.id ||
                  activeLease.holderSessionId !== identity.sessionId);
              if (competingLease) {
                fail(
                  409,
                  "editor_in_use",
                  "Another Admin is editing this Template Draft"
                );
              }
            }

            const activeOperations = await tx.operation.findMany({
              select: {
                actorId: true,
                id: true,
                metadata: true,
                stagingObjectKey: true,
                updatedAt: true,
              },
              where: {
                formId: form.id,
                status: {
                  in: [OperationStatus.pending, OperationStatus.processing],
                },
              },
            });
            for (const operation of activeOperations) {
              if (
                Date.now() - operation.updatedAt.getTime() <
                operationTimeoutMs
              ) {
                fail(
                  409,
                  "operation_in_progress",
                  "Wait for the draft operation to finish before removing this form"
                );
              }
              const failed = await tx.operation.updateMany({
                data: {
                  errorCode: "operation_timeout",
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
              if (failed.count === 1) {
                const metadata = asRecord(operation.metadata);
                if (
                  metadata.action === "save-template" ||
                  metadata.action === "publish"
                ) {
                  await createFormAudit(tx, {
                    action:
                      metadata.action === "publish"
                        ? "publish_form"
                        : "save_template_draft",
                    actorId: operation.actorId,
                    outcome: AuditOutcome.failure,
                    safeMetadata: { errorCode: "operation_timeout" },
                    targetId: form.publicId,
                  });
                }
              }
            }

            const [responseCount, snapshotCount, submissionCount] =
              await Promise.all([
                tx.response.count({ where: { formId: form.id } }),
                tx.prefillSnapshot.count({ where: { formId: form.id } }),
                tx.submission.count({ where: { formId: form.id } }),
              ]);
            if (responseCount > 0 || snapshotCount > 0 || submissionCount > 0) {
              fail(
                409,
                "form_has_responses",
                "A form with responses cannot be removed"
              );
            }

            const formOperations = await tx.operation.findMany({
              select: { metadata: true, stagingObjectKey: true },
              where: { formId: form.id },
            });
            const objectKeys = uniqueObjectKeys([
              form.templateDraft?.objectKey,
              form.publishedTemplate?.objectKey,
              ...formOperations.flatMap((operation) => {
                const metadata = asRecord(operation.metadata);
                return [
                  operation.stagingObjectKey,
                  typeof metadata.finalObjectKey === "string"
                    ? metadata.finalObjectKey
                    : undefined,
                  ...(Array.isArray(metadata.cleanupObjectKeys)
                    ? metadata.cleanupObjectKeys.filter(
                        (key): key is string => typeof key === "string"
                      )
                    : []),
                ];
              }),
            ]);
            if (objectKeys.length > 0) {
              await tx.objectCleanupIntent.createMany({
                data: objectKeys.map((objectKeyValue) => ({
                  objectKey: objectKeyValue,
                })),
                skipDuplicates: true,
              });
            }
            if (form.templateDraft) {
              await tx.editorLease.deleteMany({
                where: {
                  targetId: form.templateDraft.id,
                  targetType: OperationTargetType.template_draft,
                },
              });
            }
            await tx.operation.deleteMany({ where: { formId: form.id } });
            await createFormAudit(tx, {
              action: "delete_form",
              actorId: identity.id,
              outcome: AuditOutcome.success,
              safeMetadata: {},
              targetId: form.publicId,
            });
            const deleted = await tx.form.deleteMany({
              where: {
                id: form.id,
                status: FormStatus.draft,
                version: 0,
              },
            });
            if (deleted.count !== 1) {
              fail(409, "form_not_draft", "Only draft forms can be removed");
            }
            return { objectKeys };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        await drainObjectCleanupIntents(objectKeysToDelete);
        return { deleted: true };
      } catch (error) {
        try {
          await createFormFailureAudit({
            action: "delete_form",
            actorId: identity.id,
            error,
            targetId: auditTarget,
          });
        } catch {
          // Preserve the route error if the failure audit cannot be persisted.
        }
        throw error;
      }
    })
    .post(
      "/api/admin/forms",
      async ({ request }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const id = crypto.randomUUID();
        const publicId = crypto.randomUUID().replaceAll("-", "");
        let source: FormSource | undefined;
        let templateObjectKey: string | undefined;
        try {
          const input = await readTemplateCreationInput(request);
          source = input.source;
          let templateBytes: Uint8Array | undefined = input.templateBytes;
          if (input.source === "blank") {
            const sourcePath = await findTemplateSource();
            if (sourcePath) {
              templateBytes = await readTemplateSourceBytes(sourcePath);
            }
          }
          if (!templateBytes) {
            fail(
              409,
              "blank_template_unavailable",
              "The configured blank template is unavailable"
            );
          }
          if (input.source === "upload") {
            validateTemplatePackage(templateBytes);
          }
          templateObjectKey = objectKey(
            "forms",
            id,
            "template-draft",
            crypto.randomUUID(),
            "docx"
          );
          const templateDocumentKey = `template-${crypto.randomUUID()}`;
          await prisma.objectCleanupIntent.create({
            data: {
              cleanupAfter: new Date(Date.now() + objectCleanupIntentGraceMs),
              objectKey: templateObjectKey,
            },
          });
          await putObject(templateObjectKey, templateBytes, DOCX_CONTENT_TYPE);
          const form = await prisma.$transaction(async (tx) => {
            const created = await tx.form.create({
              data: {
                creator: { connect: { id: identity.id } },
                description: input.description,
                id,
                publicId,
                templateDraft: {
                  create: {
                    contentHash: contentHash(templateBytes),
                    documentKey: templateDocumentKey,
                    objectKey: templateObjectKey as string,
                  },
                },
                title: input.title,
              },
              include: { publishedTemplate: true, templateDraft: true },
            });
            await createFormAudit(tx, {
              action: "create_form",
              actorId: identity.id,
              outcome: AuditOutcome.success,
              safeMetadata: { source: input.source },
              targetId: publicId,
            });
            await tx.objectCleanupIntent.delete({
              where: { objectKey: templateObjectKey },
            });
            return created;
          });
          return {
            form: formDto(form, {
              activeDraftCount: 0,
              submissionCount: 0,
            }),
          };
        } catch (error) {
          if (templateObjectKey) {
            await prisma.objectCleanupIntent.updateMany({
              data: { cleanupAfter: new Date() },
              where: { objectKey: templateObjectKey },
            });
            await drainObjectCleanupIntents([templateObjectKey]);
          }
          try {
            await createFormFailureAudit({
              action: "create_form",
              actorId: identity.id,
              error,
              source,
              targetId: null,
            });
          } catch {
            // Preserve the route error if the failure audit cannot be persisted.
          }
          throw error;
        }
      },
      { parse: "none" }
    )
    .get("/api/admin/forms/:publicId", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormByPublicId(params.publicId);
      const [activeDraftCount, submissionCount] = await Promise.all([
        prisma.response.count({
          where: { formId: form.id, status: ResponseStatus.draft },
        }),
        prisma.submission.count({ where: { formId: form.id } }),
      ]);
      return {
        editorConfigUrl: `/api/admin/forms/${form.publicId}/editor-config`,
        form: formDto(form, { activeDraftCount, submissionCount }),
      };
    })
    .get(
      "/api/admin/forms/:publicId/editor-config",
      async ({ request, params }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const form = await findFormByPublicId(params.publicId);
        if (form.status === FormStatus.published || form.publishedTemplate) {
          fail(
            409,
            "published_immutable",
            "Published forms cannot be structurally edited"
          );
        }
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
        const capabilityScope = {
          documentKey: templateDraft.documentKey,
          formId: form.id,
          targetId: templateDraft.id,
          targetType: "template-draft",
        } as const;
        const lease = await claimEditorLease(
          identity,
          capabilityScope.targetType,
          capabilityScope.targetId,
          form.id
        );
        return editorConfig(
          {
            action: "template-edit",
            capabilities: {
              "configure-fields": actionEditorCapability(
                identity,
                capabilityScope,
                "configure-fields",
                lease
              ),
              publish: actionEditorCapability(
                identity,
                capabilityScope,
                "publish",
                lease
              ),
              "save-template": actionEditorCapability(
                identity,
                capabilityScope,
                "save-template",
                lease
              ),
            },
            documentKey: templateDraft.documentKey,
            lease: editorLeaseBridge(lease),
            publicId: form.publicId,
          },
          identity
        );
      }
    )
    .get(
      "/api/admin/forms/:publicId/schema",
      async ({ request, params, query }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const form = await findFormByPublicId(params.publicId);
        if (form.status === FormStatus.published || form.publishedTemplate) {
          fail(
            409,
            "published_immutable",
            "Published forms cannot change Field rules"
          );
        }
        const templateDraft = requireTemplateDraft(form);
        const capabilityScope = fieldRuleCapabilityScope(form, templateDraft);
        requireEditorScope(authorization, {
          ...capabilityScope,
          action: "configure-fields",
        });
        await requireActiveEditorLease(authorization, capabilityScope);
        const queryRecord = query as unknown as JsonRecord;
        return schemaPage(queryRecord.q, queryRecord.cursor);
      }
    )
    .get(
      "/api/admin/forms/:publicId/field-rules",
      async ({ request, params }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const form = await findFormByPublicId(params.publicId);
        if (form.status === FormStatus.published || form.publishedTemplate) {
          fail(
            409,
            "published_immutable",
            "Published forms cannot change Field rules"
          );
        }
        const templateDraft = requireTemplateDraft(form);
        const capabilityScope = fieldRuleCapabilityScope(form, templateDraft);
        requireEditorScope(authorization, {
          ...capabilityScope,
          action: "configure-fields",
        });
        await requireActiveEditorLease(authorization, capabilityScope);
        const rules = await prisma.draftFieldRule.findMany({
          orderBy: { tag: "asc" },
          select: {
            prefillPointer: true,
            prefillPolicy: true,
            required: true,
            tag: true,
          },
          where: { templateDraftId: templateDraft.id },
        });
        return { rules: rules.map(fieldRuleDto) };
      }
    )
    .patch(
      "/api/admin/forms/:publicId/field-rules",
      async ({ request, params }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const form = await findFormByPublicId(params.publicId);
        if (form.status === FormStatus.published || form.publishedTemplate) {
          fail(
            409,
            "published_immutable",
            "Published forms cannot change Field rules"
          );
        }
        const templateDraft = requireTemplateDraft(form);
        const capabilityScope = fieldRuleCapabilityScope(form, templateDraft);
        requireEditorScope(authorization, {
          ...capabilityScope,
          action: "configure-fields",
        });
        await requireActiveEditorLease(authorization, capabilityScope);
        const input = fieldRuleInput(
          await readJsonRecord(request, fieldRuleBodyMaximumBytes)
        );
        if (input.documentKey !== templateDraft.documentKey) {
          fail(
            409,
            "stale_document",
            "The editor document is no longer current"
          );
        }
        validateFieldRulePointer(input.prefillPointer);
        let rule: DraftFieldRule;
        try {
          rule = await prisma.$transaction(
            async (tx) => {
              await lockActiveEditorLease(tx, authorization, capabilityScope);
              const [lockedForm] = await tx.$queryRaw<{ id: string }[]>(
                Prisma.sql`
                  SELECT "id"
                  FROM "forms"
                  WHERE "id" = ${form.id}::uuid
                  FOR UPDATE
                `
              );
              if (!lockedForm) {
                fail(404, "not_found", "Form was not found");
              }
              const currentForm = await tx.form.findUnique({
                select: {
                  publishedTemplate: { select: { id: true } },
                  status: true,
                  templateDraft: {
                    select: { documentKey: true, id: true },
                  },
                  version: true,
                },
                where: { id: form.id },
              });
              if (
                !currentForm ||
                currentForm.status === FormStatus.published ||
                currentForm.publishedTemplate
              ) {
                fail(
                  409,
                  "published_immutable",
                  "Published forms cannot change Field rules"
                );
              }
              if (
                currentForm.version !== form.version ||
                currentForm.templateDraft?.id !== templateDraft.id ||
                currentForm.templateDraft?.documentKey !==
                  templateDraft.documentKey
              ) {
                fail(
                  409,
                  "stale_document",
                  "The editor document is no longer current"
                );
              }
              const previousRule = input.previousTag
                ? await tx.draftFieldRule.findUnique({
                    where: {
                      templateDraftId_tag: {
                        tag: input.previousTag,
                        templateDraftId: templateDraft.id,
                      },
                    },
                  })
                : null;
              if (input.previousTag !== null && !previousRule) {
                fail(
                  400,
                  "invalid_field_selection",
                  "previousTag does not identify a configured field"
                );
              }
              const targetRule = await tx.draftFieldRule.findUnique({
                where: {
                  templateDraftId_tag: {
                    tag: input.tag,
                    templateDraftId: templateDraft.id,
                  },
                },
              });
              if (targetRule && targetRule.id !== previousRule?.id) {
                fail(
                  409,
                  "field_rule_conflict",
                  "The field tag is already configured"
                );
              }
              const pointerRule =
                input.prefillPointer === null
                  ? null
                  : await tx.draftFieldRule.findFirst({
                      where: {
                        prefillPointer: input.prefillPointer,
                        templateDraftId: templateDraft.id,
                      },
                    });
              if (pointerRule && pointerRule.id !== previousRule?.id) {
                fail(
                  409,
                  "field_rule_conflict",
                  "The schema pointer is already configured"
                );
              }
              const data = {
                prefillPointer: input.prefillPointer,
                prefillPolicy: fieldRulePrefillPolicy(input.prefillPolicy),
                required: input.required,
                tag: input.tag,
              };
              let persistedRule: DraftFieldRule;
              if (previousRule && previousRule.tag !== input.tag) {
                await tx.draftFieldRule.delete({
                  where: { id: previousRule.id },
                });
                persistedRule = await tx.draftFieldRule.create({
                  data: { ...data, templateDraftId: templateDraft.id },
                });
              } else if (previousRule) {
                persistedRule = await tx.draftFieldRule.update({
                  data,
                  where: { id: previousRule.id },
                });
              } else {
                persistedRule = await tx.draftFieldRule.create({
                  data: { ...data, templateDraftId: templateDraft.id },
                });
              }
              await createFormAudit(tx, {
                action: "configure_field_rule",
                actorId: identity.id,
                outcome: AuditOutcome.success,
                safeMetadata: {},
                targetId: form.publicId,
              });
              return persistedRule;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );
        } catch (error) {
          try {
            await createFormFailureAudit({
              action: "configure_field_rule",
              actorId: identity.id,
              error,
              targetId: form.publicId,
            });
          } catch {
            // Preserve the route error if the failure audit cannot be persisted.
          }
          if (databaseErrorCode(error) === "P2002") {
            fail(
              409,
              "field_rule_conflict",
              "The field tag or schema pointer is already configured"
            );
          }
          throw error;
        }
        return { rule: fieldRuleDto(rule) };
      },
      { parse: "none" }
    )
    .post(
      "/api/admin/forms/:publicId/save",
      async ({ request, params, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const publicId = params.publicId;
        try {
          const form = await findFormByPublicId(publicId);
          if (form.status === FormStatus.published || form.publishedTemplate) {
            fail(
              409,
              "published_immutable",
              "Published forms cannot be structurally edited"
            );
          }
          const templateDraft = form.templateDraft;
          if (!templateDraft) {
            fail(409, "document_unavailable", "No template DOCX is configured");
          }
          const capabilityScope = {
            documentKey: templateDraft.documentKey,
            formId: form.id,
            targetId: templateDraft.id,
            targetType: "template-draft",
          } as const;
          requireEditorScope(authorization, {
            ...capabilityScope,
            action: "save-template",
          });
          await requireActiveEditorLease(authorization, capabilityScope);
          const documentKey = await readDocumentKeyInput(request);
          if (templateDraft.documentKey !== documentKey) {
            fail(
              409,
              "stale_document",
              "The editor document is no longer current"
            );
          }
          if (await activeOperationForForm(form.id)) {
            fail(
              409,
              "operation_in_progress",
              "A template save is already in progress"
            );
          }
          const operationId = crypto.randomUUID();
          const nextDocumentKey = `template-${crypto.randomUUID()}`;
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
            publicId: form.publicId,
            result: { documentKey: nextDocumentKey },
            stagedObjectKey,
          };
          const operation = await createOperation({
            actorId: identity.id,
            authorization,
            capabilityScope,
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
          return {
            operationCapability: operationEditorCapability(
              identity,
              capabilityScope,
              operation.id
            ),
            operationId: operation.id,
            status: operation.status,
          };
        } catch (error) {
          try {
            await createFormFailureAudit({
              action: "save_template_draft",
              actorId: identity.id,
              error,
              targetId: publicIdPattern.test(publicId) ? publicId : null,
            });
          } catch {
            // Preserve the route error if the failure audit cannot be persisted.
          }
          throw error;
        }
      },
      { parse: "none" }
    )
    .post(
      "/api/admin/forms/:publicId/publish",
      async ({ request, params, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        try {
          const form = await findFormByPublicId(params.publicId);
          if (form.status === FormStatus.published || form.publishedTemplate) {
            fail(
              409,
              "published_immutable",
              "A Published Template already exists for this Form"
            );
          }
          const templateDraft = form.templateDraft;
          if (!templateDraft) {
            fail(409, "document_unavailable", "No template DOCX is configured");
          }
          const capabilityScope = {
            documentKey: templateDraft.documentKey,
            formId: form.id,
            targetId: templateDraft.id,
            targetType: "template-draft",
          } as const;
          requireEditorScope(authorization, {
            ...capabilityScope,
            action: "publish",
          });
          await requireActiveEditorLease(authorization, capabilityScope);
          const documentKey = await readDocumentKeyInput(request);
          if (templateDraft.documentKey !== documentKey) {
            fail(
              409,
              "stale_document",
              "The editor document is no longer current"
            );
          }
          if (await activeOperationForForm(form.id)) {
            fail(
              409,
              "operation_in_progress",
              "A publish operation is already in progress"
            );
          }
          const operationId = crypto.randomUUID();
          const version = form.version + 1;
          const publishedKey = `published-${version}-${crypto.randomUUID()}`;
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
            publicId: form.publicId,
            publishedKey,
            publishedVersion: version,
            stagedObjectKey,
          };
          const operation = await createOperation({
            actorId: identity.id,
            authorization,
            capabilityScope,
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
          return {
            operationCapability: operationEditorCapability(
              identity,
              capabilityScope,
              operation.id
            ),
            operationId: operation.id,
            status: operation.status,
          };
        } catch (error) {
          try {
            await createFormFailureAudit({
              action: "publish_form",
              actorId: identity.id,
              error,
              targetId: publicIdPattern.test(params.publicId)
                ? params.publicId
                : null,
            });
          } catch {
            // Preserve the route error if the failure audit cannot be persisted.
          }
          throw error;
        }
      },
      { parse: "none" }
    )
    .get(
      "/api/admin/forms/:publicId/submissions",
      async ({ request, params }) => {
        const identity = await requireIdentity(request);
        requireAdmin(identity);
        const form = await findFormByPublicId(params.publicId);
        const submissions = await prisma.submission.findMany({
          include: { form: true, owner: true },
          orderBy: { createdAt: "desc" },
          where: { formId: form.id },
        });
        return {
          submissions: submissions.map((submission) =>
            submissionSummary(submission, {
              formPublicId: submission.form.publicId,
              formTitle: submission.form.title,
              userEmail: submission.owner.email,
            })
          ),
        };
      }
    )
    .get("/api/forms/:publicId", async ({ params, request }) => {
      const identity = await requireIdentity(request);
      const form = await findFormByPublicId(params.publicId);
      if (
        !form.publishedTemplate?.objectKey ||
        !form.publishedTemplate.documentKey
      ) {
        fail(404, "not_found", "Form was not found");
      }
      if (form.status === FormStatus.archived) {
        const existingResponse = await prisma.response.findUnique({
          select: { id: true },
          where: {
            formId_userId: { formId: form.id, userId: identity.id },
          },
        });
        if (!existingResponse) {
          fail(404, "not_found", "Form was not found");
        }
      } else if (form.status !== FormStatus.published) {
        fail(404, "not_found", "Form was not found");
      }
      return {
        form: {
          description: form.description ?? "",
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
        return userEditorConfig(form, identity, responseId, requestedAction);
      }
    )
    .post("/api/forms/:publicId/start", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      const form = await findFormByPublicId(params.publicId);
      const publishedTemplate = form.publishedTemplate;
      const existing = await prisma.response.findUnique({
        include: { prefillSnapshot: true, submission: true },
        where: {
          formId_userId: { formId: form.id, userId: identity.id },
        },
      });
      if (
        !publishedTemplate?.objectKey ||
        !publishedTemplate.documentKey ||
        (form.status !== FormStatus.published &&
          !(form.status === FormStatus.archived && existing))
      ) {
        fail(
          409,
          "form_unavailable",
          "This form is not accepting new responses"
        );
      }
      if (existing?.status === ResponseStatus.submitted) {
        if (!existing.submission) {
          fail(500, "internal_error", "The submitted receipt is unavailable");
        }
        return {
          receiptUrl: `/receipt/${existing.submission.id}`,
          response: responseSummary(existing, {
            submissionId: existing.submission.id,
            submittedAt: existing.submission.createdAt,
          }),
          submissionId: existing.submission.id,
        };
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
      let unusedDraftObjectKey: string | undefined;
      try {
        await putObject(draftObjectKey, document, DOCX_CONTENT_TYPE);

        const response = await prisma.$transaction(
          async (tx) => {
            const [lockedFormRow] = await tx.$queryRaw<{ id: string }[]>(
              Prisma.sql`
                SELECT "id"
                FROM "forms"
                WHERE "id" = ${form.id}::uuid
                FOR UPDATE
              `
            );
            if (!lockedFormRow) {
              fail(404, "not_found", "The form was not found");
            }
            const lockedForm = await tx.form.findUnique({
              include: { publishedTemplate: true },
              where: { id: lockedFormRow.id },
            });
            const current = await tx.response.findUnique({
              where: {
                formId_userId: { formId: form.id, userId: identity.id },
              },
            });
            if (lockedForm?.status === FormStatus.archived && !current) {
              fail(
                409,
                "form_unavailable",
                "This form is not accepting new responses"
              );
            }
            if (
              !lockedForm ||
              (lockedForm.status !== FormStatus.published &&
                !(lockedForm.status === FormStatus.archived && current)) ||
              lockedForm.version !== form.version ||
              !lockedForm.publishedTemplate ||
              lockedForm.publishedTemplate.id !== publishedTemplate.id
            ) {
              fail(409, "stale_form", "The form was published while starting");
            }
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
            if (
              current?.status === ResponseStatus.draft &&
              current.publishedVersion === form.version &&
              current.draftDocumentKey &&
              current.draftObjectKey
            ) {
              unusedDraftObjectKey = draftObjectKey;
              return current;
            }
            const responseTargetId = current?.id ?? responseId;
            if (!current) {
              await tx.response.create({
                data: {
                  draftData: Prisma.DbNull,
                  draftDocumentKey,
                  draftObjectKey,
                  form: { connect: { id: form.id } },
                  id: responseTargetId,
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
              where: { responseId: responseTargetId },
            });
            await tx.prefillSnapshot.create({
              data: {
                form: { connect: { id: form.id } },
                id: snapshotId,
                lockedFields: jsonValue({}),
                owner: { connect: { id: identity.id } },
                response: { connect: { id: responseTargetId } },
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
              where: { id: responseTargetId },
            });
            if (updated.count !== 1) {
              fail(500, "start_failed", "Unable to start response");
            }
            return tx.response.findUnique({ where: { id: responseTargetId } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        if (!response) {
          fail(500, "start_failed", "Unable to start response");
        }
        await deleteObjects([existing?.draftObjectKey, unusedDraftObjectKey]);
        return {
          editorConfigUrl: `/api/forms/${form.publicId}/editor-config?responseId=${response.id}&action=${response.draftData ? "draft" : "fill"}`,
          prefill: response.draftData ? null : { data: {}, editableFields: {} },
          response: responseSummary(response),
        };
      } catch (error) {
        await deleteObjectUnlessCanonical(draftObjectKey);
        if (databaseErrorCode(error) === "P2034") {
          const current = await prisma.response.findUnique({
            where: {
              formId_userId: { formId: form.id, userId: identity.id },
            },
          });
          if (
            current?.status === ResponseStatus.draft &&
            current.publishedVersion === form.version &&
            current.draftDocumentKey &&
            current.draftObjectKey &&
            (await objectExists(current.draftObjectKey))
          ) {
            return {
              editorConfigUrl: `/api/forms/${form.publicId}/editor-config?responseId=${current.id}&action=${current.draftData ? "draft" : "fill"}`,
              prefill: current.draftData
                ? null
                : { data: {}, editableFields: {} },
              response: responseSummary(current),
            };
          }
        }
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
            submittedAt: response.submission?.createdAt,
          })
        ),
      };
    })
    .post(
      "/api/forms/:publicId/draft",
      async ({ request, params, body, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
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
        const capabilityScope = {
          documentKey,
          formId: form.id,
          targetId: response.id,
          targetType: "response",
        } as const;
        requireEditorScope(authorization, {
          ...capabilityScope,
          action: "save-draft",
        });
        await requireActiveEditorLease(authorization, capabilityScope);
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
          authorization,
          capabilityScope,
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
          operationCapability: operationEditorCapability(
            identity,
            capabilityScope,
            operation.id
          ),
          operationId: operation.id,
          responseId: response.id,
          status: operation.status,
        };
      }
    )
    .post(
      "/api/forms/:publicId/submit",
      async ({ request, params, body, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
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
        const capabilityScope = {
          documentKey,
          formId: form.id,
          targetId: response.id,
          targetType: "response",
        } as const;
        requireEditorScope(authorization, {
          ...capabilityScope,
          action: "submit",
        });
        await requireActiveEditorLease(authorization, capabilityScope);
        const data = await normalizeResponseData(
          form,
          response,
          input.data,
          true
        );
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
        let operation: Operation;
        try {
          operation = await prisma.$transaction(
            async (tx) => {
              await lockActiveEditorLease(tx, authorization, capabilityScope);
              const activeOperation = await tx.operation.findFirst({
                where: {
                  responseId: response.id,
                  status: {
                    in: [OperationStatus.pending, OperationStatus.processing],
                  },
                  targetId: response.id,
                  targetType: OperationTargetType.response,
                },
              });
              if (activeOperation) {
                fail(
                  409,
                  "operation_in_progress",
                  "Another response operation is already in progress"
                );
              }
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
        } catch (error) {
          if (databaseErrorCode(error) === "P2034") {
            fail(
              409,
              "operation_in_progress",
              "Another response operation is already in progress"
            );
          }
          throw error;
        }
        set.status = 202;
        launchForceSave(operation, onlyOffice, allowedCallbackOrigins);
        return {
          operationCapability: operationEditorCapability(
            identity,
            capabilityScope,
            operation.id
          ),
          operationId: operation.id,
          responseId: response.id,
          status: operation.status,
          submissionId,
        };
      }
    )
    .get("/api/operations/:id", async ({ request, params }) => {
      const authorization = await editorAuthorization(request);
      const { actor: identity } = authorization;
      validateId(params.id, "Operation");
      let operation = await prisma.operation.findUnique({
        where: { id: params.id },
      });
      if (!operation) {
        fail(404, "not_found", "Operation was not found");
      }
      if (authorization.capability) {
        const targetType =
          operation.targetType === OperationTargetType.template_draft
            ? "template-draft"
            : operation.targetType === OperationTargetType.response
              ? "response"
              : null;
        if (
          !targetType ||
          !operation.documentKey ||
          operation.actorId !== identity.id
        ) {
          fail(
            403,
            "editor_capability_scope_mismatch",
            "Editor capability does not permit this operation"
          );
        }
        requireEditorScope(authorization, {
          action: "poll-operation",
          documentKey: operation.documentKey,
          formId: operation.formId,
          operationId: operation.id,
          targetId: operation.targetId,
          targetType,
        });
      } else if (identity.role !== "admin") {
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
      operation = await expireOperationIfNeeded(operation);
      await cleanupTerminalOperationObjects(operation);
      return {
        operation: {
          createdAt: operation.createdAt,
          error: operation.errorCode,
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
          formPublicId: submission.form.publicId,
          formTitle: submission.form.title,
          userEmail:
            identity.role === "admin" ? submission.owner.email : undefined,
        }),
      };
    })
    .get("/api/submissions/:id/json", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const submission = await prisma.submission.findUnique({
        where: { id: params.id },
      });
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      canReadSubmission(identity, submission);
      return new Response(JSON.stringify(jsonRecord(submission.data)), {
        headers: {
          "Content-Disposition": `attachment; filename="submission-${submission.id}.json"`,
          "Content-Type": "application/json; charset=utf-8",
        },
      });
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
    .get("/onlyoffice/document/:key", async ({ request, params, query }) => {
      const { key } = params;
      const token = typeof query.token === "string" ? query.token : "";
      if (
        !verifyDocumentAccessToken(token, key) ||
        !verifyOnlyOfficeAuthorization(request.headers.get("authorization"), {
          url: request.url,
        })
      ) {
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
      if (origin && !pluginOrigins.has(origin)) {
        fail(403, "forbidden_origin", "Origin is not allowed");
      }
      if (origin) {
        set.headers["Access-Control-Allow-Origin"] = origin;
        set.headers.Vary = "Origin";
      }
      return {
        guid: pluginGuid,
        name: "ตั้งค่าฟิลด์",
        variations: [
          {
            EditorsSupport: ["word"],
            buttons: [],
            description: "แผงตั้งค่าฟิลด์สำหรับแบบฟอร์ม",
            events: [
              "onToolbarMenuClick",
              "onDocumentContentReady",
              "onTargetPositionChanged",
            ],
            initData: "",
            initDataType: "none",
            initOnSelectionChanged: true,
            isActivated: true,
            isInsideMode: false,
            isModal: false,
            isViewer: false,
            isVisual: true,
            type: "panelRight",
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
    .post(
      "/onlyoffice/callback",
      async ({ request }) => {
        const payload = await readJsonRecord(request, maxCallbackBodyBytes);
        if (
          !verifyOnlyOfficeAuthorization(
            request.headers.get("authorization"),
            payload
          )
        ) {
          fail(401, "invalid_onlyoffice_token", "OnlyOffice token is invalid");
        }
        const status =
          typeof payload.status === "number"
            ? payload.status
            : Number(payload.status);
        if (status !== 6 && status !== 7) {
          return { error: 0 };
        }
        if (typeof payload.userdata !== "string") {
          return { error: 1 };
        }
        const claim = callbackClaim(payload.userdata);
        if (!claim) {
          return { error: 1 };
        }
        const operation = await prisma.operation.findUnique({
          where: { id: claim.operationId },
        });
        if (
          !operation ||
          claim.documentKey !== operation.documentKey ||
          claim.operationType !== operation.type ||
          typeof payload.key !== "string" ||
          payload.key !== operation.documentKey
        ) {
          return { error: 1 };
        }
        const consumption = await consumeCallbackClaim(
          operation.id,
          payload.userdata
        );
        if (consumption === "invalid") {
          return { error: 1 };
        }
        if (
          consumption === "replayed" ||
          operation.status === OperationStatus.completed ||
          operation.status === OperationStatus.failed
        ) {
          if (
            operation.status === OperationStatus.completed ||
            operation.status === OperationStatus.failed
          ) {
            await cleanupTerminalOperationObjects(operation);
          }
          return { error: 0 };
        }
        if (status === 7) {
          await updateOperationFailed(
            operation.id,
            "onlyoffice_document_error"
          );
          return { error: 0 };
        }
        try {
          await finalizeCallback(
            operation.id,
            payload as unknown as CallbackPayload,
            undefined,
            allowedCallbackOrigins,
            callbackMaximumBytes
          );
          return { error: 0 };
        } catch (error) {
          await updateOperationFailed(
            operation.id,
            error instanceof HttpError && error.code === "invalid_template"
              ? "invalid_template"
              : "callback_processing_failed"
          );
          return { error: 1 };
        }
      },
      { parse: "none" }
    );
}

async function readTemplateSourceBytes(
  absolutePath: string
): Promise<Uint8Array> {
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    fail(404, "not_found", "Template source was not found");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxTemplateUploadBytes) {
    fail(413, "payload_too_large", "Template source is too large");
  }
  validateTemplatePackage(bytes);
  return bytes;
}
