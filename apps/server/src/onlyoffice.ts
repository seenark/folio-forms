// oxlint-disable func-style -- Preserve function declaration contracts for server consumers.
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@onlyoffice/env/server";

export const pluginGuid = "asc.{E0B14962-3B9D-4E82-923E-89A93E8A1A51}";

const tokenLifetimeSeconds = 5 * 60;

type PluginAction = "template-edit" | "fill" | "draft" | "submit";

export interface EditorOptions {
  action: PluginAction;
  formId: string;
  publicId?: string;
  responseId?: string;
  operationId?: string;
  documentKey: string;
  authToken?: string;
  prefill?: {
    data: Record<string, unknown>;
    editableFields: Record<string, unknown>;
  };
}

interface ConverterResponse {
  error?: number;
  endConvert?: boolean;
  fileUrl?: string;
  url?: string;
}

function encodeTokenPayload(documentKey: string, expiresAt: number): string {
  return Buffer.from(JSON.stringify({ documentKey, expiresAt })).toString(
    "base64url"
  );
}

function signTokenPayload(payload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
}

export function createDocumentAccessToken(documentKey: string): string {
  const payload = encodeTokenPayload(
    documentKey,
    Math.floor(Date.now() / 1000) + tokenLifetimeSeconds
  );
  return `${payload}.${signTokenPayload(payload)}`;
}

export function verifyDocumentAccessToken(
  token: string,
  documentKey: string
): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expected = signTokenPayload(payload);
  const providedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("documentKey" in parsed) ||
      !("expiresAt" in parsed)
    ) {
      return false;
    }
    return (
      parsed.documentKey === documentKey &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Date.now() / 1000
    );
  } catch {
    return false;
  }
}
const callbackOperationPattern = /^[0-9a-f-]{36}$/iu;

export function createCallbackUserdata(operationId: string): string {
  const payload = Buffer.from(JSON.stringify({ operationId })).toString(
    "base64url"
  );
  return `${payload}.${signTokenPayload(payload)}`;
}

export function callbackOperationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) {
    return null;
  }
  const expected = signTokenPayload(payload);
  const providedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    );
    if (!parsed || typeof parsed !== "object" || !("operationId" in parsed)) {
      return null;
    }
    const { operationId } = parsed;
    return typeof operationId === "string" &&
      callbackOperationPattern.test(operationId)
      ? operationId
      : null;
  } catch {
    return null;
  }
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/u, "");
}

export function documentUrl(documentKey: string): string {
  const token = createDocumentAccessToken(documentKey);
  return `${trimOrigin(env.ONLYOFFICE_DOCUMENT_BASE_URL)}/onlyoffice/document/${encodeURIComponent(documentKey)}?token=${encodeURIComponent(token)}`;
}

export function editorConfig(
  options: EditorOptions,
  user: { id: string; name: string }
): Record<string, unknown> {
  const officeServerOrigin = trimOrigin(env.ONLYOFFICE_DOCUMENT_BASE_URL);
  const browserServerOrigin = trimOrigin(env.API_BASE);
  return {
    document: {
      fileType: "docx",
      key: options.documentKey,
      permissions: {
        comment: false,
        download: false,
        // Prefill uses the Office API once the document is open. The plugin
        // switches user sessions to the `forms` restriction immediately after
        // applying the server-provided values.
        edit: true,
        fillForms: options.action !== "template-edit",
        review: false,
      },
      title: `${options.action}-${options.formId}.docx`,
      url: documentUrl(options.documentKey),
    },
    documentType: "word",
    editorConfig: {
      ...(options.action === "template-edit"
        ? {}
        : {
            customization: {
              compactToolbar: true,
              hideRightMenu: true,
            },
          }),
      callbackUrl: `${officeServerOrigin}/onlyoffice/callback`,
      mode: "edit",
      plugins: {
        autostart: [pluginGuid],
        disable: ["asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}"],
        options: {
          [pluginGuid]: {
            ...options,
            apiBase: browserServerOrigin,
          },
        },
        pluginsData: [`${browserServerOrigin}/onlyoffice-plugin/config.json`],
      },
      user: {
        id: user.id,
        name: user.name,
      },
    },
    height: "100%",
    width: "100%",
  };
}

export interface OnlyOfficeClient {
  forceSave: (documentKey: string, userdata: string) => Promise<boolean>;
  convertDocxToPdf: (documentKey: string) => Promise<Uint8Array>;
}

export interface OnlyOfficeClientOptions {
  fetch?: typeof fetch;
  internalUrl?: string;
  documentBaseUrl?: string;
}

function documentUrlFor(documentKey: string, baseUrl: string): string {
  const token = createDocumentAccessToken(documentKey);
  return `${trimOrigin(baseUrl)}/onlyoffice/document/${encodeURIComponent(documentKey)}?token=${encodeURIComponent(token)}`;
}

function converterResponseError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }
  const { error } = payload;
  if (error === undefined || error === 0) {
    return null;
  }
  return `ONLYOFFICE conversion failed (${String(error)})`;
}

export function createOnlyOfficeClient(
  options: OnlyOfficeClientOptions = {}
): OnlyOfficeClient {
  const request = options.fetch ?? fetch;
  const internalUrl = options.internalUrl ?? env.ONLYOFFICE_INTERNAL_URL;
  const documentBaseUrl =
    options.documentBaseUrl ?? env.ONLYOFFICE_DOCUMENT_BASE_URL;

  return {
    async convertDocxToPdf(documentKey): Promise<Uint8Array> {
      const endpoint = `${trimOrigin(internalUrl)}/converter`;
      const response = await request(endpoint, {
        body: JSON.stringify({
          async: false,
          filetype: "docx",
          key: documentKey,
          outputtype: "pdf",
          title: `${documentKey}.docx`,
          url: documentUrlFor(documentKey, documentBaseUrl),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          `ONLYOFFICE converter returned HTTP ${response.status}`
        );
      }

      const payload = (await response.json()) as ConverterResponse;
      const conversionError = converterResponseError(payload);
      if (conversionError) {
        throw new Error(conversionError);
      }
      const outputUrl = payload.fileUrl ?? payload.url;
      if (!outputUrl) {
        throw new Error("ONLYOFFICE conversion did not return a PDF URL");
      }

      const pdfResponse = await request(outputUrl);
      if (!pdfResponse.ok) {
        throw new Error(
          `Failed to download converted PDF: HTTP ${pdfResponse.status}`
        );
      }
      return new Uint8Array(await pdfResponse.arrayBuffer());
    },

    async forceSave(documentKey, userdata): Promise<boolean> {
      const endpoint = `${trimOrigin(internalUrl)}/command?shardkey=${encodeURIComponent(documentKey)}`;
      const response = await request(endpoint, {
        body: JSON.stringify({ c: "forcesave", key: documentKey, userdata }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          `ONLYOFFICE command service returned HTTP ${response.status}`
        );
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") {
        throw new Error("ONLYOFFICE command service returned invalid JSON");
      }
      const error = "error" in payload ? payload.error : undefined;
      if (error === 4) {
        return false;
      }
      if (error !== undefined && error !== 0) {
        const message =
          "message" in payload && typeof payload.message === "string"
            ? payload.message
            : `ONLYOFFICE command failed (${String(error)})`;
        throw new Error(message);
      }
      return true;
    },
  };
}

const defaultOnlyOfficeClient = createOnlyOfficeClient();

export function forceSave(
  documentKey: string,
  userdata: string
): Promise<boolean> {
  return defaultOnlyOfficeClient.forceSave(documentKey, userdata);
}

export function convertDocxToPdf(documentKey: string): Promise<Uint8Array> {
  return defaultOnlyOfficeClient.convertDocxToPdf(documentKey);
}
