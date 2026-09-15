// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { FileJson, FileText, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Button, Card, Notice, Spinner } from "@/components/ui";
import {
  ApiError,
  apiGet,
  downloadArtifact,
  formatDate,
  formatDateTime,
} from "@/lib/api";
import type { AdminResultDetail, ResponseRevisionsResponse } from "@/lib/api";

type ResponseRevision = ResponseRevisionsResponse["revisions"][number];

const CorrectionHistory = ({
  error,
  history,
  loading,
}: {
  error: string | null;
  history: ResponseRevision[];
  loading: boolean;
}) => {
  if (loading) {
    return (
      <div className="mt-4">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-4">
        <Notice tone="danger">{error}</Notice>
      </div>
    );
  }
  return (
    <ol className="mt-4 space-y-3">
      {history.map((revision) => (
        <li
          className="rounded-[10px] border border-[var(--line)] p-3 text-sm"
          key={revision.revision}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={revision.revision === 0 ? "neutral" : "warning"}>
              {revision.revision === 0
                ? "Submission เดิม"
                : `Correction ${revision.revision}`}
            </Badge>
            <span className="text-[var(--ink-soft)]">
              {formatDateTime(revision.createdAt)}
            </span>
          </div>
          {revision.reason ? (
            <p className="mt-2 text-[var(--ink-soft)]">
              เหตุผล: {revision.reason}
            </p>
          ) : null}
          {revision.actorName || revision.actorEmail ? (
            <p className="mt-1 text-[var(--ink-soft)]">
              ผู้แก้ไข: {revision.actorName ?? revision.actorEmail}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
};

const RevisionSelector = ({
  hasOriginalRevision,
  historyError,
  historyLoading,
  latestRevision,
  setViewRevision,
  viewRevision,
}: {
  hasOriginalRevision: boolean;
  historyError: string | null;
  historyLoading: boolean;
  latestRevision: number;
  setViewRevision: (revision: "original" | "latest") => void;
  viewRevision: "original" | "latest";
}) => (
  <div
    className="flex w-full flex-wrap items-center gap-2"
    aria-label="เลือกข้อมูลคำตอบ"
  >
    <span className="mr-1 text-sm font-semibold">ดูข้อมูล</span>
    <Button
      aria-pressed={viewRevision === "original"}
      disabled={historyLoading || historyError !== null || !hasOriginalRevision}
      onClick={() => setViewRevision("original")}
      variant={viewRevision === "original" ? "primary" : "secondary"}
    >
      ข้อมูลเดิม
    </Button>
    <Button
      aria-pressed={viewRevision === "latest"}
      onClick={() => setViewRevision("latest")}
      variant={viewRevision === "latest" ? "primary" : "secondary"}
    >
      ข้อมูลล่าสุด
      {latestRevision > 0 ? ` (Correction ${latestRevision})` : ""}
    </Button>
  </div>
);

const AdminResultDetailRoute = () => {
  const { responseId } = useParams({ from: "/admin/results/$responseId/" });
  const [result, setResult] = useState<AdminResultDetail | null>(null);
  const [viewRevision, setViewRevision] = useState<"original" | "latest">(
    "latest"
  );
  const [history, setHistory] = useState<
    ResponseRevisionsResponse["revisions"]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!result || result.state !== "submitted") {
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    const loadHistory = async () => {
      try {
        const payload = await apiGet<ResponseRevisionsResponse>(
          `/api/responses/${responseId}/corrections`
        );
        if (!cancelled) {
          setHistory(payload.revisions);
        }
      } catch {
        if (!cancelled) {
          setHistory([]);
          setHistoryError("โหลดประวัติ Correction ไม่สำเร็จ กรุณาลองใหม่");
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };
    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [responseId, result]);

  const download = async (
    format: "json" | "docx" | "pdf",
    revision: "original" | "latest"
  ) => {
    if (!result?.submissionId || downloading) {
      return;
    }
    setDownloading(`${format}-${revision}`);
    setDownloadError(null);
    try {
      const query = revision === "latest" ? "?revision=latest" : "";
      await downloadArtifact(
        `/api/submissions/${result.submissionId}/${format}${query}`,
        `submission-${result.submissionId}-${revision}.${format}`
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
  const latestRevision =
    history.at(-1)?.revision ?? result.latestCorrectionNumber ?? 0;
  const hasOriginalRevision = history.some(
    (revision) => revision.revision === 0
  );
  const selectedRevision = viewRevision === "latest" ? latestRevision : 0;
  const displayedData =
    history.find((revision) => revision.revision === selectedRevision)?.data ??
    result.data;
  let submittedDataLabel = "ข้อมูลต้นฉบับของ Submission";
  if (viewRevision === "latest" && latestRevision > 0) {
    submittedDataLabel = "ข้อมูลล่าสุดของ Correction";
  }
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
          <div className="mt-5 flex flex-wrap gap-2" aria-label="จัดการคำตอบ">
            <RevisionSelector
              hasOriginalRevision={hasOriginalRevision}
              historyError={historyError}
              historyLoading={historyLoading}
              latestRevision={latestRevision}
              setViewRevision={setViewRevision}
              viewRevision={viewRevision}
            />
            <Link
              search={{ form: undefined }}
              to="/admin/results/$responseId/correction"
              params={{ responseId }}
            >
              <Button variant="primary">เปิด Correction</Button>
            </Link>
            <Button
              disabled={downloading !== null}
              onClick={() => download("json", "original")}
              variant="secondary"
            >
              <FileJson size={16} />
              JSON เดิม
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("docx", "original")}
              variant="secondary"
            >
              <FileText size={16} />
              DOCX เดิม
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("pdf", "original")}
              variant="secondary"
            >
              <FileText size={16} />
              PDF เดิม
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("json", "latest")}
              variant="secondary"
            >
              <FileJson size={16} />
              JSON ล่าสุด
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("docx", "latest")}
              variant="secondary"
            >
              <FileText size={16} />
              DOCX ล่าสุด
            </Button>
            <Button
              disabled={downloading !== null}
              onClick={() => download("pdf", "latest")}
              variant="secondary"
            >
              <FileText size={16} />
              PDF ล่าสุด
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
      {isSubmitted ? (
        <Card>
          <h2 className="font-semibold">ประวัติ Correction</h2>
          <CorrectionHistory
            error={historyError}
            history={history}
            loading={historyLoading}
          />
        </Card>
      ) : null}
      <Card>
        <h2 className="font-semibold">ข้อมูลคำตอบ</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          {isSubmitted ? submittedDataLabel : "ข้อมูล Draft ปัจจุบัน"}
        </p>
        <pre className="mt-4 max-h-[560px] overflow-auto rounded-[10px] bg-[#eef1ed] p-4 text-sm leading-6 text-[var(--ink-soft)]">
          {JSON.stringify(displayedData, null, 2)}
        </pre>
      </Card>
    </div>
  );
};

export const Route = createFileRoute("/admin/results/$responseId/")({
  component: AdminResultDetailRoute,
});
