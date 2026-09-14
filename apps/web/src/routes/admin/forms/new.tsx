import {
  createFileRoute,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft, FilePlus2, Upload } from "lucide-react";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import {
  Button,
  Card,
  Input,
  Notice,
  Spinner,
  Textarea,
} from "@/components/ui";
import { ApiError, apiPostFormData } from "@/lib/api";
import type { FormSummary } from "@/lib/api";

const maximumTemplateBytes = 25 * 1024 * 1024;
type TemplateSource = "blank" | "upload";
interface CreateFormResponse {
  form: FormSummary;
}

const createFormErrorMessage = (caughtError: unknown): string => {
  if (caughtError instanceof ApiError) {
    if (
      caughtError.status === 413 ||
      caughtError.code === "payload_too_large"
    ) {
      return "ไฟล์มีขนาดใหญ่เกิน 25 MiB";
    }
    switch (caughtError.code) {
      case "invalid_file_type": {
        return "รองรับเฉพาะไฟล์ DOCX เท่านั้น";
      }
      case "invalid_template": {
        return "ไฟล์ DOCX ไม่ถูกต้อง กรุณาตรวจสอบไฟล์แล้วลองใหม่";
      }
      case "blank_template_unavailable": {
        return "ยังไม่สามารถสร้างแบบฟอร์มเปล่าได้ กรุณาเลือกอัปโหลดไฟล์ DOCX";
      }
      case "unauthorized": {
        return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
      }
      case "password_change_required": {
        return "กรุณาเปลี่ยนรหัสผ่านก่อนสร้างแบบฟอร์ม";
      }
      default: {
        break;
      }
    }
  }
  return "สร้างแบบฟอร์มไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
};

const NewFormRoute = () => {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<TemplateSource>("blank");
  const [template, setTemplate] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  useBlocker({
    disabled: !busy,
    enableBeforeUnload: busy,
    shouldBlockFn: () => busy,
  });

  useEffect(() => {
    if (error) {
      feedbackRef.current?.focus();
    }
  }, [error]);

  const selectSource = (nextSource: TemplateSource) => {
    setSource(nextSource);
    setError(null);
    if (nextSource === "blank") {
      setTemplate(null);
    }
  };

  const selectTemplate = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > maximumTemplateBytes) {
      setTemplate(null);
      event.target.value = "";
      setError("ไฟล์มีขนาดใหญ่เกิน 25 MiB");
      return;
    }
    setTemplate(file);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("กรุณาระบุชื่อแบบฟอร์ม");
      return;
    }
    if (source === "upload" && !template) {
      setError("กรุณาเลือกไฟล์ DOCX สำหรับต้นแบบ");
      return;
    }

    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.append("title", trimmedTitle);
    formData.append("description", description.trim());
    formData.append("source", source);
    if (source === "upload" && template) {
      formData.append("template", template, template.name);
    }

    try {
      const result = await apiPostFormData<CreateFormResponse>(
        "/api/admin/forms",
        formData
      );
      const { form } = result;
      await navigate({
        ignoreBlocker: true,
        params: { formId: form.publicId },
        to: "/admin/forms/$formId",
      });
    } catch (caughtError) {
      setError(createFormErrorMessage(caughtError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <button
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
        type="button"
        disabled={busy}
        onClick={() => navigate({ to: "/admin" })}
      >
        <ArrowLeft size={15} />
        กลับไปยังรายการแบบฟอร์ม
      </button>
      <div className="mb-7">
        <span className="mb-3 grid size-11 place-items-center rounded-[10px] bg-[var(--accent-soft)]">
          <FilePlus2 size={20} />
        </span>
        <h1 className="text-3xl font-bold tracking-[-0.04em]">สร้างแบบฟอร์ม</h1>
        <p className="mt-2 text-[var(--ink-soft)]">
          เริ่มจากแบบฟอร์มเปล่าหรืออัปโหลดไฟล์ DOCX แล้วแก้ไขต่อในตัวแก้ไข
        </p>
      </div>
      <Card className="p-6 sm:p-8">
        {error ? (
          <div
            ref={feedbackRef}
            className="mb-5"
            id="new-form-error"
            tabIndex={-1}
          >
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <form className="space-y-5" aria-busy={busy} onSubmit={submit}>
          <div>
            <label className="block text-sm font-semibold" htmlFor="form-title">
              ชื่อแบบฟอร์ม
            </label>
            <Input
              id="form-title"
              className="mt-2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="เช่น แบบยินยอมเข้าร่วมงานวิจัยประจำปี"
              required
              maxLength={200}
              aria-describedby="form-title-hint"
              aria-invalid={Boolean(error && !title.trim())}
            />
            <p
              className="mt-1 text-xs text-[var(--ink-soft)]"
              id="form-title-hint"
            >
              ชื่อที่ผู้ดูแลระบบจะเห็นในรายการแบบฟอร์ม
            </p>
          </div>
          <div>
            <label
              className="block text-sm font-semibold"
              htmlFor="form-description"
            >
              คำอธิบาย{" "}
              <span className="font-normal text-[var(--ink-soft)]">
                (ไม่บังคับ)
              </span>
            </label>
            <Textarea
              id="form-description"
              className="mt-2 min-h-28"
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="แบบฟอร์มนี้ใช้สำหรับอะไร"
              aria-describedby="form-description-hint"
            />
            <p
              className="mt-1 text-xs text-[var(--ink-soft)]"
              id="form-description-hint"
            >
              คำอธิบายสั้น ๆ เพื่อช่วยให้ทีมเข้าใจวัตถุประสงค์
            </p>
          </div>
          <fieldset>
            <legend className="text-sm font-semibold">ต้นแบบเริ่มต้น</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-[10px] border p-4 ${
                  source === "blank"
                    ? "border-[var(--ink)] bg-[var(--accent-soft)]"
                    : "border-[var(--line-strong)] bg-[var(--paper)]"
                }`}
              >
                <input
                  className="mt-1 size-4 accent-[var(--ink)]"
                  type="radio"
                  name="source"
                  value="blank"
                  checked={source === "blank"}
                  disabled={busy}
                  onChange={() => selectSource("blank")}
                />
                <span>
                  <span className="block font-semibold">แบบฟอร์มเปล่า</span>
                  <span className="mt-1 block text-sm text-[var(--ink-soft)]">
                    สร้างจากต้นแบบว่างของระบบ
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-[10px] border p-4 ${
                  source === "upload"
                    ? "border-[var(--ink)] bg-[var(--accent-soft)]"
                    : "border-[var(--line-strong)] bg-[var(--paper)]"
                }`}
              >
                <input
                  className="mt-1 size-4 accent-[var(--ink)]"
                  type="radio"
                  name="source"
                  value="upload"
                  checked={source === "upload"}
                  disabled={busy}
                  onChange={() => selectSource("upload")}
                />
                <span>
                  <span className="flex items-center gap-2 font-semibold">
                    <Upload size={15} />
                    อัปโหลดไฟล์ DOCX
                  </span>
                  <span className="mt-1 block text-sm text-[var(--ink-soft)]">
                    ใช้เอกสารที่มีช่องข้อมูลอยู่แล้ว
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          {source === "upload" ? (
            <div>
              <label
                className="block text-sm font-semibold"
                htmlFor="template-file"
              >
                ไฟล์ต้นแบบ (.docx)
              </label>
              <Input
                id="template-file"
                className="mt-2 file:mr-3 file:rounded-md file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-2 file:font-semibold"
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={busy}
                required
                aria-describedby="template-file-hint"
                onChange={selectTemplate}
              />
              <p
                className="mt-1 text-xs text-[var(--ink-soft)]"
                id="template-file-hint"
              >
                รองรับไฟล์ DOCX ขนาดไม่เกิน 25 MiB
                {template ? ` · เลือกแล้ว: ${template.name}` : ""}
              </p>
            </div>
          ) : null}
          <div className="flex justify-end border-t border-[var(--line)] pt-5">
            <Button size="lg" type="submit" disabled={busy} aria-busy={busy}>
              {busy ? <Spinner /> : null}
              {busy ? "กำลังสร้างแบบฟอร์ม…" : "สร้างแบบร่าง"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};

export const Route = createFileRoute("/admin/forms/new")({
  component: NewFormRoute,
});
