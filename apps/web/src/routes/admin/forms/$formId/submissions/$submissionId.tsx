// oxlint-disable unicorn(filename-case) -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Download, FileJson, FileText } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge, Card, Notice, Spinner } from "@/components/ui";
import { downloadArtifact, apiGet, formatDate } from "@/lib/api";
import type { Submission } from "@/lib/api";

const SubmissionDetailRoute = () => {
  const { formId, submissionId } = useParams({
    from: "/admin/forms/$formId/submissions/$submissionId",
  });
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadSubmission = async () => {
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
              : "Could not load submission."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSubmission();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);
  if (loading) {
    return (
      <div className="grid min-h-56 place-items-center">
        <Spinner />
      </div>
    );
  }
  const backLink = (
    <Link
      to="/admin/forms/$formId/submissions"
      params={{ formId }}
      className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
    >
      <ArrowLeft size={15} />
      Back to submissions
    </Link>
  );

  if (error) {
    return (
      <div>
        {backLink}
        <Notice tone="danger">{error}</Notice>
      </div>
    );
  }

  if (!submission) {
    return (
      <div>
        {backLink}
        <Notice tone="danger">Submission not found.</Notice>
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
    <div>
      {backLink}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="success">{submission.status ?? "Submitted"}</Badge>
            <span className="text-sm text-[var(--ink-soft)]">
              {formatDate(submission.submittedAt ?? submission.createdAt)}
            </span>
          </div>
          <h1 className="text-3xl font-bold tracking-[-0.04em]">
            Submission detail
          </h1>
          <p className="mt-2 text-[var(--ink-soft)]">
            {submission.userEmail ?? "Respondent"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={downloadDocx}
            className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-sm font-semibold hover:border-[var(--ink)]"
          >
            <FileText size={15} />
            DOCX
          </button>
          <button
            onClick={downloadPdf}
            className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-sm font-semibold hover:border-[var(--ink)]"
          >
            <Download size={15} />
            PDF
          </button>
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
          <FileJson size={17} />
          <h2 className="font-semibold">Extracted response data</h2>
        </div>
        <pre className="max-h-[560px] overflow-auto p-5 text-sm leading-6 text-[var(--ink-soft)]">
          {JSON.stringify(data ?? {}, null, 2)}
        </pre>
      </Card>
    </div>
  );
};

export const Route = createFileRoute(
  "/admin/forms/$formId/submissions/$submissionId"
)({ component: SubmissionDetailRoute });
