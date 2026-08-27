// oxlint-disable unicorn(filename-case) -- TanStack Router requires this dynamic route filename.
// oxlint-disable complexity -- Form editor coordinates loading, publishing, and editor state.
import {
  createFileRoute,
  Link,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Globe2,
  Save,
  Send,
} from "lucide-react";
import { useEffect, useState } from "react";

import { OnlyOfficeEditor } from "@/components/onlyoffice-editor";
import { Button, Notice, Spinner, Badge } from "@/components/ui";
import { apiGet, apiPost, waitForOperation } from "@/lib/api";
import type { FormDetail } from "@/lib/api";

const FormEditorRoute = () => {
  const { formId } = useParams({ from: "/admin/forms/$formId" });
  const navigate = useNavigate();
  const [form, setForm] = useState<FormDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [publishPrompt, setPublishPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadForm = async () => {
      try {
        const payload = await apiGet<
          { form: FormDetail; editorConfigUrl?: string } | FormDetail
        >(`/api/admin/forms/${formId}`);
        if (cancelled) {
          return;
        }
        if ("form" in payload) {
          setForm({
            ...payload.form,
            editorConfigUrl:
              payload.editorConfigUrl ?? payload.form.editorConfigUrl,
          });
        } else {
          setForm(payload);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load this form."
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
  }, [formId]);
  if (loading) {
    return (
      <div className="grid min-h-64 place-items-center">
        <Spinner />
      </div>
    );
  }
  const loadedForm = form;
  if (error || !loadedForm) {
    return <Notice tone="danger">{error ?? "Form not found."}</Notice>;
  }
  const publicId = loadedForm.publicId ?? loadedForm.id;
  const shareUrl = `${window.location.origin}/forms/${publicId}/fill`;
  const editorDocumentKey =
    loadedForm.templateDocumentKey ?? loadedForm.publishedDocumentKey;
  const activeDraftCount = loadedForm.activeDraftCount ?? 0;
  const perform = async (action: "save" | "publish") => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await apiPost<{ operationId?: string }>(
        `/api/admin/forms/${formId}/${action}`,
        { documentKey: editorDocumentKey }
      );
      if (result.operationId) {
        await waitForOperation(result.operationId);
      }
      const noticeMessage =
        action === "publish"
          ? "Published. New responses will use this document."
          : "Draft saved.";
      setNotice(noticeMessage);
      setForm((current) => {
        if (!current) {
          return current;
        }
        const nextForm = { ...current };
        if (action === "publish") {
          nextForm.activeDraftCount = 0;
          nextForm.status = "published";
        }
        return nextForm;
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not ${action} this form.`
      );
    } finally {
      setBusy(null);
    }
  };
  const requestAction = (action: "save" | "publish") => {
    if (action === "publish" && activeDraftCount > 0) {
      setPublishPrompt(true);
      return;
    }
    void perform(action);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <button
          className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
          onClick={() => navigate({ to: "/admin" })}
        >
          <ArrowLeft size={15} />
          Back to forms
        </button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => requestAction("save")}
            disabled={Boolean(busy)}
          >
            {busy === "save" ? <Spinner /> : <Save size={15} />}
            {busy === "save" ? "Saving…" : "Save template"}
          </Button>
          <Button
            size="sm"
            onClick={() => requestAction("publish")}
            disabled={Boolean(busy)}
          >
            {busy === "publish" ? <Spinner /> : <Send size={15} />}
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>
      {publishPrompt ? (
        <div
          className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius)] border border-[var(--warning)] bg-[var(--warning-soft)] p-4"
          role="alertdialog"
          aria-labelledby="publish-warning-title"
        >
          <div>
            <p id="publish-warning-title" className="font-semibold">
              Publishing will invalidate {activeDraftCount} saved draft
              {activeDraftCount === 1 ? "" : "s"}.
            </p>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              Submitted responses remain unchanged.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPublishPrompt(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setPublishPrompt(false);
                void perform("publish");
              }}
            >
              Publish anyway
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge tone={form.status === "published" ? "success" : "warning"}>
              {form.status === "published" ? "Published" : "Draft"}
            </Badge>
            <span className="text-sm text-[var(--ink-soft)]">Admin editor</span>
          </div>
          <h1 className="text-3xl font-bold tracking-[-0.04em]">
            {form.title}
          </h1>
          <p className="mt-2 max-w-2xl text-[var(--ink-soft)]">
            {form.description ||
              "Shape the document, then publish when it is ready."}
          </p>
        </div>
        <Link
          to="/admin/forms/$formId/submissions"
          params={{ formId }}
          className="inline-flex items-center gap-2 text-sm font-semibold underline underline-offset-4"
        >
          View submissions <ExternalLink size={15} />
        </Link>
      </div>
      {error ? (
        <div className="mb-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4">
          <Notice tone="success">{notice}</Notice>
        </div>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)] p-4">
        <div className="flex min-w-0 items-center gap-3">
          <Globe2 className="shrink-0 text-[var(--success)]" size={18} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Share this form</p>
            <p className="truncate text-xs text-[var(--ink-soft)]">
              {shareUrl}
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={copyLink}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <div className="mb-4 flex items-center gap-2 text-sm text-[var(--ink-soft)]">
        <FileText size={16} />
        Document editor <span className="text-xs">· Desktop recommended</span>
      </div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--muted)] shadow-inner">
        <OnlyOfficeEditor
          configUrl={form.editorConfigUrl ?? form.editorUrl}
          title={`Editor for ${form.title}`}
        />
      </div>
    </div>
  );
};

export const Route = createFileRoute("/admin/forms/$formId")({
  component: FormEditorRoute,
});
