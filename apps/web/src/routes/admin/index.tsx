import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, FileText, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Button, Card, Notice, Spinner } from "@/components/ui";
import { ApiError, apiDelete, apiGet, formatDate } from "@/lib/api";
import type { FormStatus, FormSummary } from "@/lib/api";

const fetchForms = async (): Promise<FormSummary[]> => {
  const payload = await apiGet<{ forms: FormSummary[] }>("/api/admin/forms");
  return payload.forms;
};

const formStatusDetails: Record<
  FormStatus,
  { label: string; tone: "neutral" | "success" | "warning" }
> = {
  archived: { label: "เก็บถาวร", tone: "neutral" },
  draft: { label: "ร่าง", tone: "warning" },
  published: { label: "เผยแพร่แล้ว", tone: "success" },
};
const canDeleteDraft = (form: FormSummary): boolean =>
  form.status === "draft" &&
  form.version === 0 &&
  form.activeDraftCount === 0 &&
  form.submissionCount === 0;

const formsErrorMessage = (caughtError: unknown, fallback: string): string => {
  if (caughtError instanceof ApiError) {
    switch (caughtError.code) {
      case "form_has_responses": {
        return "ลบแบบฟอร์มนี้ไม่ได้ เพราะมีคำตอบที่เกี่ยวข้องแล้ว";
      }
      case "editor_in_use": {
        return "ลบไม่ได้ขณะที่ผู้ดูแลระบบรายอื่นกำลังแก้ไขแบบฟอร์มนี้";
      }
      case "form_not_draft": {
        return "ลบได้เฉพาะแบบฟอร์มร่างที่ยังไม่เผยแพร่เท่านั้น";
      }
      case "operation_in_progress": {
        return "แบบฟอร์มนี้กำลังประมวลผลอยู่ กรุณารอแล้วลองใหม่";
      }
      case "not_found": {
        return "ไม่พบแบบฟอร์มนี้ อาจถูกลบไปแล้ว";
      }
      case "unauthorized": {
        return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
      }
      case "password_change_required": {
        return "กรุณาเปลี่ยนรหัสผ่านก่อนจัดการแบบฟอร์ม";
      }
      default: {
        break;
      }
    }
  }
  return fallback;
};

const AdminFormsRoute = () => {
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [removingPublicId, setRemovingPublicId] = useState<string | null>(null);
  const [confirmingPublicId, setConfirmingPublicId] = useState<string | null>(
    null
  );
  const restoreFocusId = useRef<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMutationError(null);
    setSuccess(null);
    try {
      setForms(await fetchForms());
    } catch (caughtError) {
      setError(
        formsErrorMessage(
          caughtError,
          "ไม่สามารถโหลดรายการแบบฟอร์มได้ กรุณาลองใหม่อีกครั้ง"
        )
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (error || mutationError || success) {
      feedbackRef.current?.focus();
    }
  }, [error, mutationError, success]);

  useEffect(() => {
    if (confirmingPublicId) {
      document
        .querySelector<HTMLButtonElement>(
          `button[data-confirm-form-id="${confirmingPublicId}"]`
        )
        ?.focus();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !removingPublicId) {
          restoreFocusId.current = confirmingPublicId;
          setConfirmingPublicId(null);
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }

    const publicId = restoreFocusId.current;
    if (publicId) {
      document
        .querySelector<HTMLButtonElement>(
          `button[data-remove-form-id="${publicId}"]`
        )
        ?.focus();
      restoreFocusId.current = null;
    }
  }, [confirmingPublicId, removingPublicId]);

  const removeDraft = async (form: FormSummary) => {
    if (!canDeleteDraft(form) || removingPublicId) {
      return;
    }
    setRemovingPublicId(form.publicId);
    setMutationError(null);
    setSuccess(null);
    try {
      await apiDelete<{ deleted: boolean }>(
        `/api/admin/forms/${form.publicId}`
      );
      setForms((currentForms) =>
        currentForms.filter(
          (currentForm) => currentForm.publicId !== form.publicId
        )
      );
      setSuccess("ลบแบบฟอร์มร่างเรียบร้อยแล้ว");
    } catch (caughtError) {
      setMutationError(
        formsErrorMessage(caughtError, "ไม่สามารถลบแบบฟอร์มนี้ได้ กรุณาลองใหม่อีกครั้ง")
      );
    } finally {
      restoreFocusId.current = form.publicId;
      setRemovingPublicId(null);
      setConfirmingPublicId(null);
    }
  };

  let formsContent: React.ReactNode;
  if (error) {
    formsContent = (
      <div ref={feedbackRef} className="space-y-4" tabIndex={-1}>
        <Notice tone="danger">{error}</Notice>
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            void load();
          }}
          disabled={loading}
        >
          <RefreshCw size={15} />
          ลองโหลดอีกครั้ง
        </Button>
      </div>
    );
  } else if (loading) {
    formsContent = (
      <div
        className="grid min-h-56 place-items-center gap-3"
        aria-busy="true"
        role="status"
      >
        <Spinner />
        <span className="text-sm text-[var(--ink-soft)]">
          กำลังโหลดรายการแบบฟอร์ม…
        </span>
      </div>
    );
  } else if (forms.length === 0) {
    formsContent = (
      <Card className="grid min-h-56 place-items-center p-8 text-center">
        <div>
          <FileText className="mx-auto mb-3 text-[var(--ink-soft)]" size={30} />
          <h2 className="font-semibold">ยังไม่มีแบบฟอร์ม</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            สร้างแบบร่างแรก แล้วเปิดตัวแก้ไขเพื่อจัดรูปแบบ
          </p>
          <Link
            to="/admin/forms/new"
            className="mt-4 inline-block text-sm font-semibold text-[var(--success)] underline underline-offset-4"
          >
            สร้างแบบฟอร์ม
          </Link>
        </div>
      </Card>
    );
  } else {
    formsContent = (
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)]">
        <div className="divide-y divide-[var(--line)]">
          {forms.map((form) => {
            const status = formStatusDetails[form.status];
            const isConfirming = confirmingPublicId === form.publicId;
            const isRemoving = removingPublicId === form.publicId;
            const isDeletable = canDeleteDraft(form);
            return (
              <div
                key={form.publicId}
                className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-4">
                  <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--accent-soft)]">
                    <FileText size={18} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-semibold">{form.title}</h2>
                    <p className="mt-1 max-w-xl break-words text-sm text-[var(--ink-soft)]">
                      {form.description || "ยังไม่มีคำอธิบาย"}
                    </p>
                    <p className="mt-2 text-xs text-[var(--ink-soft)]">
                      แก้ไขล่าสุด {formatDate(form.updatedAt)}
                    </p>
                    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                      <div>
                        <dt className="text-[var(--ink-soft)]">
                          ฉบับร่างที่กำลังแก้ไข
                        </dt>
                        <dd className="font-semibold">
                          {form.activeDraftCount}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--ink-soft)]">คำตอบที่ส่งแล้ว</dt>
                        <dd className="font-semibold">
                          {form.submissionCount}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 pl-14 sm:pl-0">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {isDeletable && !isConfirming ? (
                    <Button
                      data-remove-form-id={form.publicId}
                      variant="danger"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setConfirmingPublicId(form.publicId);
                        setMutationError(null);
                        setSuccess(null);
                      }}
                      disabled={Boolean(removingPublicId)}
                    >
                      <Trash2 size={15} />
                      ลบแบบร่าง
                    </Button>
                  ) : null}
                  {isDeletable && isConfirming ? (
                    <div
                      className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-2"
                      aria-labelledby={`confirm-${form.publicId}`}
                      role="group"
                    >
                      <span
                        className="px-1 text-sm font-semibold"
                        id={`confirm-${form.publicId}`}
                      >
                        ลบแบบร่างนี้หรือไม่
                      </span>
                      <Button
                        data-confirm-form-id={form.publicId}
                        variant="danger"
                        size="sm"
                        type="button"
                        onClick={() => {
                          void removeDraft(form);
                        }}
                        disabled={Boolean(removingPublicId)}
                      >
                        {isRemoving ? <Spinner /> : <Trash2 size={15} />}
                        {isRemoving ? "กำลังลบ…" : "ยืนยันการลบ"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => {
                          restoreFocusId.current = form.publicId;
                          setConfirmingPublicId(null);
                        }}
                        disabled={Boolean(removingPublicId)}
                      >
                        ยกเลิก
                      </Button>
                    </div>
                  ) : null}
                  <Link
                    to="/admin/forms/$formId"
                    params={{ formId: form.publicId }}
                    className="inline-flex items-center gap-1 text-sm font-semibold"
                  >
                    เปิดแบบฟอร์ม <ArrowUpRight size={15} />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="แบบฟอร์ม"
        description="จัดทำแบบฟอร์ม เผยแพร่เมื่อพร้อม และติดตามคำตอบได้ในที่เดียว"
        action={
          <Link to="/admin/forms/new">
            <Button type="button">
              <Plus size={17} />
              สร้างแบบฟอร์ม
            </Button>
          </Link>
        }
      />
      {mutationError || success ? (
        <div ref={feedbackRef} className="mb-4 space-y-2" tabIndex={-1}>
          {mutationError ? (
            <Notice tone="danger">{mutationError}</Notice>
          ) : null}
          {success ? <Notice tone="success">{success}</Notice> : null}
        </div>
      ) : null}
      {formsContent}
      <Button
        className="mt-5"
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => {
          void load();
        }}
        disabled={
          loading || Boolean(removingPublicId) || Boolean(confirmingPublicId)
        }
        aria-busy={loading}
      >
        <RefreshCw size={14} />
        รีเฟรชรายการ
      </Button>
    </>
  );
};

export const Route = createFileRoute("/admin/")({ component: AdminFormsRoute });
