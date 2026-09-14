// oxlint-disable no-await-in-loop complexity -- The end-to-end journey deliberately keeps sequential transitions in one test.
import { expect, test } from "bun:test";

import { auth, ensureBootstrapAdmin } from "@onlyoffice/auth";
import { prisma } from "@onlyoffice/db";

import { createApp, resolveCallbackDocumentUrl } from "../src/app";
import type { EditorCapabilityAction } from "../src/onlyoffice";
import {
  createCallbackUserdata,
  createDocumentAccessToken,
  createEditorCapability,
  createOnlyOfficeBodyToken,
  createOnlyOfficeAuthorization,
  pluginGuid,
  verifyEditorCapability,
  verifyOnlyOfficeAuthorization,
} from "../src/onlyoffice";
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
interface CallbackOperationFixture {
  documentKey: string;
  finalObjectKey: string;
  id: string;
  userdata: string;
}

interface EditorConfigBody {
  apiUrl: string;
  bridge: {
    capabilities: Partial<Record<EditorCapabilityAction, string>>;
    id: string;
    pluginOrigin: string;
  };
  config: {
    document: { key: string; url: string };
    editorConfig: {
      plugins: {
        options: Record<
          string,
          {
            authToken?: unknown;
            bridgeId: string;
            parentOrigin: string;
          }
        >;
      };
    };
    token: string;
  };
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
  operationId: string,
  headers: Record<string, string>
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.handle(
      new Request(`http://test.local/api/operations/${operationId}`, {
        headers,
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
const callbackPayload = (
  operation: CallbackOperationFixture,
  url: string
): Record<string, unknown> => ({
  key: operation.documentKey,
  status: 6,
  url,
  userdata: operation.userdata,
});

const tamperAuthorization = (authorization: string): string => {
  const [scheme, token] = authorization.split(" ");
  const [header, payload, signature] = token?.split(".") ?? [];
  if (!scheme || !header || !payload || !signature) {
    throw new Error("The ONLYOFFICE authorization was malformed");
  }
  return `${scheme} ${header}.${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
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
  expect(
    resolveCallbackDocumentUrl(
      "https://docs.example//169.254.169.254/latest/meta-data?key=value",
      new Set(["https://docs.example"]),
      "https://docs.example",
      "http://onlyoffice"
    )
  ).toBe("http://onlyoffice//169.254.169.254/latest/meta-data?key=value");
  expect(
    resolveCallbackDocumentUrl(
      "https://user:password@docs.example/document.docx",
      new Set(["https://docs.example"]),
      "https://docs.example",
      "http://onlyoffice"
    )
  ).toBeNull();
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

  const adminEditorResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/editor-config`, {
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
  );
  expect(adminEditorResponse.status).toBe(200);
  const adminEditor = (await adminEditorResponse.json()) as EditorConfigBody;
  const adminPluginOptions =
    adminEditor.config.editorConfig.plugins.options[pluginGuid];
  const publishCapability = adminEditor.bridge.capabilities.publish;
  const saveTemplateCapability =
    adminEditor.bridge.capabilities["save-template"];
  if (!adminPluginOptions || !publishCapability || !saveTemplateCapability) {
    throw new Error("The Admin editor capabilities were not returned");
  }
  const adminEditorSerialized = JSON.stringify(adminEditor);
  expect(adminEditorSerialized).not.toContain(adminBearer);
  expect(adminEditorSerialized).not.toContain('"authToken"');
  expect(JSON.stringify(adminEditor.config)).not.toContain(publishCapability);
  expect(adminEditor.bridge.id).toBe(adminPluginOptions.bridgeId);
  expect(adminEditor.bridge.pluginOrigin).toBe(
    new URL(process.env.API_BASE ?? "http://localhost:3000").origin
  );
  expect(adminPluginOptions.parentOrigin).toBe(
    new URL(process.env.CORS_ORIGIN ?? "http://localhost:5173").origin
  );
  expect(adminEditor.config.token.length).toBeGreaterThan(20);
  const publishClaims = verifyEditorCapability(publishCapability);
  expect(publishClaims).toMatchObject({
    action: "publish",
    actorId: adminId,
    documentKey: templateDocumentKey,
    formId,
    role: "admin",
    targetType: "template-draft",
  });
  expect((publishClaims?.expiresAt ?? 0) - (publishClaims?.issuedAt ?? 0)).toBe(
    5 * 60
  );

  const capabilityHeaders = (capability: string): Record<string, string> => ({
    ...jsonHeaders,
    "X-Editor-Capability": capability,
  });
  const crossActionResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/save`, {
      body: JSON.stringify({ documentKey: templateDocumentKey }),
      headers: capabilityHeaders(publishCapability),
      method: "POST",
    })
  );
  expect(crossActionResponse.status).toBe(403);

  const [capabilityHeader, capabilityPayload, capabilitySignature] =
    publishCapability.split(".");
  if (!capabilityHeader || !capabilityPayload || !capabilitySignature) {
    throw new Error("The Admin editor capability was malformed");
  }
  const tamperedPublishCapability = [
    capabilityHeader,
    capabilityPayload,
    `${capabilitySignature[0] === "a" ? "b" : "a"}${capabilitySignature.slice(1)}`,
  ].join(".");
  const tamperedCapabilityResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/publish`, {
      body: JSON.stringify({ documentKey: templateDocumentKey }),
      headers: capabilityHeaders(tamperedPublishCapability),
      method: "POST",
    })
  );
  expect(tamperedCapabilityResponse.status).toBe(401);

  if (!publishClaims) {
    throw new Error("The Admin publish capability did not verify");
  }
  const expiredPublishCapability = createEditorCapability({
    action: publishClaims.action,
    actorId: publishClaims.actorId,
    documentKey: publishClaims.documentKey,
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    formId: publishClaims.formId,
    role: publishClaims.role,
    targetId: publishClaims.targetId,
    targetType: publishClaims.targetType,
  });
  const expiredCapabilityResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/publish`, {
      body: JSON.stringify({ documentKey: templateDocumentKey }),
      headers: capabilityHeaders(expiredPublishCapability),
      method: "POST",
    })
  );
  expect(expiredCapabilityResponse.status).toBe(401);

  const secondCreateResponse = await app.handle(
    new Request("http://test.local/api/admin/forms", {
      body: JSON.stringify({ title: "Capability scope target" }),
      headers: { ...jsonHeaders, Authorization: `Bearer ${adminBearer}` },
      method: "POST",
    })
  );
  expect(secondCreateResponse.status).toBe(200);
  const secondCreatedForm = (await secondCreateResponse.json()) as {
    form?: { id?: string; templateDocumentKey?: string };
  };
  if (
    !secondCreatedForm.form?.id ||
    !secondCreatedForm.form.templateDocumentKey
  ) {
    throw new Error("The cross-target Form was not created");
  }
  const crossTargetResponse = await app.handle(
    new Request(
      `http://test.local/api/admin/forms/${secondCreatedForm.form.id}/publish`,
      {
        body: JSON.stringify({
          documentKey: secondCreatedForm.form.templateDocumentKey,
        }),
        headers: capabilityHeaders(publishCapability),
        method: "POST",
      }
    )
  );
  expect(crossTargetResponse.status).toBe(403);

  const documentUrl = adminEditor.config.document.url;
  const unsignedDocumentResponse = await app.handle(new Request(documentUrl));
  expect(unsignedDocumentResponse.status).toBe(401);
  const alteredDocumentUrl = new URL(documentUrl);
  alteredDocumentUrl.searchParams.set(
    "token",
    `${alteredDocumentUrl.searchParams.get("token") ?? ""}x`
  );
  const alteredDocumentResponse = await app.handle(
    new Request(alteredDocumentUrl.toString(), {
      headers: {
        Authorization: createOnlyOfficeAuthorization({
          url: alteredDocumentUrl.toString(),
        }),
      },
    })
  );
  expect(alteredDocumentResponse.status).toBe(401);
  const expiredDocumentUrl = new URL(documentUrl);
  expiredDocumentUrl.searchParams.set(
    "token",
    createDocumentAccessToken(
      templateDocumentKey,
      Math.floor(Date.now() / 1000) - 1
    )
  );
  const expiredDocumentResponse = await app.handle(
    new Request(expiredDocumentUrl.toString(), {
      headers: {
        Authorization: createOnlyOfficeAuthorization({
          url: expiredDocumentUrl.toString(),
        }),
      },
    })
  );
  expect(expiredDocumentResponse.status).toBe(401);
  const signedDocumentResponse = await app.handle(
    new Request(documentUrl, {
      headers: {
        Authorization: createOnlyOfficeAuthorization({ url: documentUrl }),
      },
    })
  );
  expect(signedDocumentResponse.status).toBe(200);
  expect(signedDocumentResponse.headers.get("content-type")).toBe(
    DOCX_CONTENT_TYPE
  );

  const forbiddenPluginOriginResponse = await app.handle(
    new Request("http://test.local/onlyoffice-plugin/config.json", {
      headers: { Origin: "https://attacker.example" },
    })
  );
  expect(forbiddenPluginOriginResponse.status).toBe(403);
  const sameOriginPluginConfigResponse = await app.handle(
    new Request("http://test.local/onlyoffice-plugin/config.json")
  );
  expect(sameOriginPluginConfigResponse.status).toBe(200);
  expect(
    sameOriginPluginConfigResponse.headers.get("access-control-allow-origin")
  ).toBeNull();
  const allowedPluginOrigin = new URL(
    process.env.ONLYOFFICE_URL ?? "http://localhost:8080"
  ).origin;
  const pluginConfigResponse = await app.handle(
    new Request("http://test.local/onlyoffice-plugin/config.json", {
      headers: { Origin: allowedPluginOrigin },
    })
  );
  expect(pluginConfigResponse.status).toBe(200);
  expect(pluginConfigResponse.headers.get("access-control-allow-origin")).toBe(
    allowedPluginOrigin
  );
  const saveTemplateResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/save`, {
      body: JSON.stringify({ documentKey: templateDocumentKey }),
      headers: capabilityHeaders(saveTemplateCapability),
      method: "POST",
    })
  );
  expect(saveTemplateResponse.status).toBe(202);
  const saveTemplateBody = (await saveTemplateResponse.json()) as {
    operationCapability?: string;
    operationId?: string;
  };
  if (!saveTemplateBody.operationCapability || !saveTemplateBody.operationId) {
    throw new Error("The template save operation was not created");
  }
  const saveTemplatePollClaims = verifyEditorCapability(
    saveTemplateBody.operationCapability
  );
  expect(saveTemplatePollClaims).toMatchObject({
    action: "poll-operation",
    operationId: saveTemplateBody.operationId,
  });
  expect(
    (saveTemplatePollClaims?.expiresAt ?? 0) -
      (saveTemplatePollClaims?.issuedAt ?? 0)
  ).toBe(6 * 60);
  const saveTemplateOperation = await waitForOperation(
    saveTemplateBody.operationId,
    {
      "X-Editor-Capability": saveTemplateBody.operationCapability,
    }
  );
  expect(saveTemplateOperation.status).toBe("completed");

  const refreshedAdminEditorResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/editor-config`, {
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
  );
  expect(refreshedAdminEditorResponse.status).toBe(200);
  const refreshedAdminEditor =
    (await refreshedAdminEditorResponse.json()) as EditorConfigBody;
  const activeTemplateDocumentKey = refreshedAdminEditor.config.document.key;
  const activePublishCapability =
    refreshedAdminEditor.bridge.capabilities.publish;
  if (!activeTemplateDocumentKey || !activePublishCapability) {
    throw new Error("The refreshed Admin editor capability was not returned");
  }
  expect(activeTemplateDocumentKey).not.toBe(templateDocumentKey);
  const publishResponse = await app.handle(
    new Request(`http://test.local/api/admin/forms/${formId}/publish`, {
      body: JSON.stringify({ documentKey: activeTemplateDocumentKey }),
      headers: capabilityHeaders(activePublishCapability),
      method: "POST",
    })
  );
  expect(publishResponse.status).toBe(202);
  const publishBody = (await publishResponse.json()) as {
    operationCapability?: string;
    operationId?: string;
  };
  if (!publishBody.operationCapability || !publishBody.operationId) {
    throw new Error("The publish operation was not created");
  }
  const publishPollClaims = verifyEditorCapability(
    publishBody.operationCapability
  );
  expect(publishPollClaims).toMatchObject({
    action: "poll-operation",
    operationId: publishBody.operationId,
  });
  expect(
    (publishPollClaims?.expiresAt ?? 0) - (publishPollClaims?.issuedAt ?? 0)
  ).toBe(6 * 60);
  const publishOperation = await waitForOperation(publishBody.operationId, {
    "X-Editor-Capability": publishBody.operationCapability,
  });
  expect(publishOperation.status).toBe("completed");

  const user = await createCredentialFixture({
    email: userEmail,
    name: "Ticket 04 Workflow User",
    password,
  });
  const userId = user.id;
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
  const editorConfig = (await editorResponse.json()) as EditorConfigBody;
  const responseDocumentKey = editorConfig.config.document.key;
  const userPluginOptions =
    editorConfig.config.editorConfig.plugins.options[pluginGuid];
  const saveDraftCapability = editorConfig.bridge.capabilities["save-draft"];
  const submitCapability = editorConfig.bridge.capabilities.submit;
  if (
    !userPluginOptions ||
    !responseDocumentKey ||
    !saveDraftCapability ||
    !submitCapability
  ) {
    throw new Error("The User editor capabilities were not returned");
  }
  const userEditorSerialized = JSON.stringify(editorConfig);
  expect(userEditorSerialized).not.toContain(userBearer);
  expect(userEditorSerialized).not.toContain('"authToken"');
  expect(JSON.stringify(editorConfig.config)).not.toContain(
    saveDraftCapability
  );
  expect(editorConfig.bridge.id).toBe(userPluginOptions.bridgeId);
  const saveDraftClaims = verifyEditorCapability(saveDraftCapability);
  expect(saveDraftClaims).toMatchObject({
    action: "save-draft",
    actorId: userId,
    documentKey: responseDocumentKey,
    formId,
    role: "user",
    targetId: responseId,
    targetType: "response",
  });
  if (!saveDraftClaims) {
    throw new Error("The save-draft capability was invalid");
  }
  await prisma.user.update({
    data: { enabled: false },
    where: { id: userId },
  });
  const disabledActorResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/draft`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: capabilityHeaders(saveDraftCapability),
      method: "POST",
    })
  );
  expect(disabledActorResponse.status).toBe(401);
  await prisma.user.update({
    data: { enabled: true, role: "admin" },
    where: { id: userId },
  });
  const changedRoleResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/draft`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: capabilityHeaders(saveDraftCapability),
      method: "POST",
    })
  );
  expect(changedRoleResponse.status).toBe(401);
  await prisma.user.update({
    data: { role: "user" },
    where: { id: userId },
  });
  const userCrossActionResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/draft`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: capabilityHeaders(submitCapability),
      method: "POST",
    })
  );
  expect(userCrossActionResponse.status).toBe(403);

  const saveResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/draft`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: capabilityHeaders(saveDraftCapability),
      method: "POST",
    })
  );
  expect(saveResponse.status).toBe(202);
  const saveBody = (await saveResponse.json()) as {
    operationCapability?: string;
    operationId?: string;
  };
  if (!saveBody.operationCapability || !saveBody.operationId) {
    throw new Error("The draft operation was not created");
  }
  const saveOperation = await waitForOperation(saveBody.operationId, {
    "X-Editor-Capability": saveBody.operationCapability,
  });
  expect(saveOperation.status).toBe("completed");

  const submitResponse = await app.handle(
    new Request(`http://test.local/api/forms/${formRecord.publicId}/submit`, {
      body: JSON.stringify({
        data: {},
        documentKey: responseDocumentKey,
        responseId,
      }),
      headers: capabilityHeaders(submitCapability),
      method: "POST",
    })
  );
  expect(submitResponse.status).toBe(202);
  const submitBody = (await submitResponse.json()) as {
    operationCapability?: string;
    operationId?: string;
    submissionId?: string;
  };
  const completedSubmissionId = submitBody.submissionId;
  if (
    !submitBody.operationCapability ||
    !submitBody.operationId ||
    !completedSubmissionId
  ) {
    throw new Error("The submit operation was not created");
  }
  const submitOperation = await waitForOperation(submitBody.operationId, {
    "X-Editor-Capability": submitBody.operationCapability,
  });
  expect(submitOperation.status).toBe("completed");
  const crossOperationPollResponse = await app.handle(
    new Request(`http://test.local/api/operations/${submitBody.operationId}`, {
      headers: {
        "X-Editor-Capability": saveBody.operationCapability,
      },
    })
  );
  expect(crossOperationPollResponse.status).toBe(403);
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
  const staleOperationCapability = createEditorCapability({
    action: "poll-operation",
    actorId: adminId,
    documentKey: templateDraft.documentKey,
    formId,
    operationId: staleOperationId,
    role: "admin",
    targetId: templateDraft.id,
    targetType: "template-draft",
  });
  const expiredOperationResponse = await app.handle(
    new Request(`http://test.local/api/operations/${staleOperationId}`, {
      headers: { "X-Editor-Capability": staleOperationCapability },
    })
  );
  expect(expiredOperationResponse.status).toBe(200);
  expect(await expiredOperationResponse.json()).toMatchObject({
    operation: { id: staleOperationId, status: "failed" },
  });
  expect(await objectExists(staleStagingObjectKey)).toBe(false);
  expect(await objectExists(staleFinalObjectKey)).toBe(false);
  expect(await objectExists(templateDraft.objectKey)).toBe(true);
  const callbackDocument = new TextEncoder().encode("callback-docx");
  const callbackDownloadPaths = new Set<string>();
  const callbackDocumentServer = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (
        !verifyOnlyOfficeAuthorization(request.headers.get("authorization"), {
          url: request.url,
        })
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      callbackDownloadPaths.add(url.pathname);
      if (url.pathname === "/redirect.docx") {
        return new Response(null, {
          headers: { Location: `${url.origin}/ok.docx` },
          status: 302,
        });
      }
      if (url.pathname === "/large.docx") {
        return new Response(new Uint8Array(17));
      }
      return new Response(callbackDocument, {
        headers: { "Content-Type": DOCX_CONTENT_TYPE },
      });
    },
    port: 0,
  });
  try {
    const callbackOrigin = callbackDocumentServer.url.origin;
    const callbackApp = createApp({
      onlyOffice: {
        convertDocxToPdf: () =>
          Promise.resolve(new TextEncoder().encode("%PDF-test")),
        forceSave: () => Promise.resolve(false),
      },
      onlyOfficeCallbackMaxBytes: 16,
      onlyOfficeCallbackOrigins: [callbackOrigin],
    });
    const createCallbackOperation =
      async (): Promise<CallbackOperationFixture> => {
        const id = crypto.randomUUID();
        const stagedObjectKey = objectKey(
          "operations",
          id,
          "callback-staged.docx"
        );
        const finalObjectKey = objectKey(
          "operations",
          id,
          "callback-final.docx"
        );
        await prisma.operation.create({
          data: {
            actorId: adminId,
            documentKey: templateDraft.documentKey,
            errorCode: null,
            formId,
            id,
            metadata: {
              action: "save-template",
              finalObjectKey,
              formId,
              stagedObjectKey,
            },
            ownerUserId: adminId,
            stagingObjectKey: stagedObjectKey,
            status: "processing",
            targetId: id,
            targetType: "template_draft",
            type: "save_template_draft",
          },
        });
        return {
          documentKey: templateDraft.documentKey,
          finalObjectKey,
          id,
          userdata: createCallbackUserdata({
            documentKey: templateDraft.documentKey,
            operationId: id,
            operationType: "save_template_draft",
          }),
        };
      };
    const postCallback = (
      payload: Record<string, unknown>,
      authorization = createOnlyOfficeAuthorization(payload),
      bodyToken = createOnlyOfficeBodyToken(payload)
    ): Promise<Response> =>
      callbackApp.handle(
        new Request("http://test.local/onlyoffice/callback", {
          body: JSON.stringify({ ...payload, token: bodyToken }),
          headers: {
            Authorization: authorization,
            ...jsonHeaders,
          },
          method: "POST",
        })
      );

    const trustOperation = await createCallbackOperation();
    const trustedPayload = callbackPayload(
      trustOperation,
      `${callbackOrigin}/ok.docx`
    );
    const invalidJwtResponse = await postCallback(
      trustedPayload,
      tamperAuthorization(createOnlyOfficeAuthorization(trustedPayload))
    );
    expect(invalidJwtResponse.status).toBe(401);
    const invalidBodyTokenResponse = await postCallback(
      trustedPayload,
      createOnlyOfficeAuthorization(trustedPayload),
      `${createOnlyOfficeBodyToken(trustedPayload)}x`
    );
    expect(invalidBodyTokenResponse.status).toBe(401);
    const ordinaryCallbackResponse = await postCallback({
      actions: [],
      key: trustOperation.documentKey,
      status: 1,
    });
    expect(await ordinaryCallbackResponse.json()).toEqual({ error: 0 });
    const browserSessionBoundaryResponse = await postCallback(
      trustedPayload,
      `Bearer ${publishCapability}`
    );
    expect(browserSessionBoundaryResponse.status).toBe(401);

    const wrongKeyPayload = {
      ...trustedPayload,
      key: `wrong-${trustOperation.documentKey}`,
    };
    const wrongKeyResponse = await postCallback(wrongKeyPayload);
    expect(await wrongKeyResponse.json()).toEqual({ error: 1 });
    const wrongOperationPayload = {
      ...trustedPayload,
      userdata: createCallbackUserdata({
        documentKey: trustOperation.documentKey,
        operationId: crypto.randomUUID(),
        operationType: "save_template_draft",
      }),
    };
    const wrongOperationResponse = await postCallback(wrongOperationPayload);
    expect(await wrongOperationResponse.json()).toEqual({ error: 1 });
    const wrongOperationTypePayload = {
      ...trustedPayload,
      userdata: createCallbackUserdata({
        documentKey: trustOperation.documentKey,
        operationId: trustOperation.id,
        operationType: "submit_response",
      }),
    };
    const wrongOperationTypeResponse = await postCallback(
      wrongOperationTypePayload
    );
    expect(await wrongOperationTypeResponse.json()).toEqual({ error: 1 });
    const expiredCallbackPayload = {
      ...trustedPayload,
      userdata: createCallbackUserdata({
        documentKey: trustOperation.documentKey,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
        operationId: trustOperation.id,
        operationType: "save_template_draft",
      }),
    };
    const expiredCallbackResponse = await postCallback(expiredCallbackPayload);
    expect(await expiredCallbackResponse.json()).toEqual({ error: 1 });
    expect(
      await prisma.operation.findUnique({
        select: { status: true },
        where: { id: trustOperation.id },
      })
    ).toEqual({ status: "processing" });

    const oversizedCallbackPayload = {
      padding: "x".repeat(65 * 1024),
      status: 6,
    };
    const oversizedCallbackResponse = await postCallback(
      oversizedCallbackPayload
    );
    expect(oversizedCallbackResponse.status).toBe(413);

    const forbiddenOriginOperation = await createCallbackOperation();
    const forbiddenOriginResponse = await postCallback(
      callbackPayload(
        forbiddenOriginOperation,
        "https://attacker.example/document.docx"
      )
    );
    expect(await forbiddenOriginResponse.json()).toEqual({ error: 0 });
    expect(
      await prisma.operation.findUnique({
        select: { status: true },
        where: { id: forbiddenOriginOperation.id },
      })
    ).toEqual({ status: "failed" });

    const redirectOperation = await createCallbackOperation();
    const redirectResponse = await postCallback(
      callbackPayload(redirectOperation, `${callbackOrigin}/redirect.docx`)
    );
    expect(await redirectResponse.json()).toEqual({ error: 1 });
    expect(
      await prisma.operation.findUnique({
        select: { status: true },
        where: { id: redirectOperation.id },
      })
    ).toEqual({ status: "failed" });

    const oversizedDocumentOperation = await createCallbackOperation();
    const oversizedDocumentResponse = await postCallback(
      callbackPayload(
        oversizedDocumentOperation,
        `${callbackOrigin}/large.docx`
      )
    );
    expect(await oversizedDocumentResponse.json()).toEqual({ error: 1 });
    expect(
      await prisma.operation.findUnique({
        select: { status: true },
        where: { id: oversizedDocumentOperation.id },
      })
    ).toEqual({ status: "failed" });

    const validCallbackResponse = await postCallback(trustedPayload);
    expect(await validCallbackResponse.json()).toEqual({ error: 0 });
    expect(
      await prisma.operation.findUnique({
        select: { status: true },
        where: { id: trustOperation.id },
      })
    ).toEqual({ status: "completed" });
    expect(await readObject(trustOperation.finalObjectKey)).toEqual(
      callbackDocument
    );
    expect(callbackDownloadPaths).toEqual(
      new Set(["/large.docx", "/ok.docx", "/redirect.docx"])
    );
  } finally {
    callbackDocumentServer.stop(true);
  }

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
