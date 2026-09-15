// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { FileJson, FileText, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Button, Card, Notice, Spinner } from "@/components/ui";
import { ApiError, apiGet, downloadArtifact, formatDate } from "@/lib/api";
import type { AdminResultDetail } from "@/lib/api";

const AdminResultDetailRoute = () => {
  const { responseId } = useParams({ from: "/admin/results/$responseId/" });
  const [result, setResult] = useState<AdminResultDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loadResult = async () => {
      try {
        const payload = await apiGet<{ result: AdminResultDetail }>(
          `/api/admin/results/${responseId}`
        );
        if (!cancelled) {
          setResult(payload.result);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof ApiError && caughtError.status === 403
              ? "คุณไม่มีสิทธิ์ดูผลลัพธ์นี้"
              : "ไม่สามารถโหลดรายละเอียดได้ กรุณาลองใหม่อีกครั้ง"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void loadResult();
    return () => {
      cancelled = true;
    };
  }, [responseId]);

  const download = async (format: "json" | "docx" | "pdf") => {
    if (!result?.submissionId || downloading) {
      return;
    }
    setDownloading(format);
    setDownloadError(null);
    try {
      await downloadArtifact(
        `/api/submissions/${result.submissionId}/${format}`,
        `submission-${result.submissionId}.${format}`
      );
    } catch {
      setDownloadError("ส่งออกไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setDownloading(null);
    }
  };

  if (loading) {
    return <Spinner />;
  }
  if (error || !result) {
    return (
      <Notice tone="danger">
        <strong>เปิดผลลัพธ์ไม่สำเร็จ</strong>
        <div>{error ?? "ไม่พบผลลัพธ์นี้"}</div>
      </Notice>
    );
  }
  const isSubmitted = result.state === "submitted";
  const isDraft = !isSubmitted;
  return (
    <div className="space-y-6">
      <PageHeader
        title={result.formTitle}
        description={`${result.userEmail} · ${result.formPublicId}`}
        action={
          <Link to="/admin/results" search={{ form: undefined }}>
            <Button variant="secondary">กลับไปรายการ</Button>
          </Link>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={isSubmitted ? "success" : "warning"}>
            {isSubmitted ? "ส่งแล้ว" : "ฉบับร่าง"}
          </Badge>
          <Badge tone="neutral">
            <LockKeyhole className="mr-1 inline" size={14} />
            อ่านอย่างเดียว
          </Badge>
          <span className="text-sm text-[var(--ink-soft)]">
            อัปเดต {formatDate(result.updatedAt)} · Correction{" "}
            {result.latestCorrectionNumber ?? "—"}
          </span>
        </div>
        {isDraft ? (
          <Notice>
            <strong>ฉบับร่างอ่านได้อย่างเดียว</strong>
            <div>
              Admin ไม่สามารถแก้ไข ยึด Lease หรือส่งออกฉบับร่างจาก workflow นี้ได้
            </div>
          </Notice>
        ) : (
          <div className="mt-5 flex flex-wrap gap-2" aria-label="ส่งออกคำตอบ">
            <Button
              disabled={downloading !== null}
              onClick={() => download("json")}
              variant="secondary"
            >
              <FileJson size={16} />
              JSON เดิม
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("docx")}
              variant="secondary"
            >
              <FileText size={16} />
              DOCX เดิม
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("pdf")}
              variant="secondary"
            >
              <FileText size={16} />
              PDF ตามคำขอ
            </Button>
          </div>
        )}
        {downloadError ? (
          <Notice tone="danger">
            <strong>ส่งออกไม่สำเร็จ</strong>
            <div>{downloadError}</div>
          </Notice>
        ) : null}
      </Card>
      <Card>
        <h2 className="font-semibold">ข้อมูลคำตอบ</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          {isSubmitted ? "ข้อมูลต้นฉบับของ Submission" : "ข้อมูล Draft ปัจจุบัน"}
        </p>
        <pre className="mt-4 max-h-[560px] overflow-auto rounded-[10px] bg-[#eef1ed] p-4 text-sm leading-6 text-[var(--ink-soft)]">
          {JSON.stringify(result.data, null, 2)}
        </pre>
      </Card>
    </div>
  );
};

export const Route = createFileRoute("/admin/results/$responseId/")({
  component: AdminResultDetailRoute,
});
