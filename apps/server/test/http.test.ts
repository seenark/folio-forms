// oxlint-disable no-await-in-loop complexity -- The end-to-end journey deliberately keeps sequential transitions in one test.
import { expect, test } from "bun:test";

import { auth, ensureBootstrapAdmin } from "@onlyoffice/auth";
import { prisma } from "@onlyoffice/db";

import { createApp } from "../src/app";
import {
  DOCX_CONTENT_TYPE,
  objectExists,
  objectKey,
  putObject,
  readObject,
} from "../src/storage";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "The HTTP application test requires DATABASE_URL for an isolated PostgreSQL database"
  );
}

const app = createApp({
  onlyOffice: {
    convertDocxToPdf: () =>
      Promise.resolve(new TextEncoder().encode("%PDF-test")),
    forceSave: () => Promise.resolve(false),
  },
  requestIp: (request) => request.headers.get("x-test-ip"),
});
const jsonHeaders = { "Content-Type": "application/json" };

interface CredentialFixtureOptions {
  email: string;
  name: string;
  password: string;
  role?: "admin" | "user";
  mustChangePassword?: boolean;
}

const createCredentialFixture = async ({
  email,
  mustChangePassword = false,
  name,
  password,
  role = "user",
}: CredentialFixtureOptions): Promise<{ email: string; id: string }> => {
  const id = crypto.randomUUID();
  const authContext = await auth.$context;
  const passwordHash = await authContext.password.hash(password);
  await prisma.user.create({
    data: {
      accounts: {
        create: {
          accountId: id,
          id: crypto.randomUUID(),
          issuer: "local:credential",
          password: passwordHash,
          providerId: "credential",
        },
      },
      email,
      emailVerified: true,
      enabled: true,
      id,
      mustChangePassword,
      name,
      role,
    },
  });
  return { email, id };
};

const signIn = (
  email: string,
  password: string,
  sourceIp = `ticket-04-${crypto.randomUUID()}`
): Promise<Response> =>
  app.handle(
    new Request("http://test.local/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password }),
      headers: { ...jsonHeaders, "x-test-ip": sourceIp },
      method: "POST",
    })
  );

const bearerFor = async (
  email: string,
  password: string,
  sourceIp?: string
): Promise<string> => {
  const response = await signIn(email, password, sourceIp);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    session?: { token?: string };
    token?: string;
  };
  const token =
    response.headers.get("set-auth-token")?.replace(/^Bearer\s+/iu, "") ??
    body.token ??
    body.session?.token;
  if (!token) {
    throw new Error(`Sign-in did not return a bearer token for ${email}`);
  }
  return token;
};

const waitForOperation = async (
  token: string,
  operationId: string
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.handle(
      new Request(`http://test.local/api/operations/${operationId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      operation?: Record<string, unknown>;
    };
    const { operation } = body;
    if (operation?.status === "completed" || operation?.status === "failed") {
      return operation;
    }
    await Bun.sleep(5);
  }
  throw new Error(`Operation ${operationId} did not finish`);
};

test("serves authenticated Admin and User workflows through HTTP", async () => {
  const adminEmail = `ticket-02-admin-${crypto.randomUUID()}@example.com`;
  const userEmail = `ticket-02-user-${crypto.randomUUID()}@example.com`;
  const password = "Ticket02-password-for-test";
  const otherUserEmail = `ticket-03-other-${crypto.randomUUID()}@example.com`;
  const bootstrapEmail =
    process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const bootstrapName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  if (
    !bootstrapEmail ||
    !bootstrapName ||
    !process.env.BOOTSTRAP_ADMIN_PASSWORD
  ) {
    throw new Error(
      "The HTTP application test requires all BOOTSTRAP_ADMIN_* variables"
    );
  }
  const bootstrapUserSelect = {
    createdAt: true,
    email: true,
    enabled: true,
    id: true,
    mustChangePassword: true,
    name: true,
    role: true,
    updatedAt: true,
  } as const;

  const existingBootstrap = await prisma.user.findUnique({
    select: bootstrapUserSelect,
    where: { email: bootstrapEmail },
  });
  const existingBootstrapAccount = existingBootstrap
    ? await prisma.account.findFirst({
        where: { providerId: "credential", userId: existingBootstrap.id },
      })
    : null;
  const firstBootstrapResult = await ensureBootstrapAdmin();
  expect(firstBootstrapResult).toBe(!existingBootstrap);
  const bootstrapBefore = await prisma.user.findUnique({
    select: bootstrapUserSelect,
    where: { email: bootstrapEmail },
  });
  if (!bootstrapBefore) {
    throw new Error("Bootstrap Admin was not created");
  }
  const bootstrapAccountBefore = await prisma.account.findFirst({
    where: { providerId: "credential", userId: bootstrapBefore.id },
  });
  if (existingBootstrap) {
    expect(bootstrapBefore).toEqual(existingBootstrap);
    expect(bootstrapAccountBefore).toEqual(existingBootstrapAccount);
  } else {
    expect(bootstrapBefore).toMatchObject({
      email: bootstrapEmail,
      enabled: true,
      mustChangePassword: true,
      name: bootstrapName,
      role: "admin",
    });
    expect(bootstrapAccountBefore).toMatchObject({
      accountId: bootstrapBefore.id,
      issuer: "local:credential",
      password: expect.any(String),
      providerId: "credential",
      userId: bootstrapBefore.id,
    });
  }
  const adminCountBeforeSecondEnsure = await prisma.user.count({
    where: { role: "admin" },
  });

  const secondBootstrapResult = await ensureBootstrapAdmin();
  expect(secondBootstrapResult).toBe(false);
  expect(
    await prisma.user.count({
      where: { role: "admin" },
    })
  ).toBe(adminCountBeforeSecondEnsure);
  const bootstrapAfter = await prisma.user.findUnique({
    select: bootstrapUserSelect,
    where: { id: bootstrapBefore.id },
  });
  const bootstrapAccountAfter = await prisma.account.findFirst({
    where: { providerId: "credential", userId: bootstrapBefore.id },
  });
  expect(bootstrapAfter).toEqual(bootstrapBefore);
  expect(bootstrapAccountAfter).toEqual(bootstrapAccountBefore);

  const signupEmail = `ticket-04-signup-${crypto.randomUUID()}@example.com`;
  const signupResponse = await app.handle(
    new Request("http://test.local/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: signupEmail,
        name: "Ticket 04 Direct Signup",
        password,
      }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
  expect(signupResponse.status).toBe(404);
  expect(
    await prisma.user.findUnique({
      where: { email: signupEmail },
    })
  ).toBeNull();

  const healthResponse = await app.handle(
    new Request("http://test.local/health")
  );
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({ ok: true });

  const unauthorizedResponse = await app.handle(
    new Request("http://test.local/api/admin/forms", {
      body: JSON.stringify({ title: "Denied Form" }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
  expect(unauthorizedResponse.status).toBe(401);
  expect(await unauthorizedResponse.json()).toMatchObject({
    error: "unauthorized",
  });

  const admin = await createCredentialFixture({
    email: adminEmail,
    name: "Ticket 04 Workflow Admin",
    password,
    role: "admin",
  });
  const adminId = admin.id;
  const adminBearer = await bearerFor(adminEmail, password);
  const secretFormTitle = `Ticket 04 secret title ${crypto.randomUUID()}`;
  const secretFormDescription = `Ticket 04 secret description ${crypto.randomUUID()}`;

  const createResponse = await app.handle(
    new Request("http://test.local/api/admin/forms", {
      body: JSON.stringify({
        description: secretFormDescription,
        title: secretFormTitle,
      }),
      headers: { ...jsonHeaders, Authorization: `Bearer ${adminBearer}` },
      method: "POST",
    })
  );
  expect(createResponse.status).toBe(200);
  const createdForm = (await createResponse.json()) as {
    form?: {
      id?: string;
      templateDocumentKey?: string;
      title?: string;
    };
    templateAvailable?: boolean;
  };
  const formId = createdForm.form?.id;
  expect(createdForm.form?.title).toBe(secretFormTitle);
  expect(createdForm.templateAvailable).toBe(true);
  const templateDocumentKey = createdForm.form?.templateDocumentKey;
  if (!formId || !templateDocumentKey) {
    throw new Error("The test form did not receive a template document key");
  }

  const listResponse = await app.handle(
    new Request("http://test.local/api/admin/forms", {
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
  );
  expect(listResponse.status).toBe(200);
  const listBody = (await listResponse.json()) as {
    forms?: { id: string; title: string }[];
  };
  expect(
    listBody.forms?.some(
      (form) => form.id === formId && form.title === secretFormTitle
    )
  ).toBe(true);

  const publishResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/publish`, {
      body: JSON.stringify({ documentKey: templateDocumentKey }),
      headers: { ...jsonHeaders, Authorization: `Bearer ${adminBearer}` },
      method: "POST",
    })
  );
  expect(publishResponse.status).toBe(202);
  const publishBody = (await publishResponse.json()) as {
    operationId?: string;
  };
  if (!publishBody.operationId) {
    throw new Error("The publish operation was not created");
  }
  const publishOperation = await waitForOperation(
    adminBearer,
    publishBody.operationId
  );
  expect(publishOperation.status).toBe("completed");

  await createCredentialFixture({
    email: userEmail,
    name: "Ticket 04 Workflow User",
    password,
  });
  const userBearer = await bearerFor(userEmail, password);

  const formRecord = await prisma.form.findUnique({
    select: { publicId: true },
    where: { id: formId },
  });
  if (!formRecord) {
    throw new Error("The published test form was not found");
  }
  const unauthenticatedMetadataResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}`)
  );
  expect(unauthenticatedMetadataResponse.status).toBe(401);
  const unauthenticatedMetadataBody =
    (await unauthenticatedMetadataResponse.json()) as Record<string, unknown>;
  expect(JSON.stringify(unauthenticatedMetadataBody)).not.toContain(
    secretFormTitle
  );
  expect(JSON.stringify(unauthenticatedMetadataBody)).not.toContain(
    secretFormDescription
  );
  expect(JSON.stringify(unauthenticatedMetadataBody)).not.toContain(
    "published"
  );
  const authenticatedMetadataResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}`, {
      headers: { Authorization: `Bearer ${userBearer}` },
    })
  );
  expect(authenticatedMetadataResponse.status).toBe(200);
  expect(await authenticatedMetadataResponse.json()).toMatchObject({
    form: {
      description: secretFormDescription,
      title: secretFormTitle,
    },
  });
  const userDeleteFormResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}`, {
      headers: { Authorization: `Bearer ${userBearer}` },
      method: "DELETE",
    })
  );
  expect(userDeleteFormResponse.status).toBe(403);

  const startResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/start`, {
      headers: { Authorization: `Bearer ${userBearer}` },
      method: "POST",
    })
  );
  expect(startResponse.status).toBe(200);
  const startBody = (await startResponse.json()) as {
    response?: { id?: string };
  };
  const responseId = startBody.response?.id;
  if (!responseId) {
    throw new Error("The response was not started");
  }

  const editorResponse = await app.handle(
    new Request(
      `http://test.local/api/forms/${formRecord.publicId}/editor-config?responseId=${responseId}&action=fill`,
      { headers: { Authorization: `Bearer ${userBearer}` } }
    )
  );
  expect(editorResponse.status).toBe(200);
  const editorConfig = (await editorResponse.json()) as {
    document?: { key?: string };
  };
  const responseDocumentKey = editorConfig.document?.key;
  if (!responseDocumentKey) {
    throw new Error("The response editor document key was not returned");
  }

  const saveResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/draft`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: { ...jsonHeaders, Authorization: `Bearer ${userBearer}` },
      method: "POST",
    })
  );
  expect(saveResponse.status).toBe(202);
  const saveBody = (await saveResponse.json()) as {
    operationId?: string;
  };
  if (!saveBody.operationId) {
    throw new Error("The draft operation was not created");
  }
  const saveOperation = await waitForOperation(
    userBearer,
    saveBody.operationId
  );
  expect(saveOperation.status).toBe("completed");

  const submitResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/submit`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: { ...jsonHeaders, Authorization: `Bearer ${userBearer}` },
      method: "POST",
    })
  );
  expect(submitResponse.status).toBe(202);
  const submitBody = (await submitResponse.json()) as {
    operationId?: string;
    submissionId?: string;
  };
  const completedSubmissionId = submitBody.submissionId;
  if (!submitBody.operationId || !completedSubmissionId) {
    throw new Error("The submit operation was not created");
  }
  const submitOperation = await waitForOperation(
    userBearer,
    submitBody.operationId
  );
  expect(submitOperation.status).toBe("completed");
  await createCredentialFixture({
    email: otherUserEmail,
    name: "Ticket 04 Other User",
    password,
  });
  const otherUserBearer = await bearerFor(otherUserEmail, password);
  const forbiddenDocxResponse = await app.handle(
    new Request(
      `http://test.local/api/submissions/${completedSubmissionId}/docx`,
      { headers: { Authorization: `Bearer ${otherUserBearer}` } }
    )
  );
  expect(forbiddenDocxResponse.status).toBe(403);

  const dataResponse = await app.handle(
    new Request(
      `http://test.local/api/submissions/${completedSubmissionId}/data`,
      {
        headers: { Authorization: `Bearer ${userBearer}` },
      }
    )
  );
  expect(dataResponse.status).toBe(200);
  expect(await dataResponse.json()).toMatchObject({
    data: {},
    submission: { id: completedSubmissionId, responseId },
  });

  const docxResponse = await app.handle(
    new Request(
      `http://test.local/api/submissions/${completedSubmissionId}/docx`,
      {
        headers: { Authorization: `Bearer ${userBearer}` },
      }
    )
  );
  expect(docxResponse.status).toBe(200);
  expect(docxResponse.headers.get("content-type")).toBe(DOCX_CONTENT_TYPE);
  const submissionDocument = new Uint8Array(await docxResponse.arrayBuffer());
  const templateDraft = await prisma.templateDraft.findUnique({
    select: { documentKey: true, id: true, objectKey: true },
    where: { formId },
  });
  if (!templateDraft) {
    throw new Error("The test template draft was not found");
  }
  const sourceDocument = await readObject(templateDraft.objectKey);
  expect(submissionDocument).toEqual(Uint8Array.from(sourceDocument));

  const pdfResponse = await app.handle(
    new Request(
      `http://test.local/api/submissions/${completedSubmissionId}/pdf`,
      {
        headers: { Authorization: `Bearer ${userBearer}` },
      }
    )
  );
  expect(pdfResponse.status).toBe(200);
  expect(await pdfResponse.text()).toBe("%PDF-test");
  const staleOperationId = crypto.randomUUID();
  const staleStagingObjectKey = objectKey(
    "operations",
    staleOperationId,
    "staged.docx"
  );
  const staleFinalObjectKey = objectKey(
    "operations",
    staleOperationId,
    "final.docx"
  );
  await Promise.all([
    putObject(staleStagingObjectKey, sourceDocument, DOCX_CONTENT_TYPE),
    putObject(staleFinalObjectKey, sourceDocument, DOCX_CONTENT_TYPE),
  ]);
  await prisma.operation.create({
    data: {
      actorId: adminId,
      documentKey: templateDraft.documentKey,
      errorCode: null,
      formId,
      id: staleOperationId,
      metadata: {
        action: "save-template",
        finalObjectKey: staleFinalObjectKey,
        formId,
        stagedObjectKey: staleStagingObjectKey,
      },
      ownerUserId: adminId,
      stagingObjectKey: staleStagingObjectKey,
      status: "processing",
      targetId: templateDraft.id,
      targetType: "template_draft",
      type: "save_template_draft",
      updatedAt: new Date(0),
    },
  });
  const expiredOperationResponse = await app.handle(
    new Request(`http://test.local/api/operations/${staleOperationId}`, {
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
  );
  expect(expiredOperationResponse.status).toBe(200);
  expect(await expiredOperationResponse.json()).toMatchObject({
    operation: { id: staleOperationId, status: "failed" },
  });
  expect(await objectExists(staleStagingObjectKey)).toBe(false);
  expect(await objectExists(staleFinalObjectKey)).toBe(false);
  expect(await objectExists(templateDraft.objectKey)).toBe(true);
  const passwordEmail = `ticket-04-password-${crypto.randomUUID()}@example.com`;
  const currentPassword = "Ticket04-current-password";
  const passwordUser = await createCredentialFixture({
    email: passwordEmail,
    mustChangePassword: true,
    name: "Ticket 04 Password User",
    password: currentPassword,
  });
  const mandatoryToken = await bearerFor(
    passwordEmail,
    currentPassword,
    `ticket-04-password-${crypto.randomUUID()}`
  );
  const mandatorySessionResponse = await app.handle(
    new Request("http://test.local/api/session", {
      headers: { Authorization: `Bearer ${mandatoryToken}` },
    })
  );
  expect(mandatorySessionResponse.status).toBe(200);
  expect(await mandatorySessionResponse.json()).toMatchObject({
    user: { mustChangePassword: true },
  });
  const restrictedProductResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}`, {
      headers: { Authorization: `Bearer ${mandatoryToken}` },
    })
  );
  expect(restrictedProductResponse.status).toBe(403);
  expect(await restrictedProductResponse.json()).toMatchObject({
    error: "password_change_required",
  });

  const replacePassword = (
    token: string,
    oldPassword: string,
    newPassword: string
  ): Promise<Response> =>
    app.handle(
      new Request("http://test.local/api/account/password", {
        body: JSON.stringify({
          currentPassword: oldPassword,
          newPassword,
        }),
        headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
        method: "POST",
      })
    );

  const tooShortResponse = await replacePassword(
    mandatoryToken,
    currentPassword,
    "x".repeat(11)
  );
  expect(tooShortResponse.status).toBe(400);
  expect(await tooShortResponse.json()).toMatchObject({
    error: "password_too_short",
  });

  const spacesPassword = " ".repeat(12);
  const spacesReplacementResponse = await replacePassword(
    mandatoryToken,
    currentPassword,
    spacesPassword
  );
  expect(spacesReplacementResponse.status).toBe(200);
  expect(await spacesReplacementResponse.json()).toEqual({ ok: true });
  const invalidatedMandatorySession = await app.handle(
    new Request("http://test.local/api/session", {
      headers: { Authorization: `Bearer ${mandatoryToken}` },
    })
  );
  expect(invalidatedMandatorySession.status).toBe(401);

  const spacesToken = await bearerFor(
    passwordEmail,
    spacesPassword,
    `ticket-04-spaces-${crypto.randomUUID()}`
  );
  const persistedSession = await prisma.session.findFirst({
    orderBy: { createdAt: "desc" },
    where: { userId: passwordUser.id },
  });
  if (!persistedSession) {
    throw new Error("The replacement password session was not persisted");
  }
  const sessionDurationMs = 60 * 60 * 1000;
  expect(
    Math.abs(
      persistedSession.expiresAt.getTime() -
        persistedSession.createdAt.getTime() -
        sessionDurationMs
    )
  ).toBeLessThanOrEqual(1000);

  interface SessionBody {
    session?: { expiresAt?: string };
    user?: { mustChangePassword?: boolean };
  }
  const readSession = async (token: string): Promise<SessionBody> => {
    const response = await app.handle(
      new Request("http://test.local/api/session", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(200);
    return (await response.json()) as SessionBody;
  };
  const firstSessionRead = await readSession(spacesToken);
  const secondSessionRead = await readSession(spacesToken);
  const firstExpiresAt = firstSessionRead.session?.expiresAt;
  const secondExpiresAt = secondSessionRead.session?.expiresAt;
  expect(firstSessionRead.user?.mustChangePassword).toBe(false);
  expect(firstExpiresAt).toBe(secondExpiresAt);
  expect(firstExpiresAt).toBe(persistedSession.expiresAt.toISOString());

  const maximumPassword = "x".repeat(128);
  const maximumReplacementResponse = await replacePassword(
    spacesToken,
    spacesPassword,
    maximumPassword
  );
  expect(maximumReplacementResponse.status).toBe(200);
  expect(await maximumReplacementResponse.json()).toEqual({ ok: true });
  const invalidatedSpacesSession = await app.handle(
    new Request("http://test.local/api/session", {
      headers: { Authorization: `Bearer ${spacesToken}` },
    })
  );
  expect(invalidatedSpacesSession.status).toBe(401);

  const maximumToken = await bearerFor(
    passwordEmail,
    maximumPassword,
    `ticket-04-maximum-${crypto.randomUUID()}`
  );
  const tooLongResponse = await replacePassword(
    maximumToken,
    maximumPassword,
    "x".repeat(129)
  );
  expect(tooLongResponse.status).toBe(400);
  expect(await tooLongResponse.json()).toMatchObject({
    error: "password_too_long",
  });
  const maximumSession = await readSession(maximumToken);
  expect(maximumSession.user?.mustChangePassword).toBe(false);

  const logoutResponse = await app.handle(
    new Request("http://test.local/api/auth/sign-out", {
      headers: { Authorization: `Bearer ${maximumToken}` },
      method: "POST",
    })
  );
  expect(logoutResponse.status).toBe(200);
  const revokedLogoutSession = await app.handle(
    new Request("http://test.local/api/session", {
      headers: { Authorization: `Bearer ${maximumToken}` },
    })
  );
  expect(revokedLogoutSession.status).toBe(401);

  const throttleEmail = `ticket-04-throttle-${crypto.randomUUID()}@example.com`;
  const throttlePassword = "Ticket04-throttle-password";
  await createCredentialFixture({
    email: throttleEmail,
    name: "Ticket 04 Throttle User",
    password: throttlePassword,
  });
  const knownWrongResponse = await signIn(
    throttleEmail,
    "wrong-password",
    `ticket-04-known-${crypto.randomUUID()}`
  );
  const knownWrongBody = (await knownWrongResponse.json()) as {
    error?: string;
  };
  const unknownWrongResponse = await signIn(
    `ticket-04-unknown-${crypto.randomUUID()}@example.com`,
    "wrong-password",
    `ticket-04-unknown-${crypto.randomUUID()}`
  );
  const unknownWrongBody = (await unknownWrongResponse.json()) as {
    error?: string;
  };
  expect(knownWrongResponse.status).toBe(401);
  expect(unknownWrongResponse.status).toBe(401);
  expect(knownWrongBody.error).toBe("invalid_credentials");
  expect(unknownWrongBody.error).toBe(knownWrongBody.error);

  const parallelEmail = `ticket-04-parallel-${crypto.randomUUID()}@example.com`;
  const parallelIp = `ticket-04-parallel-ip-${crypto.randomUUID()}`;
  const parallelResponses = await Promise.all(
    Array.from({ length: 8 }, () =>
      signIn(parallelEmail, "wrong-password", parallelIp)
    )
  );
  const parallelStatuses = parallelResponses
    .map((response) => response.status)
    .toSorted((left, right) => left - right);
  expect(parallelStatuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);

  const normalizedIp = `ticket-04-normalized-ip-${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const emailVariant =
      attempt % 2 === 0 ? ` ${throttleEmail.toUpperCase()} ` : throttleEmail;
    const response = await signIn(emailVariant, "wrong-password", normalizedIp);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_credentials",
    });
  }
  const normalizedSixthResponse = await signIn(
    ` ${throttleEmail.toUpperCase()} `,
    "wrong-password",
    normalizedIp
  );
  expect(normalizedSixthResponse.status).toBe(429);
  expect(await normalizedSixthResponse.json()).toMatchObject({
    error: "login_throttled",
  });

  const isolatedIp = `ticket-04-isolated-ip-${crypto.randomUUID()}`;
  const isolatedResponse = await signIn(
    throttleEmail,
    "wrong-password",
    isolatedIp
  );
  expect(isolatedResponse.status).toBe(401);
  expect(await isolatedResponse.json()).toMatchObject({
    error: "invalid_credentials",
  });

  const clearingIp = `ticket-04-clearing-ip-${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await signIn(throttleEmail, "wrong-password", clearingIp);
    expect(response.status).toBe(401);
  }
  const successfulLoginToken = await bearerFor(
    throttleEmail,
    throttlePassword,
    clearingIp
  );
  expect(successfulLoginToken).toBeTruthy();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await signIn(throttleEmail, "wrong-password", clearingIp);
    expect(response.status).toBe(401);
  }
  const clearedSixthResponse = await signIn(
    throttleEmail,
    "wrong-password",
    clearingIp
  );
  expect(clearedSixthResponse.status).toBe(429);
  expect(await clearedSixthResponse.json()).toMatchObject({
    error: "login_throttled",
  });
});
