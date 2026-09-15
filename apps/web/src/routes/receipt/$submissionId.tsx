// oxlint-disable unicorn(filename-case) -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileJson,
  FileText,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge, Card, Notice, Spinner } from "@/components/ui";
import { ApiError, apiGet, downloadArtifact, formatDate } from "@/lib/api";
import type { Submission } from "@/lib/api";

const receiptErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
    }
    if (error.status === 403 || error.code === "forbidden") {
      return "คุณไม่มีสิทธิ์ดูใบรับคำตอบนี้";
    }
    if (error.status === 404 || error.code === "not_found") {
      return "ไม่พบใบรับคำตอบนี้";
    }
  }
  return "โหลดใบรับคำตอบไม่ได้ กรุณาลองใหม่";
};
const ReceiptRoute = () => {
  const { submissionId } = useParams({ from: "/receipt/$submissionId" });
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadReceipt = async () => {
      try {
        const payload = await apiGet<{
          submission: Submission;
          data: Record<string, unknown>;
        }>(`/api/submissions/${submissionId}/data`);
        if (!cancelled) {
          setSubmission(payload.submission);
          setData(payload.data);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(receiptErrorMessage(caughtError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadReceipt();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-[var(--canvas)] px-5 py-12">
        <div className="mx-auto max-w-3xl">
          <Notice tone="danger">{error}</Notice>
        </div>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="min-h-screen bg-[var(--canvas)] px-5 py-12">
        <div className="mx-auto max-w-3xl">
          <Notice tone="danger">ไม่พบใบรับคำตอบนี้</Notice>
        </div>
      </div>
    );
  }

  const downloadJson = async () => {
    await downloadArtifact(
      `/api/submissions/${submissionId}/json`,
      `${submissionId}.json`
    );
  };

  const downloadDocx = async () => {
    await downloadArtifact(
      `/api/submissions/${submissionId}/docx`,
      `${submissionId}.docx`
    );
  };

  const downloadPdf = async () => {
    await downloadArtifact(
      `/api/submissions/${submissionId}/pdf`,
      `${submissionId}.pdf`
    );
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] px-5 py-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
          >
            <ArrowLeft size={15} />
            กลับไปยังคำตอบของฉัน
          </Link>
          <span className="text-sm font-bold tracking-[-0.03em]">
            Folio Forms
          </span>
        </div>
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--line)] bg-[var(--success-soft)] p-7 sm:p-9">
            <CheckCircle2 className="mb-4 text-[var(--success)]" size={35} />
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[var(--success)]">
              ส่งคำตอบเรียบร้อยแล้ว
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em]">
              ระบบบันทึกคำตอบของคุณแล้ว
            </h1>
            <p className="mt-2 text-[var(--ink-soft)]">
              {submission.formTitle ?? "แบบฟอร์ม"} · ส่งเมื่อ{" "}
              {formatDate(submission.submittedAt ?? submission.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 border-b border-[var(--line)] p-5">
            <button
              type="button"
              onClick={downloadJson}
              className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-sm font-semibold hover:border-[var(--ink)]"
            >
              <FileJson size={15} />
              ดาวน์โหลด JSON
            </button>
            <button
              type="button"
              onClick={downloadDocx}
              className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-sm font-semibold hover:border-[var(--ink)]"
            >
              <FileText size={15} />
              ดาวน์โหลด DOCX
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--ink)] bg-[var(--ink)] px-3 text-sm font-semibold text-[var(--paper)]"
            >
              <Download size={15} />
              ดาวน์โหลด PDF
            </button>
          </div>
          <div className="p-5 sm:p-7">
            <div className="mb-4 flex items-center gap-2">
              <FileJson size={17} />
              <h2 className="font-semibold">ข้อมูลคำตอบ</h2>
              <Badge>อ่านอย่างเดียว</Badge>
            </div>
            <pre className="max-h-[500px] overflow-auto rounded-[10px] bg-[#eef1ed] p-4 text-sm leading-6 text-[var(--ink-soft)]">
              {JSON.stringify(data ?? {}, null, 2)}
            </pre>
          </div>
        </Card>
      </div>
    </div>
  );
};

export const Route = createFileRoute("/receipt/$submissionId")({
  component: ReceiptRoute,
});
