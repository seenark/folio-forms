// oxlint-disable no-await-in-loop avoid-new -- Polling and delay are intentionally sequential.
export const API_ORIGIN =
  import.meta.env.VITE_API_ORIGIN ?? "http://localhost:3000";
export const SESSION_KEY = "onlyoffice.sessionToken";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
  code?: unknown;
}

export type Role = "admin" | "user";
export interface SessionUser {
  id: string;
  name?: string;
  email: string;
  role?: Role;
}
export interface Session {
  user: SessionUser;
  session?: { token?: string };
}
export interface FormSummary {
  id: string;
  publicId?: string;
  title: string;
  description?: string;
  status?: string;
  updatedAt?: string;
  publishedAt?: string;
  submissionCount?: number;
  activeDraftCount?: number;
}
export type FormDetail = FormSummary & {
  templateDocumentKey?: string;
  publishedDocumentKey?: string;
  editorUrl?: string;
  editorConfigUrl?: string;
  editorConfig?: Record<string, unknown>;
};
export interface Submission {
  id: string;
  responseId?: string;
  formId?: string;
  formPublicId?: string;
  formTitle?: string;
  userEmail?: string;
  submissionId?: string;
  status?: string;
  createdAt?: string;
  submittedAt?: string;
}
export interface Operation {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
}
export const formatDate = (value: string | Date | undefined) => {
  if (!value) {
    return "—";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
      }).format(date);
};

export const getToken = () => localStorage.getItem(SESSION_KEY);

export const setToken = (token: string) => {
  localStorage.setItem(SESSION_KEY, token);
};

export const clearToken = () => {
  localStorage.removeItem(SESSION_KEY);
};

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${API_ORIGIN}${path}`, { ...init, headers });
  const text = await response.text();
  let body: ApiErrorBody | T | string | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as ApiErrorBody | T;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const fallbackMessage = `Request failed (${response.status})`;
    const errorBody =
      body && typeof body === "object" ? (body as ApiErrorBody) : undefined;
    const {
      code: bodyCode,
      error: bodyError,
      message: bodyMessage,
    } = errorBody ?? {};
    let errorMessage = fallbackMessage;
    if (typeof bodyMessage === "string") {
      errorMessage = bodyMessage;
    } else if (typeof bodyError === "string") {
      errorMessage = bodyError;
    } else if (typeof body === "string") {
      errorMessage = body;
    }
    let code = "request_failed";
    if (typeof bodyError === "string") {
      code = bodyError;
    } else if (typeof bodyCode === "string") {
      code = bodyCode;
    }
    throw new ApiError(response.status, code, errorMessage);
  }
  return body as T;
};

export const apiGet = <T>(path: string) => request<T>(path);

export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>(path, { body: JSON.stringify(body ?? {}), method: "POST" });
export const apiDelete = <T>(path: string) =>
  request<T>(path, { method: "DELETE" });
export const downloadArtifact = async (path: string, filename: string) => {
  const token = getToken();
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      "download_failed",
      `Download failed (${response.status})`
    );
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
};

export const getSession = () => request<Session>("/api/auth/get-session");

export const signIn = async (email: string, password: string) => {
  const response = await fetch(`${API_ORIGIN}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email, password }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  let body: {
    error?: string;
    code?: string;
    message?: string;
    token?: string;
    session?: { token?: string };
    user?: SessionUser;
  } | null;
  try {
    body = (await response.json()) as {
      error?: string;
      code?: string;
      message?: string;
      token?: string;
      session?: { token?: string };
      user?: SessionUser;
    };
  } catch {
    body = null;
  }
  if (!response.ok) {
    const errorMessage =
      body?.error ?? body?.message ?? `Request failed (${response.status})`;
    const code = body?.error ?? body?.code ?? "sign_in_failed";
    throw new ApiError(response.status, code, errorMessage);
  }
  const headerToken = response.headers
    .get("set-auth-token")
    ?.replace(/^Bearer\s+/iu, "");
  const token = headerToken ?? body?.token ?? body?.session?.token;
  if (token) {
    setToken(token);
  }
  return body ?? {};
};

export const signOut = async () => {
  try {
    await apiPost("/api/auth/sign-out");
  } finally {
    clearToken();
  }
};

export const waitForOperation = async (
  operationId: string,
  onUpdate?: (operation: Operation) => void
) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const payload = await apiGet<Operation | { operation: Operation }>(
      `/api/operations/${operationId}`
    );
    const operation = "operation" in payload ? payload.operation : payload;
    onUpdate?.(operation);
    if (operation.status === "completed") {
      return operation;
    }
    if (operation.status === "failed") {
      throw new Error(
        operation.error ?? "The operation failed. Your draft is still safe."
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  throw new Error(
    "The operation is taking longer than expected. Check back shortly."
  );
};
