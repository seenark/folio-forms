// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import {
  createFileRoute,
  Navigate,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Monitor } from "lucide-react";
import { useEffect, useState } from "react";

import { OnlyOfficeEditor } from "@/components/onlyoffice-editor";
import { Button, Notice, Spinner } from "@/components/ui";
import { apiGet, apiPost } from "@/lib/api";
import type { Operation } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface PublicForm {
  title: string;
  description?: string;
}

interface BridgeMessage {
  action?: string;
  error?: string;
  operation?: {
    result?: {
      submissionId?: string;
    };
  };
  operationId?: string;
  source?: string;
  status?: string;
  type?: string;
}

const FillRoute = () => {
  const { publicId } = useParams({ from: "/forms/$publicId/fill" });
  const { responseId } = useSearch({ from: "/forms/$publicId/fill" });
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [editorConfigUrl, setEditorConfigUrl] = useState<string | null>(null);
  const [activeResponseId, setActiveResponseId] = useState(responseId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadForm = async () => {
      try {
        const payload = await apiGet<{ form: PublicForm } | PublicForm>(
          `/api/forms/${publicId}`
        );
        if (!cancelled) {
          setForm("form" in payload ? payload.form : payload);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "This form is unavailable."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadForm();
    return () => {
      cancelled = true;
    };
  }, [publicId]);

  useEffect(() => {
    if (!user || !form || editorConfigUrl) {
      return;
    }

    let cancelled = false;
    const startResponse = async () => {
      try {
        const result = await apiPost<{
          response?: { id: string };
          editorConfigUrl?: string;
        }>(`/api/forms/${publicId}/start`, {
          responseId: activeResponseId,
        });
        if (cancelled) {
          return;
        }
        setActiveResponseId(result.response?.id ?? activeResponseId);
        setEditorConfigUrl(result.editorConfigUrl ?? null);
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not start this response."
          );
        }
      }
    };

    void startResponse();
    return () => {
      cancelled = true;
    };
  }, [activeResponseId, editorConfigUrl, form, publicId, user]);

  useEffect(() => {
    const handleBridgeMessage = async (event: MessageEvent<BridgeMessage>) => {
      const message = event.data;
      if (message?.source !== "form-bridge" || message.type !== "operation") {
        return;
      }

      const status = message.status === "failed" ? "failed" : message.status;
      if (
        message.operationId &&
        (status === "pending" || status === "completed" || status === "failed")
      ) {
        setOperation({
          error: message.error,
          id: message.operationId,
          status,
        });
      }
      if (status === "failed") {
        setOperationError(
          message.error ?? "The document operation failed. Try again."
        );
        setSuccess(null);
        return;
      }

      if (status !== "completed") {
        return;
      }

      if (message.action === "submit") {
        const submissionId = message.operation?.result?.submissionId;
        if (submissionId) {
          await navigate({
            params: { submissionId },
            to: "/receipt/$submissionId",
          });
          return;
        }
      }

      setError(null);
      setOperationError(null);
      setSuccess(
        message.action === "save-draft"
          ? "Draft saved."
          : "Template action completed."
      );
    };

    window.addEventListener("message", handleBridgeMessage);
    return () => window.removeEventListener("message", handleBridgeMessage);
  }, [navigate]);

  if (authLoading || loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate to="/login" search={{ returnTo: `/forms/${publicId}/fill` }} />
    );
  }

  if (error || !form) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16">
        <Notice tone="danger">{error ?? "This form is unavailable."}</Notice>
      </div>
    );
  }

  const operationBusy =
    operation?.status === "pending" || operation?.status === "processing";
  const handleExit = async () => {
    await navigate({ to: "/dashboard" });
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      <header className="border-b border-[var(--line)] bg-[var(--paper)]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-4 lg:px-8">
          <Button variant="ghost" size="sm" onClick={handleExit}>
            <ArrowLeft />
            Exit
          </Button>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-[var(--ink)] text-[var(--accent)]">
              F
            </span>
            Folio Forms
          </div>
          <span className="text-xs text-[var(--ink-soft)]">{user.email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-10">
        <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-bold tracking-[-0.04em]">
              {form.title}
            </h1>
            <p className="mt-2 max-w-2xl text-[var(--ink-soft)]">
              {form.description ??
                "Complete the fields below. Save or submit from the Form tab inside the document editor."}
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
            <Monitor />
            Desktop editor recommended
          </div>
        </div>
        {error ? (
          <div className="mb-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        {operationError ? (
          <div className="mb-4">
            <Notice tone="danger">
              {operationError} The editor is still open; you can retry.
            </Notice>
          </div>
        ) : null}
        {success ? (
          <div className="mb-4">
            <Notice tone="success">
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 />
                {success}
              </span>
            </Notice>
          </div>
        ) : null}
        {operationBusy ? (
          <div className="mb-4">
            <Notice>
              <span className="inline-flex items-center gap-2">
                <Spinner />
                {operation?.status === "processing"
                  ? "Preparing your files…"
                  : "Saving your response…"}
              </span>
            </Notice>
          </div>
        ) : null}
        <div className="mb-4 rounded-[10px] border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]">
          <strong>Use the Form tab inside the document editor</strong> to apply
          Save Draft or Submit. The editor reports operation progress here.
        </div>
        <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--muted)] shadow-inner">
          <OnlyOfficeEditor
            configUrl={editorConfigUrl ?? undefined}
            title={`Fill ${form.title}`}
          />
        </div>
      </main>
    </div>
  );
};
export const Route = createFileRoute("/forms/$publicId/fill")({
  component: FillRoute,
  validateSearch: (search) => ({
    responseId:
      typeof search.responseId === "string" ? search.responseId : undefined,
  }),
});
