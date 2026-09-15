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
import type { EditorBridgeMessage } from "@/components/onlyoffice-editor";
import { Button, Notice, Spinner } from "@/components/ui";
import { ApiError, apiGet, apiPost, safeReturnPath } from "@/lib/api";
import type { Operation } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const formRequestError = (error: unknown, fallback: string) => {
  if (error instanceof ApiError && error.status === 401) {
    return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
  }
  return fallback;
};

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
      setOperationError(
        message.error ?? "การดำเนินการกับเอกสารไม่สำเร็จ กรุณาลองใหม่"
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
        ? "บันทึกฉบับร่างคำตอบแล้ว"
        : "ดำเนินการกับเอกสารเรียบร้อยแล้ว"
    );
  };

  const fillPath = safeReturnPath(`/forms/${publicId}/fill`);

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
  const handleExit = async () => {
    await navigate({ to: "/dashboard" });
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      <header className="border-b border-[var(--line)] bg-[var(--paper)]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-4 lg:px-8">
          <Button variant="ghost" size="sm" onClick={handleExit}>
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
        <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--muted)] shadow-inner">
          <OnlyOfficeEditor
            configUrl={editorConfigUrl ?? undefined}
            onBridgeMessage={handleBridgeMessage}
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
