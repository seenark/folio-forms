// oxlint-disable no-await-in-loop -- Operation polling must observe each sequential state transition.
import { expect, test } from "bun:test";

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
});
const jsonHeaders = { "Content-Type": "application/json" };

const bearerFor = async (email: string, password: string): Promise<string> => {
  const response = await app.handle(
    new Request("http://test.local/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
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

  const adminSignUp = await app.handle(
    new Request("http://test.local/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: adminEmail,
        name: "Ticket 02 Admin",
        password,
      }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
  expect(adminSignUp.status).toBe(200);
  const admin = await prisma.user.findUnique({
    select: { id: true },
    where: { email: adminEmail },
  });
  const adminId = admin?.id;
  if (!adminId) {
    throw new Error("The test Admin account was not created");
  }
  await prisma.user.update({
    data: { role: "admin" },
    where: { id: adminId },
  });
  const adminBearer = await bearerFor(adminEmail, password);

  const createResponse = await app.handle(
    new Request("http://test.local/api/admin/forms", {
      body: JSON.stringify({
        description: "Ticket 02 HTTP proof",
        title: "Ticket 02 Form",
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
  expect(createdForm.form?.title).toBe("Ticket 02 Form");
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
      (form) => form.id === formId && form.title === "Ticket 02 Form"
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

  const userSignUp = await app.handle(
    new Request("http://test.local/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: userEmail,
        name: "Ticket 02 User",
        password,
      }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
  expect(userSignUp.status).toBe(200);

  const user = await prisma.user.findUnique({
    select: { id: true },
    where: { email: userEmail },
  });
  if (!user) {
    throw new Error("The test User account was not created");
  }
  const userBearer = await bearerFor(userEmail, password);

  const formRecord = await prisma.form.findUnique({
    select: { publicId: true },
    where: { id: formId },
  });
  if (!formRecord) {
    throw new Error("The published test form was not found");
  }

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
  const otherUserSignUp = await app.handle(
    new Request("http://test.local/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: otherUserEmail,
        name: "Ticket 03 Other User",
        password,
      }),
      headers: jsonHeaders,
      method: "POST",
    })
  );
  expect(otherUserSignUp.status).toBe(200);
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
});
