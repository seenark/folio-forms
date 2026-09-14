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
const accountEmailPattern = /^[^\s@]+@[^\s@]+$/u;
const operationTimeoutMs = 4 * 60_000;
const editorLeaseDurationMs = 90_000;
const callbackClaimLifetimeSeconds = 5 * 60;
const maxCallbackDocumentBytes = 25 * 1024 * 1024;
const maxCallbackBodyBytes = 64 * 1024;
const loginFailureLimit = 5;
const loginFailureWindowMs = 15 * 60_000;
const passwordMinimumLength = 12;
const passwordMaximumLength = 128;
const maxResponseDataBytes = 256 * 1024;
const accountUserPageSize = 20;
const accountBodyMaximumBytes = 64 * 1024;
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
interface LockedEditorLease extends ActiveEditorLease {
  expiresAt: Date;
  id: string;
}

type JsonRecord = Record<string, unknown>;
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
  | "onlyoffice_document_error"
  | "operation_timeout";
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
async function readJsonRecord(
  request: Request,
  maximumBytes: number
): Promise<JsonRecord> {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    fail(413, "payload_too_large", "Request body is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    fail(400, "invalid_request", "Request body must be a JSON object");
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
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    fail(400, "invalid_request", "Request body must be valid JSON");
  }
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
  action: OperationAction,
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
  targetId: string
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
    const [current] = await tx.$queryRaw<LockedEditorLease[]>(
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
      await lockActiveEditorLease(
        tx,
        input.authorization,
        input.capabilityScope
      );
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
      select: { metadata: true, stagingObjectKey: true },
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
    } catch {
      await updateOperationFailed(operation.id, "force_save_failed");
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
    capabilityScope.targetId
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
      formId: form.id,
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
      const capabilityScope = {
        documentKey: templateDraft.documentKey,
        formId: form.id,
        targetId: templateDraft.id,
        targetType: "template-draft",
      } as const;
      const lease = await claimEditorLease(
        identity,
        capabilityScope.targetType,
        capabilityScope.targetId
      );
      return editorConfig(
        {
          action: "template-edit",
          capabilities: {
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
          formId: form.id,
          lease: editorLeaseBridge(lease),
        },
        identity
      );
    })
    .post(
      "/api/admin/forms/:id/save",
      async ({ request, params, body, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const form = await findFormById(params.id);
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
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
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
      }
    )
    .post(
      "/api/admin/forms/:id/publish",
      async ({ request, params, body, set }) => {
        const authorization = await requireActionEditorAuthorization(request);
        const { actor: identity } = authorization;
        requireAdmin(identity);
        const form = await findFormById(params.id);
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
        const input = asRecord(body);
        const documentKey = requiredString(input, "documentKey");
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
        return userEditorConfig(form, identity, responseId, requestedAction);
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
            await lockActiveEditorLease(tx, authorization, capabilityScope);
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
        } catch {
          await updateOperationFailed(
            operation.id,
            "callback_processing_failed"
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
  return new Uint8Array(await file.arrayBuffer());
}
