// oxlint-disable func-style prefer-destructuring no-await-in-loop no-use-before-define no-nested-ternary complexity no-shadow -- Route modules keep declaration order and sequential persistence invariants.
import path from "node:path";

import { cors } from "@elysiajs/cors";
import { auth } from "@onlyoffice/auth";
import {
  db,
  forms,
  operations,
  prefillProfiles,
  prefillSnapshots,
  responses,
  submissions,
  user,
} from "@onlyoffice/db";
import type { OperationType } from "@onlyoffice/db";
import { env } from "@onlyoffice/env/server";
import { and, count, desc, eq, or } from "drizzle-orm";
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
  artifactExists,
  artifactPath,
  readArtifact,
  readArtifactJson,
  removeArtifactDirectory,
  resolveArtifactPath,
  writeArtifact,
} from "./storage";

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const pluginDir = path.resolve(projectRoot, "apps/onlyoffice-plugin");
const templateDir = path.resolve(projectRoot, "onlyoffice-templates");
const templateFileName = "template.docx";
const idPattern = /^[0-9a-f-]{36}$/iu;
const operationTimeoutMs = 5 * 60_000;
const maxCallbackDocumentBytes = 25 * 1024 * 1024;
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
  id: string;
  name: string;
  email: string;
  role: UserRole;
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
  formId: string;
  responseId?: string;
  submissionId?: string;
  publicId?: string;
  publishedVersion?: number;
  publishedKey?: string;
  stagedDocxPath: string;
  finalDocxPath?: string;
  finalDataPath?: string;
  finalPdfPath?: string;
  data?: JsonRecord;
  result?: JsonRecord;
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
  const { action } = metadata;
  const { formId } = metadata;
  const { stagedDocxPath } = metadata;
  if (
    (action !== "save-template" &&
      action !== "publish" &&
      action !== "save-draft" &&
      action !== "submit") ||
    typeof formId !== "string" ||
    typeof stagedDocxPath !== "string"
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

async function identityFor(request: Request): Promise<Identity | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return null;
    }
    const sessionUser = session.user as unknown as {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      role?: unknown;
    };
    if (
      typeof sessionUser.id !== "string" ||
      typeof sessionUser.email !== "string"
    ) {
      return null;
    }
    const role: UserRole = sessionUser.role === "admin" ? "admin" : "user";
    return {
      email: sessionUser.email,
      id: sessionUser.id,
      name:
        typeof sessionUser.name === "string" && sessionUser.name.length > 0
          ? sessionUser.name
          : sessionUser.email,
      role,
    };
  } catch {
    return null;
  }
}
function bearerTokenFor(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer\s+(?<token>.+)$/iu.exec(authorization);
  return match?.groups?.token;
}

async function requireIdentity(request: Request): Promise<Identity> {
  const identity = await identityFor(request);
  if (!identity) {
    fail(401, "unauthorized", "Authentication is required");
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

function formSummary(form: typeof forms.$inferSelect): JsonRecord {
  return {
    createdAt: form.createdAt,
    createdBy: form.createdBy,
    description: form.description,
    hasPublishedDocument: Boolean(form.publishedPath),
    hasTemplateDraft: Boolean(form.templateDraftPath),
    id: form.id,
    publicId: form.publicId,
    publishedDocumentKey: form.publishedKey,
    status: form.status,
    templateDocumentKey: form.templateDraftKey,
    title: form.title,
    updatedAt: form.updatedAt,
    version: form.version,
  };
}

function responseSummary(
  response: typeof responses.$inferSelect,
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
    hasDraft: Boolean(response.draftDocxPath && response.draftData),
    id: response.id,
    publishedVersion: response.publishedVersion,
    status: response.status,
    submissionId: extra.submissionId,
    updatedAt: response.updatedAt,
    userId: response.userId,
  };
}

function submissionSummary(
  submission: typeof submissions.$inferSelect,
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
  const candidates = [
    env.TEMPLATE_PATH,
    path.resolve(templateDir, templateFileName),
    path.resolve(process.cwd(), "onlyoffice-templates", templateFileName),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }
  return null;
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
  form: typeof forms.$inferSelect,
  response: typeof responses.$inferSelect,
  inputData: unknown
): Promise<JsonRecord> {
  const data = { ...jsonRecord(inputData) };
  const serialized = JSON.stringify(data);
  if (serialized.length > maxResponseDataBytes) {
    fail(413, "response_too_large", "Response data exceeds the size limit");
  }
  if (!form.publishedPath) {
    fail(409, "not_published", "This form has not been published");
  }
  const templateBytes = await readArtifact(form.publishedPath);
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
  if (!response.prefillSnapshotId) {
    return data;
  }
  const snapshotRows = await db
    .select()
    .from(prefillSnapshots)
    .where(eq(prefillSnapshots.id, response.prefillSnapshotId))
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot) {
    fail(
      409,
      "prefill_snapshot_missing",
      "The response prefill is unavailable"
    );
  }
  const snapshotData = jsonRecord(snapshot.data);
  const editableFields = jsonRecord(snapshot.editableFields);
  for (const [field, value] of Object.entries(snapshotData)) {
    if (editableFields[field] === false) {
      data[field] = value;
    }
  }
  return data;
}

async function activeOperationForForm(
  formId: string,
  action: OperationType
): Promise<boolean> {
  const rows = await db
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.formId, formId),
        eq(operations.type, action),
        or(
          eq(operations.status, "pending"),
          eq(operations.status, "processing")
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function activeOperationForResponse(
  responseId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.responseId, responseId),
        or(
          eq(operations.status, "pending"),
          eq(operations.status, "processing")
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function createOperation(input: {
  type: OperationType;
  formId: string;
  responseId?: string;
  submissionId?: string;
  documentKey: string;
  metadata: OperationMetadata;
}): Promise<typeof operations.$inferSelect> {
  const rows = await db
    .insert(operations)
    .values({
      documentKey: input.documentKey,
      formId: input.formId,
      metadata: input.metadata,
      responseId: input.responseId,
      status: "pending",
      submissionId: input.submissionId,
      type: input.type,
    })
    .returning();
  const operation = rows[0];
  if (!operation) {
    fail(500, "operation_failed", "Unable to create operation");
  }
  return operation;
}

async function updateOperationFailed(
  operationId: string,
  message: string
): Promise<void> {
  await db
    .update(operations)
    .set({ error: message, status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(operations.id, operationId),
        or(
          eq(operations.status, "pending"),
          eq(operations.status, "processing")
        )
      )
    );
}
async function expireOperationIfNeeded(
  operation: typeof operations.$inferSelect
): Promise<typeof operations.$inferSelect> {
  const active =
    operation.status === "pending" || operation.status === "processing";
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
  return { ...operation, error: message, status: "failed" };
}

async function rollbackSubmit(responseId: string): Promise<void> {
  await db
    .update(responses)
    .set({ status: "draft", updatedAt: new Date() })
    .where(
      and(eq(responses.id, responseId), eq(responses.status, "submitting"))
    );
}

function launchForceSave(
  operation: typeof operations.$inferSelect,
  onlyOffice: OnlyOfficeClient,
  allowedCallbackOrigins: ReadonlySet<string>
): void {
  void (async () => {
    try {
      if (!operation.documentKey) {
        fail(500, "invalid_operation", "Operation has no document key");
      }
      await db
        .update(operations)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(eq(operations.id, operation.id), eq(operations.status, "pending"))
        );
      const hasChanges = await onlyOffice.forceSave(
        operation.documentKey,
        createCallbackUserdata(operation.id)
      );
      if (!hasChanges) {
        const currentPath = await operationDocumentPath(operation.documentKey);
        if (!currentPath) {
          fail(
            500,
            "document_unavailable",
            "The current document snapshot is unavailable"
          );
        }
        await finalizeCallback(
          operation.id,
          { key: operation.documentKey, status: 6 },
          await readArtifact(currentPath),
          onlyOffice,
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

async function operationDocumentPath(
  documentKey: string
): Promise<string | null> {
  const pending = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.documentKey, documentKey),
        or(
          eq(operations.status, "pending"),
          eq(operations.status, "processing")
        )
      )
    )
    .orderBy(desc(operations.updatedAt))
    .limit(10);
  for (const operation of pending) {
    const metadata = operationMetadata(operation.metadata);
    if (await artifactExists(metadata.stagedDocxPath)) {
      return metadata.stagedDocxPath;
    }
  }

  const formRows = await db
    .select()
    .from(forms)
    .where(
      or(
        eq(forms.templateDraftKey, documentKey),
        eq(forms.publishedKey, documentKey)
      )
    )
    .limit(1);
  const form = formRows[0];
  if (form) {
    if (form.templateDraftKey === documentKey && form.templateDraftPath) {
      return form.templateDraftPath;
    }
    if (form.publishedKey === documentKey && form.publishedPath) {
      return form.publishedPath;
    }
  }

  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.draftDocumentKey, documentKey))
    .limit(1);
  return responseRows[0]?.draftDocxPath ?? null;
}

async function completeTemplateOperation(
  operation: typeof operations.$inferSelect,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<JsonRecord> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Template operation has no document key");
  }
  const formRows = await db
    .select()
    .from(forms)
    .where(eq(forms.id, metadata.formId))
    .limit(1);
  const form = formRows[0];
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  if (form.templateDraftKey !== documentKey) {
    fail(
      409,
      "stale_operation",
      "The template changed while this operation was running"
    );
  }
  const finalPath =
    metadata.finalDocxPath ??
    artifactPath("forms", form.id, "template-draft.docx");
  await writeArtifact(finalPath, bytes);
  await db
    .update(forms)
    .set({
      templateDraftKey: documentKey,
      templateDraftPath: finalPath,
      updatedAt: new Date(),
    })
    .where(eq(forms.id, form.id));
  return { documentKey, formId: form.id };
}
async function completePublishOperation(
  operation: typeof operations.$inferSelect,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<JsonRecord> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Publish operation has no document key");
  }
  const formRows = await db
    .select()
    .from(forms)
    .where(eq(forms.id, metadata.formId))
    .limit(1);
  const form = formRows[0];
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  if (form.templateDraftKey !== documentKey) {
    fail(409, "stale_operation", "The template changed while publishing");
  }
  const { publishedVersion } = metadata;
  const { publishedKey } = metadata;
  if (
    typeof publishedVersion !== "number" ||
    typeof publishedKey !== "string"
  ) {
    fail(500, "invalid_operation", "Publish metadata is incomplete");
  }
  validateTemplateControls(bytes);
  const publishedPath =
    metadata.finalDocxPath ??
    artifactPath("forms", form.id, `published-${publishedVersion}.docx`);
  await writeArtifact(publishedPath, bytes);
  await db.transaction(async (tx) => {
    await tx
      .update(forms)
      .set({
        publishedKey,
        publishedPath,
        status: "published",
        updatedAt: new Date(),
        version: publishedVersion,
      })
      .where(eq(forms.id, form.id));
    await tx
      .update(responses)
      .set({
        draftData: null,
        draftDocumentKey: null,
        draftDocxPath: null,
        prefillSnapshotId: null,
        status: "invalidated",
        updatedAt: new Date(),
      })
      .where(and(eq(responses.formId, form.id), eq(responses.status, "draft")));
  });
  return {
    documentKey: publishedKey,
    formId: form.id,
    publicId: form.publicId,
    version: publishedVersion,
  };
}
async function completeDraftOperation(
  operation: typeof operations.$inferSelect,
  metadata: OperationMetadata,
  bytes: Uint8Array
): Promise<JsonRecord> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Draft operation has no document key");
  }
  if (!metadata.responseId || !metadata.data) {
    fail(500, "invalid_operation", "Draft metadata is incomplete");
  }
  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.id, metadata.responseId))
    .limit(1);
  const response = responseRows[0];
  if (
    !response ||
    response.status !== "draft" ||
    response.draftDocumentKey !== documentKey
  ) {
    fail(409, "stale_operation", "The response is no longer editable");
  }
  const finalPath =
    metadata.finalDocxPath ??
    artifactPath("responses", response.id, "draft.docx");
  await writeArtifact(finalPath, bytes);
  await db
    .update(responses)
    .set({
      draftData: metadata.data,
      draftDocxPath: finalPath,
      updatedAt: new Date(),
    })
    .where(and(eq(responses.id, response.id), eq(responses.status, "draft")));
  return { formId: response.formId, responseId: response.id };
}
async function completeSubmitOperation(
  operation: typeof operations.$inferSelect,
  metadata: OperationMetadata,
  bytes: Uint8Array,
  onlyOffice: OnlyOfficeClient
): Promise<JsonRecord> {
  const { documentKey } = operation;
  if (!documentKey) {
    fail(500, "invalid_operation", "Submit operation has no document key");
  }
  if (
    !metadata.responseId ||
    !metadata.submissionId ||
    !metadata.data ||
    !metadata.finalDataPath ||
    !metadata.finalPdfPath ||
    !metadata.finalDocxPath
  ) {
    fail(500, "invalid_operation", "Submit metadata is incomplete");
  }
  const { responseId } = metadata;
  const { submissionId } = metadata;
  const { data } = metadata;
  const { finalDataPath } = metadata;
  const { finalPdfPath } = metadata;
  const { finalDocxPath } = metadata;
  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .limit(1);
  const response = responseRows[0];
  if (
    !response ||
    response.status !== "submitting" ||
    response.draftDocumentKey !== documentKey
  ) {
    fail(
      409,
      "stale_operation",
      "The response is no longer pending submission"
    );
  }

  // The converter reads this active operation's staged artifact through the signed document route.
  const pdf = await onlyOffice.convertDocxToPdf(documentKey);
  await writeArtifact(finalDocxPath, bytes);
  await writeArtifact(finalPdfPath, pdf);
  await writeArtifact(finalDataPath, JSON.stringify(data, null, 2));
  if (
    !(await artifactExists(finalDocxPath)) ||
    !(await artifactExists(finalPdfPath)) ||
    !(await artifactExists(finalDataPath))
  ) {
    fail(500, "artifact_failed", "Submission artifacts were not persisted");
  }

  const result = {
    formId: response.formId,
    responseId: response.id,
    submissionId,
  };
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(operations)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(operations.id, operation.id),
          eq(operations.status, "processing")
        )
      )
      .returning({ id: operations.id });
    if (!claimed[0]) {
      fail(
        409,
        "stale_operation",
        "The submission operation is no longer active"
      );
    }
    await tx.insert(submissions).values({
      data,
      dataPath: finalDataPath,
      docxPath: finalDocxPath,
      formId: response.formId,
      id: submissionId,
      pdfPath: finalPdfPath,
      responseId: response.id,
      userId: response.userId,
    });
    const updatedResponses = await tx
      .update(responses)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(
        and(eq(responses.id, response.id), eq(responses.status, "submitting"))
      )
      .returning({ id: responses.id });
    if (!updatedResponses[0]) {
      fail(
        409,
        "stale_operation",
        "The response is no longer pending submission"
      );
    }
    const completed = await tx
      .update(operations)
      .set({
        error: null,
        metadata: { ...metadata, result },
        status: "completed",
        submissionId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(operations.id, operation.id),
          eq(operations.status, "processing")
        )
      )
      .returning({ id: operations.id });
    if (!completed[0]) {
      fail(
        409,
        "stale_operation",
        "The submission operation is no longer active"
      );
    }
  });
  return result;
}
async function finalizeCallback(
  operationId: string,
  payload: CallbackPayload,
  snapshot: Uint8Array | undefined,
  onlyOffice: OnlyOfficeClient,
  allowedCallbackOrigins: ReadonlySet<string>
): Promise<void> {
  const rows = await db
    .select()
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1);
  const operation = rows[0];
  if (
    !operation ||
    operation.status === "completed" ||
    operation.status === "failed"
  ) {
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
  const claimed = await db
    .update(operations)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(
        eq(operations.id, operation.id),
        or(
          eq(operations.status, "pending"),
          eq(operations.status, "processing")
        )
      )
    )
    .returning({ id: operations.id });
  if (!claimed[0]) {
    return;
  }
  await writeArtifact(metadata.stagedDocxPath, bytes);

  let result: JsonRecord;
  if (metadata.action === "save-template") {
    result = await completeTemplateOperation(operation, metadata, bytes);
  } else if (metadata.action === "publish") {
    result = await completePublishOperation(operation, metadata, bytes);
  } else if (metadata.action === "save-draft") {
    result = await completeDraftOperation(operation, metadata, bytes);
  } else {
    result = await completeSubmitOperation(
      operation,
      metadata,
      bytes,
      onlyOffice
    );
  }
  await db
    .update(operations)
    .set({
      error: null,
      metadata: { ...metadata, result },
      status: "completed",
      updatedAt: new Date(),
    })
    .where(
      and(eq(operations.id, operation.id), eq(operations.status, "processing"))
    );
}

async function findFormById(id: string): Promise<typeof forms.$inferSelect> {
  validateId(id, "Form");
  const rows = await db.select().from(forms).where(eq(forms.id, id)).limit(1);
  const form = rows[0];
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  return form;
}

async function findFormByPublicId(
  publicId: string
): Promise<typeof forms.$inferSelect> {
  if (!publicId || publicId.length > 128) {
    fail(404, "not_found", "Form was not found");
  }
  const rows = await db
    .select()
    .from(forms)
    .where(eq(forms.publicId, publicId))
    .limit(1);
  const form = rows[0];
  if (!form) {
    fail(404, "not_found", "Form was not found");
  }
  return form;
}

async function findOwnedResponse(
  responseId: string,
  formId: string,
  userId: string
): Promise<typeof responses.$inferSelect> {
  validateId(responseId, "Response");
  const rows = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.id, responseId),
        eq(responses.formId, formId),
        eq(responses.userId, userId)
      )
    )
    .limit(1);
  const response = rows[0];
  if (!response) {
    fail(404, "not_found", "Response was not found");
  }
  return response;
}

function canReadSubmission(
  identity: Identity,
  submission: typeof submissions.$inferSelect
): void {
  if (identity.role === "admin") {
    return;
  }
  if (submission.userId !== identity.id) {
    fail(403, "forbidden", "You may only access your own submission");
  }
}

async function userEditorConfig(
  form: typeof forms.$inferSelect,
  identity: Identity,
  responseId: string | undefined,
  requestedAction?: string,
  authToken?: string
): Promise<Record<string, unknown>> {
  if (!form.publishedPath || !form.publishedKey) {
    fail(409, "not_published", "This form has no published document");
  }
  const responseRows = responseId
    ? await db
        .select()
        .from(responses)
        .where(
          and(
            eq(responses.id, responseId),
            eq(responses.formId, form.id),
            eq(responses.userId, identity.id)
          )
        )
        .limit(1)
    : await db
        .select()
        .from(responses)
        .where(
          and(eq(responses.formId, form.id), eq(responses.userId, identity.id))
        )
        .limit(1);
  const response = responseRows[0];
  if (!response) {
    fail(404, "not_found", "Start a response before opening the editor");
  }
  if (response.status === "submitted") {
    fail(409, "already_submitted", "This response has already been submitted");
  }
  if (!response.draftDocumentKey || !response.draftDocxPath) {
    fail(409, "document_unavailable", "Response document is unavailable");
  }
  if (!(await artifactExists(response.draftDocxPath))) {
    fail(
      409,
      "document_unavailable",
      "Response document artifact is unavailable"
    );
  }
  let snapshot: typeof prefillSnapshots.$inferSelect | undefined;
  if (response.prefillSnapshotId) {
    const snapshotRows = await db
      .select()
      .from(prefillSnapshots)
      .where(eq(prefillSnapshots.id, response.prefillSnapshotId))
      .limit(1);
    snapshot = snapshotRows[0];
  }
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
        requestedAction === "fill"
          ? snapshot
            ? {
                data: jsonRecord(snapshot.data),
                editableFields: jsonRecord(snapshot.editableFields),
              }
            : undefined
          : undefined,
      publicId: form.publicId,
      responseId: response.id,
    },
    identity
  );
}
async function removeArtifactDirectoryWithRetry(
  relativePath: string
): Promise<void> {
  try {
    await removeArtifactDirectory(relativePath);
  } catch {
    try {
      await removeArtifactDirectory(relativePath);
    } catch (error) {
      console.error(
        `Could not remove artifact directory ${relativePath}`,
        error
      );
    }
  }
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
      if (databaseErrorCode(error) === "23505") {
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
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .get("/health", () => ({ ok: true }))
    .get("/api/admin/forms", async ({ request }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const items = await db
        .select({ form: forms, submissionCount: count(submissions.id) })
        .from(forms)
        .leftJoin(submissions, eq(submissions.formId, forms.id))
        .groupBy(forms.id)
        .orderBy(desc(forms.updatedAt));
      const payload = {
        forms: items.map(({ form, submissionCount }) => ({
          ...formSummary(form),
          submissionCount: Number(submissionCount),
        })),
      };
      return payload;
    })
    .delete("/api/admin/forms/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const formId = validateId(params.id, "Form");
      const { operationIds } = await db.transaction(async (tx) => {
        const formRows = await tx
          .select()
          .from(forms)
          .where(eq(forms.id, formId))
          .for("update")
          .limit(1);
        const form = formRows[0];
        if (!form) {
          fail(404, "not_found", "Form was not found");
        }
        if (
          form.status !== "draft" ||
          form.publishedPath ||
          form.publishedKey ||
          form.version > 0
        ) {
          fail(
            409,
            "form_not_draft",
            "Only unpublished draft forms can be removed"
          );
        }

        const activeOperations = await tx
          .select({ id: operations.id, updatedAt: operations.updatedAt })
          .from(operations)
          .where(
            and(
              eq(operations.formId, form.id),
              or(
                eq(operations.status, "pending"),
                eq(operations.status, "processing")
              )
            )
          );
        const staleOperationIds = new Set<string>();
        const now = Date.now();
        for (const operation of activeOperations) {
          if (now - operation.updatedAt.getTime() >= operationTimeoutMs) {
            staleOperationIds.add(operation.id);
            await tx
              .update(operations)
              .set({
                error: "The document operation timed out. Try again.",
                status: "failed",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(operations.id, operation.id),
                  or(
                    eq(operations.status, "pending"),
                    eq(operations.status, "processing")
                  )
                )
              );
          }
        }
        if (activeOperations.some(({ id }) => !staleOperationIds.has(id))) {
          fail(
            409,
            "operation_in_progress",
            "Wait for the draft operation to finish before removing this form"
          );
        }

        const responsesForForm = await tx
          .select({ id: responses.id })
          .from(responses)
          .where(eq(responses.formId, form.id))
          .limit(1);
        if (responsesForForm[0]) {
          fail(
            409,
            "form_has_responses",
            "A form with responses cannot be removed"
          );
        }
        const snapshotsForForm = await tx
          .select({ id: prefillSnapshots.id })
          .from(prefillSnapshots)
          .where(eq(prefillSnapshots.formId, form.id))
          .limit(1);
        const submissionsForForm = await tx
          .select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.formId, form.id))
          .limit(1);
        if (snapshotsForForm[0] || submissionsForForm[0]) {
          fail(
            409,
            "form_has_responses",
            "A form with responses cannot be removed"
          );
        }

        const formOperations = await tx
          .select({ id: operations.id })
          .from(operations)
          .where(eq(operations.formId, form.id));
        await tx.delete(operations).where(eq(operations.formId, form.id));
        const deletedForms = await tx
          .delete(forms)
          .where(and(eq(forms.id, form.id), eq(forms.status, "draft")))
          .returning({ id: forms.id });
        if (!deletedForms[0]) {
          fail(409, "form_not_draft", "Only draft forms can be removed");
        }
        return { operationIds: formOperations.map(({ id }) => id) };
      });

      await Promise.all([
        removeArtifactDirectoryWithRetry(artifactPath("forms", formId)),
        ...operationIds.map((operationId) =>
          removeArtifactDirectoryWithRetry(
            artifactPath("operations", operationId)
          )
        ),
      ]);
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
      const templateDraftPath = sourcePath
        ? artifactPath("forms", id, "template-draft.docx")
        : null;
      const templateDraftKey = sourcePath
        ? `form-${id}-draft-${crypto.randomUUID()}`
        : null;
      if (sourcePath && templateDraftPath) {
        await writeArtifact(
          templateDraftPath,
          await readArtifactFromAbsolute(sourcePath)
        );
      }
      const rows = await db
        .insert(forms)
        .values({
          createdBy: identity.id,
          description,
          id,
          publicId,
          templateDraftKey,
          templateDraftPath,
          title,
          version: 0,
        })
        .returning();
      const form = rows[0];
      if (!form) {
        fail(500, "create_failed", "Unable to create form");
      }
      return {
        form: formSummary(form),
        templateAvailable: Boolean(sourcePath),
      };
    })
    .get("/api/admin/forms/:id", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormById(params.id);
      const draftRows = await db
        .select({ count: count() })
        .from(responses)
        .where(
          and(eq(responses.formId, form.id), eq(responses.status, "draft"))
        );
      const activeDraftCount = Number(draftRows[0]?.count ?? 0);
      return {
        editorConfigUrl: `/api/admin/forms/${form.id}/editor-config`,
        form: { ...formSummary(form), activeDraftCount },
      };
    })
    .get("/api/admin/forms/:id/editor-config", async ({ request, params }) => {
      const identity = await requireIdentity(request);
      requireAdmin(identity);
      const form = await findFormById(params.id);
      if (!form.templateDraftPath || !form.templateDraftKey) {
        fail(
          409,
          "document_unavailable",
          "No template DOCX is configured; provide TEMPLATE_PATH or restore the demo template"
        );
      }
      if (!(await artifactExists(form.templateDraftPath))) {
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
          documentKey: form.templateDraftKey,
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
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
        if (!form.templateDraftKey || form.templateDraftKey !== documentKey) {
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
        const nextKey = `form-${form.id}-draft-${crypto.randomUUID()}`;
        const operation = await createOperation({
          documentKey,
          formId: form.id,
          metadata: {
            action: "save-template",
            finalDocxPath: artifactPath(
              "forms",
              form.id,
              `template-draft-${operationId}.docx`
            ),
            formId: form.id,
            result: { documentKey: nextKey },
            stagedDocxPath: artifactPath(
              "operations",
              operationId,
              "template.docx"
            ),
          },
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
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
        if (!form.templateDraftKey || form.templateDraftKey !== documentKey) {
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
        const operation = await createOperation({
          documentKey,
          formId: form.id,
          metadata: {
            action: "publish",
            finalDocxPath: artifactPath(
              "forms",
              form.id,
              `published-${version}.docx`
            ),
            formId: form.id,
            publishedKey,
            publishedVersion: version,
            stagedDocxPath: artifactPath(
              "operations",
              operationId,
              "published.docx"
            ),
          },
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
      const rows = await db
        .select({
          formTitle: forms.title,
          submission: submissions,
          userEmail: user.email,
        })
        .from(submissions)
        .innerJoin(forms, eq(submissions.formId, forms.id))
        .innerJoin(user, eq(submissions.userId, user.id))
        .where(eq(submissions.formId, form.id))
        .orderBy(desc(submissions.createdAt));
      return {
        submissions: rows.map(({ submission, formTitle, userEmail }) =>
          submissionSummary(submission, { formTitle, userEmail })
        ),
      };
    })
    .get("/api/forms/:publicId", async ({ params }) => {
      const form = await findFormByPublicId(params.publicId);
      return {
        form: {
          description: form.description,
          id: form.id,
          publicId: form.publicId,
          published: Boolean(form.publishedPath && form.publishedKey),
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
      if (!form.publishedPath || !form.publishedKey) {
        fail(409, "not_published", "This form has not been published");
      }

      const existingRows = await db
        .select()
        .from(responses)
        .where(
          and(eq(responses.formId, form.id), eq(responses.userId, identity.id))
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing?.status === "submitted") {
        fail(409, "already_submitted", "You have already submitted this form");
      }
      if (existing && existing.status === "submitting") {
        fail(
          409,
          "operation_in_progress",
          "Your submission is being processed"
        );
      }
      if (
        existing &&
        existing.status === "draft" &&
        existing.publishedVersion === form.version &&
        existing.draftDocxPath &&
        existing.draftDocumentKey
      ) {
        if (!(await artifactExists(existing.draftDocxPath))) {
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

      const profileRows = await db
        .select()
        .from(prefillProfiles)
        .where(eq(prefillProfiles.userId, identity.id))
        .limit(1);
      const profile = profileRows[0];
      const prefillData = profile ? jsonRecord(profile.data) : {};
      const editableFields = profile ? jsonRecord(profile.editableFields) : {};
      const responseId = existing?.id ?? crypto.randomUUID();
      const draftPath = artifactPath(
        "responses",
        responseId,
        `draft-v${form.version}.docx`
      );
      const draftKey = `response-${responseId}-${crypto.randomUUID()}`;
      const snapshotId = crypto.randomUUID();
      if (!(await artifactExists(form.publishedPath))) {
        fail(
          409,
          "document_unavailable",
          "The published document artifact is unavailable"
        );
      }
      const document = await readArtifact(form.publishedPath);
      await writeArtifact(draftPath, document);

      const response = await db.transaction(async (tx) => {
        const lockedForm = await tx
          .select({ id: forms.id })
          .from(forms)
          .where(
            and(
              eq(forms.id, form.id),
              eq(forms.status, "published"),
              eq(forms.version, form.version)
            )
          )
          .for("update")
          .limit(1);
        if (!lockedForm[0]) {
          fail(409, "stale_form", "The form was published while starting");
        }
        if (!existing) {
          const inserted = await tx
            .insert(responses)
            .values({
              draftData: null,
              draftDocumentKey: draftKey,
              draftDocxPath: draftPath,
              formId: form.id,
              id: responseId,
              prefillSnapshotId: null,
              publishedVersion: form.version,
              status: "draft",
              userId: identity.id,
            })
            .returning();
          if (!inserted[0]) {
            fail(500, "start_failed", "Unable to start response");
          }
        }
        const snapshotRows = await tx
          .insert(prefillSnapshots)
          .values({
            data: prefillData,
            editableFields,
            formId: form.id,
            id: snapshotId,
            profileId: profile?.id,
            responseId,
            userId: identity.id,
          })
          .returning();
        if (!snapshotRows[0]) {
          fail(500, "start_failed", "Unable to save prefill snapshot");
        }
        const updated = await tx
          .update(responses)
          .set({
            draftData: null,
            draftDocumentKey: draftKey,
            draftDocxPath: draftPath,
            prefillSnapshotId: snapshotId,
            publishedVersion: form.version,
            status: "draft",
            updatedAt: new Date(),
          })
          .where(eq(responses.id, responseId))
          .returning();
        return updated[0];
      });
      if (!response) {
        fail(500, "start_failed", "Unable to start response");
      }
      return {
        editorConfigUrl: `/api/forms/${form.publicId}/editor-config?responseId=${response.id}&action=fill`,
        prefill: { data: prefillData, editableFields },
        response: responseSummary(response),
      };
    })
    .get("/api/responses/me", async ({ request }) => {
      const identity = await requireIdentity(request);
      const rows = await db
        .select({
          formPublicId: forms.publicId,
          formTitle: forms.title,
          response: responses,
          submissionId: submissions.id,
        })
        .from(responses)
        .innerJoin(forms, eq(responses.formId, forms.id))
        .leftJoin(submissions, eq(submissions.responseId, responses.id))
        .where(eq(responses.userId, identity.id))
        .orderBy(desc(responses.updatedAt));
      return {
        responses: rows.map(
          ({ response, formPublicId, formTitle, submissionId }) =>
            responseSummary(response, { formPublicId, formTitle, submissionId })
        ),
      };
    })
    .post(
      "/api/forms/:publicId/draft",
      async ({ request, params, body, set }) => {
        const identity = await requireIdentity(request);
        const form = await findFormByPublicId(params.publicId);
        const input = asRecord(body);
        const inputData = input.data;
        const responseId = requiredString(input, "responseId");
        const documentKey = requiredString(input, "documentKey");
        const response = await findOwnedResponse(
          responseId,
          form.id,
          identity.id
        );
        if (
          response.status !== "draft" ||
          response.draftDocumentKey !== documentKey ||
          response.publishedVersion !== form.version
        ) {
          fail(409, "stale_response", "The response is no longer editable");
        }
        const data = await normalizeResponseData(form, response, inputData);
        if (await activeOperationForResponse(response.id)) {
          fail(
            409,
            "operation_in_progress",
            "Another response operation is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const operation = await createOperation({
          documentKey,
          formId: form.id,
          metadata: {
            action: "save-draft",
            data,
            finalDocxPath: artifactPath(
              "responses",
              response.id,
              `draft-${operationId}.docx`
            ),
            formId: form.id,
            publicId: form.publicId,
            responseId: response.id,
            stagedDocxPath: artifactPath(
              "operations",
              operationId,
              "draft.docx"
            ),
          },
          responseId: response.id,
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
        const inputData = input.data;
        const responseId = requiredString(input, "responseId");
        const documentKey = requiredString(input, "documentKey");
        const response = await findOwnedResponse(
          responseId,
          form.id,
          identity.id
        );
        if (
          response.status !== "draft" ||
          response.draftDocumentKey !== documentKey ||
          response.publishedVersion !== form.version
        ) {
          fail(409, "stale_response", "The response is no longer editable");
        }
        const data = await normalizeResponseData(form, response, inputData);
        if (await activeOperationForResponse(response.id)) {
          fail(
            409,
            "operation_in_progress",
            "Another response operation is already in progress"
          );
        }
        const operationId = crypto.randomUUID();
        const submissionId = crypto.randomUUID();
        const metadata: OperationMetadata = {
          action: "submit",
          data,
          finalDataPath: artifactPath("submissions", submissionId, "data.json"),
          finalDocxPath: artifactPath(
            "submissions",
            submissionId,
            "filled.docx"
          ),
          finalPdfPath: artifactPath("submissions", submissionId, "filled.pdf"),
          formId: form.id,
          publicId: form.publicId,
          responseId: response.id,
          stagedDocxPath: artifactPath(
            "operations",
            operationId,
            "submission.docx"
          ),
          submissionId,
        };
        const operation = await db.transaction(async (tx) => {
          const claimed = await tx
            .update(responses)
            .set({ status: "submitting", updatedAt: new Date() })
            .where(
              and(eq(responses.id, response.id), eq(responses.status, "draft"))
            )
            .returning();
          if (!claimed[0]) {
            fail(
              409,
              "operation_in_progress",
              "Another response operation is already in progress"
            );
          }
          const rows = await tx
            .insert(operations)
            .values({
              documentKey,
              formId: form.id,
              metadata,
              responseId: response.id,
              status: "pending",
              type: operationTypeForAction.submit,
            })
            .returning();
          return rows[0];
        });
        if (!operation) {
          fail(
            500,
            "operation_failed",
            "Unable to create submission operation"
          );
        }
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
      const rows = await db
        .select()
        .from(operations)
        .where(eq(operations.id, params.id))
        .limit(1);
      let operation = rows[0];
      if (!operation) {
        fail(404, "not_found", "Operation was not found");
      }
      operation = await expireOperationIfNeeded(operation);
      if (identity.role !== "admin") {
        if (!operation.responseId) {
          fail(403, "forbidden", "You may not access this operation");
        }
        const responseRows = await db
          .select({ userId: responses.userId })
          .from(responses)
          .where(eq(responses.id, operation.responseId))
          .limit(1);
        if (responseRows[0]?.userId !== identity.id) {
          fail(403, "forbidden", "You may not access this operation");
        }
      }
      const completedMetadata =
        operation.status === "completed"
          ? operationMetadata(operation.metadata)
          : undefined;
      return {
        operation: {
          createdAt: operation.createdAt,
          error: operation.error,
          formId: operation.formId,
          id: operation.id,
          responseId: operation.responseId,
          result: completedMetadata?.result,
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
      const rows = await db
        .select({
          formTitle: forms.title,
          submission: submissions,
          userEmail: user.email,
        })
        .from(submissions)
        .innerJoin(forms, eq(submissions.formId, forms.id))
        .innerJoin(user, eq(submissions.userId, user.id))
        .where(eq(submissions.id, params.id))
        .limit(1);
      const row = rows[0];
      const submission = row?.submission;
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      await canReadSubmission(identity, submission);
      const data =
        submission.data ??
        (submission.dataPath
          ? await readArtifactJson<JsonRecord>(submission.dataPath)
          : {});
      return {
        data,
        submission: submissionSummary(submission, {
          formTitle: row.formTitle,
          userEmail: row.userEmail,
        }),
      };
    })
    .get("/api/submissions/:id/docx", async ({ request, params, set }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const rows = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, params.id))
        .limit(1);
      const submission = rows[0];
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      await canReadSubmission(identity, submission);
      set.headers["Content-Type"] =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      set.headers["Content-Disposition"] =
        `attachment; filename="submission-${submission.id}.docx"`;
      return Bun.file(resolveArtifactPath(submission.docxPath));
    })
    .get("/api/submissions/:id/pdf", async ({ request, params, set }) => {
      const identity = await requireIdentity(request);
      validateId(params.id, "Submission");
      const rows = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, params.id))
        .limit(1);
      const submission = rows[0];
      if (!submission) {
        fail(404, "not_found", "Submission was not found");
      }
      await canReadSubmission(identity, submission);
      set.headers["Content-Type"] = "application/pdf";
      set.headers["Content-Disposition"] =
        `attachment; filename="submission-${submission.id}.pdf"`;
      return Bun.file(resolveArtifactPath(submission.pdfPath));
    })
    .get("/onlyoffice/document/:key", async ({ params, query, set }) => {
      const { key } = params;
      const token = typeof query.token === "string" ? query.token : "";
      if (!verifyDocumentAccessToken(token, key)) {
        fail(
          401,
          "unauthorized",
          "Document access token is invalid or expired"
        );
      }
      const relativePath = await operationDocumentPath(key);
      if (!relativePath || !(await artifactExists(relativePath))) {
        fail(404, "not_found", "Document was not found");
      }
      set.headers["Content-Type"] =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      return Bun.file(resolveArtifactPath(relativePath));
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
      const rows = await db
        .select()
        .from(operations)
        .where(eq(operations.id, operationId))
        .limit(1);
      const operation = rows[0];
      if (
        !operation ||
        operation.status === "completed" ||
        operation.status === "failed"
      ) {
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
          onlyOffice,
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

async function readArtifactFromAbsolute(
  absolutePath: string
): Promise<Uint8Array> {
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    fail(404, "not_found", "Template source was not found");
  }
  return new Uint8Array(await file.arrayBuffer());
}
