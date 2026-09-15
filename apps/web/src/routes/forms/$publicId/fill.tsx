// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import {
  createFileRoute,
  Navigate,
  useBlocker,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { OnlyOfficeEditor } from "@/components/onlyoffice-editor";
import type { EditorBridgeMessage } from "@/components/onlyoffice-editor";
import { Button, Notice, Spinner } from "@/components/ui";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  downloadArtifact,
  safeReturnPath,
} from "@/lib/api";
import type { Operation } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  createDeferred,
  isSaveFlowBusy,
  saveThenDownload,
  shouldBlockDirtyNavigation,
} from "@/lib/form-lifecycle";

const formRequestError = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
    }
    if (error.code === "form_unavailable") {
      return "แบบฟอร์มนี้เก็บถาวรแล้วและยังไม่รับคำตอบใหม่";
    }
  }
  return fallback;
};
type ExitIntent = "dashboard" | "navigation" | "reauth";

interface ReauthenticationRequest {
  handled: boolean;
  resolve: (allowed: boolean) => void;
}
type ExportFormat = "docx" | "pdf";
class DraftSaveError extends Error {
  constructor() {
    super("Draft save failed");
    this.name = "DraftSaveError";
  }
}

interface PublicForm {
  title: string;
  description?: string;
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
  const [dirty, setDirty] = useState(false);
  const [exitIntent, setExitIntent] = useState<ExitIntent | null>(null);
  const [saveBeforeExit, setSaveBeforeExit] = useState(false);
  const [saveRequest, setSaveRequest] = useState(0);
  const [exportAfterSave, setExportAfterSave] = useState<ExportFormat | null>(
    null
  );
  const [clearDirtyRequest, setClearDirtyRequest] = useState(0);
  const [discardBusy, setDiscardBusy] = useState(false);
  const exportSaveResolverRef = useRef<{
    reject: (reason?: unknown) => void;
    resolve: (value: boolean | PromiseLike<boolean>) => void;
  } | null>(null);
  const reauthResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const allowNavigationRef = useRef(false);
  const navigationBlockerRef = useRef<{
    proceed: () => void;
    reset: () => void;
  } | null>(null);
  const navigationBlocker = useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: () =>
      shouldBlockDirtyNavigation(dirty, allowNavigationRef.current),
    withResolver: true,
  });
  useEffect(() => {
    if (navigationBlocker.status === "blocked") {
      navigationBlockerRef.current = navigationBlocker;
      setExitIntent("navigation");
      setSaveBeforeExit(false);
      setOperationError(null);
      return;
    }
    navigationBlockerRef.current = null;
  }, [navigationBlocker]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!user) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setForm(null);
    setEditorConfigUrl(null);
    setError(null);
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
            formRequestError(
              caughtError,
              "ไม่พบแบบฟอร์มนี้ หรือแบบฟอร์มยังไม่พร้อมใช้งาน"
            )
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
  }, [authLoading, publicId, user]);

  useEffect(() => {
    const handleReauthentication = (event: Event) => {
      const { detail } = event as CustomEvent<ReauthenticationRequest>;
      if (!detail || !dirty || !activeResponseId) {
        return;
      }
      detail.handled = true;
      reauthResolverRef.current = detail.resolve;
      setExitIntent("reauth");
      setSaveBeforeExit(false);
      setError(null);
      setOperationError(null);
    };
    window.addEventListener("folio:before-reauth", handleReauthentication);
    return () =>
      window.removeEventListener("folio:before-reauth", handleReauthentication);
  }, [activeResponseId, dirty]);
  useEffect(() => {
    if (!exitIntent) {
      return;
    }
    document.querySelector<HTMLElement>("#unsaved-cancel")?.focus();
  }, [exitIntent]);
  useEffect(() => {
    if (authLoading || !user || !form || editorConfigUrl) {
      return;
    }

    let cancelled = false;
    const startResponse = async () => {
      try {
        const result = await apiPost<{
          editorConfigUrl?: string;
          response?: { id: string };
          submissionId?: string;
        }>(`/api/forms/${publicId}/start`, {
          responseId: activeResponseId,
        });
        if (result.submissionId) {
          await navigate({
            params: { submissionId: result.submissionId },
            to: "/receipt/$submissionId",
          });
          return;
        }
        if (cancelled) {
          return;
        }
        setActiveResponseId(result.response?.id ?? activeResponseId);
        setEditorConfigUrl(result.editorConfigUrl ?? null);
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            formRequestError(caughtError, "ไม่สามารถเริ่มคำตอบนี้ได้ กรุณาลองใหม่")
          );
        }
      }
    };

    void startResponse();
    return () => {
      cancelled = true;
    };
  }, [activeResponseId, authLoading, editorConfigUrl, form, publicId, user]);

  const handleBridgeMessage = async (message: EditorBridgeMessage) => {
    if (message.type === "dirty-state") {
      setDirty(message.dirty);
      return;
    }
    if (message.type !== "operation") {
      return;
    }
    const { status } = message;
    setOperation(
      message.operationId
        ? {
            error: message.error,
            id: message.operationId,
            status,
          }
        : null
    );
    if (status === "failed") {
      if (message.action === "save-draft") {
        exportSaveResolverRef.current?.reject(new DraftSaveError());
        exportSaveResolverRef.current = null;
      }
      setSaveBeforeExit(false);
      setExportAfterSave(null);
      setOperationError(
        message.action === "save-draft"
          ? "บันทึกฉบับร่างไม่สำเร็จ กรุณาลองใหม่"
          : (message.error ?? "การดำเนินการกับเอกสารไม่สำเร็จ กรุณาลองใหม่")
      );
      setSuccess(null);
      return;
    }

    if (status !== "completed") {
      return;
    }

    setDirty(false);
    if (message.action === "submit") {
      const submissionId = message.operation?.result?.submissionId;
      if (submissionId) {
        allowNavigationRef.current = true;
        await navigate({
          params: { submissionId },
          to: "/receipt/$submissionId",
        });
        return;
      }
    }

    if (message.action === "save-draft" && exportSaveResolverRef.current) {
      const resolver = exportSaveResolverRef.current;
      exportSaveResolverRef.current = null;
      resolver.resolve(true);
      return;
    }
    setError(null);
    setOperationError(null);
    setSuccess(
      message.action === "save-draft"
        ? "บันทึกฉบับร่างคำตอบแล้ว"
        : "ดำเนินการกับเอกสารเรียบร้อยแล้ว"
    );
    if (message.action === "save-draft" && saveBeforeExit) {
      const intent = exitIntent;
      setSaveBeforeExit(false);
      if (intent === "reauth") {
        setExitIntent(null);
        reauthResolverRef.current?.(true);
        reauthResolverRef.current = null;
      } else if (intent === "dashboard") {
        allowNavigationRef.current = true;
        setExitIntent(null);
        await navigate({ to: "/dashboard" });
      } else {
        allowNavigationRef.current = true;
        navigationBlockerRef.current?.proceed();
        setExitIntent(null);
      }
    }
  };

  const fillPath = safeReturnPath(
    `/forms/${publicId}/fill${
      responseId ? `?responseId=${encodeURIComponent(responseId)}` : ""
    }`
  );

  if (authLoading || loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        search={{ returnTo: fillPath ?? undefined }}
        replace
      />
    );
  }

  if (error || !form) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16">
        <Notice tone="danger">
          {error ?? "ไม่พบแบบฟอร์มนี้ หรือแบบฟอร์มยังไม่พร้อมใช้งาน"}
        </Notice>
      </div>
    );
  }

  const operationBusy =
    operation?.status === "pending" || operation?.status === "processing";
  const saveFlowBusy = isSaveFlowBusy(
    operationBusy,
    exportAfterSave,
    saveBeforeExit
  );
  const handleExit = async () => {
    if (saveFlowBusy || discardBusy) {
      return;
    }
    if (!dirty) {
      allowNavigationRef.current = true;
      await navigate({ to: "/dashboard" });
      return;
    }
    setExitIntent("dashboard");
    setSaveBeforeExit(false);
    setOperationError(null);
  };
  const saveAndExit = () => {
    if (!activeResponseId || saveFlowBusy || discardBusy) {
      return;
    }
    setSaveBeforeExit(true);
    setOperationError(null);
    setSuccess(null);
    setSaveRequest((value) => value + 1);
  };
  const saveAndExport = (format: ExportFormat) => {
    if (
      !activeResponseId ||
      saveFlowBusy ||
      discardBusy ||
      exportSaveResolverRef.current
    ) {
      return;
    }
    const saveCompletion = createDeferred<boolean>();
    exportSaveResolverRef.current = {
      reject: saveCompletion.reject,
      resolve: saveCompletion.resolve,
    };
    setExportAfterSave(format);
    setOperationError(null);
    setSuccess(null);
    const completeExport = async () => {
      try {
        await saveThenDownload(
          () => saveCompletion.promise,
          () =>
            downloadArtifact(
              `/api/responses/${activeResponseId}/draft/${format}`,
              `response-${activeResponseId}.${format}`
            )
        );
        setExportAfterSave(null);
        setError(null);
        setOperationError(null);
        setSuccess(
          format === "docx"
            ? "บันทึกและดาวน์โหลด DOCX แล้ว"
            : "บันทึกและดาวน์โหลด PDF แล้ว"
        );
      } catch (caughtError: unknown) {
        setExportAfterSave(null);
        setOperationError(
          formRequestError(
            caughtError,
            caughtError instanceof DraftSaveError
              ? "บันทึกฉบับร่างไม่สำเร็จ กรุณาลองใหม่"
              : "ดาวน์โหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่"
          )
        );
      }
    };
    completeExport();
    setSaveRequest((value) => value + 1);
  };
  const cancelExit = () => {
    navigationBlockerRef.current?.reset();
    navigationBlockerRef.current = null;
    reauthResolverRef.current?.(false);
    reauthResolverRef.current = null;
    setSaveBeforeExit(false);
    setExitIntent(null);
  };
  const discardDraft = async () => {
    if (!activeResponseId || discardBusy || saveFlowBusy) {
      return;
    }
    setDiscardBusy(true);
    setOperationError(null);
    try {
      await apiDelete(`/api/responses/${activeResponseId}`);
      setDirty(false);
      setClearDirtyRequest((value) => value + 1);
      const intent = exitIntent;
      if (intent === "reauth") {
        reauthResolverRef.current?.(true);
        reauthResolverRef.current = null;
      } else if (intent === "dashboard") {
        allowNavigationRef.current = true;
        await navigate({ to: "/dashboard" });
      } else {
        allowNavigationRef.current = true;
        navigationBlockerRef.current?.proceed();
      }
      setExitIntent(null);
    } catch (caughtError) {
      setOperationError(
        formRequestError(caughtError, "ลบฉบับร่างไม่สำเร็จ กรุณาลองใหม่")
      );
    } finally {
      setDiscardBusy(false);
    }
  };

  const exitPrompt = exitIntent ? (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-5"
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
      >
        <h2 id="unsaved-title" className="text-lg font-semibold">
          มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก
        </h2>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          {exitIntent === "reauth"
            ? "บันทึกฉบับร่างก่อนเข้าสู่ระบบใหม่ หรือทิ้งข้อมูลที่ยังไม่ได้บันทึกอย่างถาวร"
            : "บันทึกฉบับร่างก่อนออกจากแบบฟอร์ม หรือทิ้งฉบับร่างนี้อย่างถาวร"}
        </p>
        {operationError ? (
          <div className="mt-4">
            <Notice tone="danger">{operationError}</Notice>
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            type="button"
            onClick={discardDraft}
            disabled={discardBusy || saveFlowBusy}
          >
            {discardBusy ? <Spinner /> : null}
            {discardBusy ? "กำลังลบ…" : "ทิ้งฉบับร่าง"}
          </Button>
          <Button
            type="button"
            onClick={saveAndExit}
            disabled={discardBusy || saveFlowBusy}
          >
            {saveBeforeExit ? <Spinner /> : null}
            {saveBeforeExit ? "กำลังบันทึก…" : "บันทึกแล้วออก"}
          </Button>
          <Button
            id="unsaved-cancel"
            variant="ghost"
            type="button"
            onClick={cancelExit}
            disabled={discardBusy || saveFlowBusy}
          >
            อยู่ต่อ
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      {exitPrompt}

      <header className="border-b border-[var(--line)] bg-[var(--paper)]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-4 lg:px-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExit}
            disabled={discardBusy || saveFlowBusy}
          >
            <ArrowLeft />
            ออกจากแบบฟอร์ม
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
                "กรอกข้อมูลด้านล่าง แล้วเลือกบันทึกฉบับร่างหรือส่งคำตอบจากแท็บ Form ในตัวแก้ไขเอกสาร"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
            <Monitor />
            แนะนำให้ใช้ตัวแก้ไขบนคอมพิวเตอร์
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
              {operationError} ตัวแก้ไขยังเปิดอยู่ คุณสามารถลองใหม่ได้
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
                  ? "กำลังเตรียมไฟล์…"
                  : "กำลังบันทึกคำตอบ…"}
              </span>
            </Notice>
          </div>
        ) : null}
        <div className="mb-4 rounded-[10px] border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]">
          <strong>ใช้แท็บ Form ในตัวแก้ไขเอกสาร</strong> เพื่อเลือกบันทึกฉบับร่างหรือส่งคำตอบ
          ระบบจะแสดงความคืบหน้าที่นี่
        </div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
          <div className="text-sm text-[var(--ink-soft)]">
            สถานะ: {dirty ? "มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก" : "บันทึกแล้ว"}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => saveAndExport("docx")}
              disabled={saveFlowBusy || discardBusy}
            >
              {exportAfterSave === "docx" ? <Spinner /> : null}
              บันทึกและดาวน์โหลด DOCX
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => saveAndExport("pdf")}
              disabled={saveFlowBusy || discardBusy}
            >
              {exportAfterSave === "pdf" ? <Spinner /> : null}
              บันทึกและดาวน์โหลด PDF
            </Button>
          </div>
        </div>
        <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--muted)] shadow-inner">
          <OnlyOfficeEditor
            clearDirtyRequest={clearDirtyRequest}
            configUrl={editorConfigUrl ?? undefined}
            onBridgeMessage={handleBridgeMessage}
            onDirtyChange={setDirty}
            saveRequest={saveRequest}
            title={`กรอกแบบฟอร์ม ${form.title}`}
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
