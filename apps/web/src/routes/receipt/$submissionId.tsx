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
import { apiGet, downloadArtifact, formatDate } from "@/lib/api";
import type { Submission } from "@/lib/api";

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
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load this receipt."
          );
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
          <Notice tone="danger">Receipt not found.</Notice>
        </div>
      </div>
    );
  }

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
            Back to my responses
          </Link>
          <span className="text-sm font-bold tracking-[-0.03em]">
            Folio Forms
          </span>
        </div>
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--line)] bg-[var(--success-soft)] p-7 sm:p-9">
            <CheckCircle2 className="mb-4 text-[var(--success)]" size={35} />
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[var(--success)]">
              Submission complete
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em]">
              Your response is safely filed.
            </h1>
            <p className="mt-2 text-[var(--ink-soft)]">
              Submitted{" "}
              {formatDate(submission.submittedAt ?? submission.createdAt)} ·{" "}
              {submission.userEmail}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 border-b border-[var(--line)] p-5">
            <button
              onClick={downloadDocx}
              className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-sm font-semibold hover:border-[var(--ink)]"
            >
              <FileText size={15} />
              Download DOCX
            </button>
            <button
              onClick={downloadPdf}
              className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--ink)] bg-[var(--ink)] px-3 text-sm font-semibold text-[var(--paper)]"
            >
              <Download size={15} />
              Download PDF
            </button>
          </div>
          <div className="p-5 sm:p-7">
            <div className="mb-4 flex items-center gap-2">
              <FileJson size={17} />
              <h2 className="font-semibold">Response data</h2>
              <Badge>Read only</Badge>
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
