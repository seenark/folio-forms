// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, FileCheck2 } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Card, Notice, Spinner } from "@/components/ui";
import { apiGet, formatDate } from "@/lib/api";
import type { Submission } from "@/lib/api";

const SubmissionsRoute = () => {
  const { formId } = useParams({
    from: "/admin/forms/$formId/submissions",
  });
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadSubmissions = async () => {
      try {
        const payload = await apiGet<
          { submissions: Submission[] } | Submission[]
        >(`/api/admin/forms/${formId}/submissions`);
        if (!cancelled) {
          setRows(Array.isArray(payload) ? payload : payload.submissions);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load submissions."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSubmissions();
    return () => {
      cancelled = true;
    };
  }, [formId]);

  let submissionsContent: React.ReactNode;
  if (error) {
    submissionsContent = <Notice tone="danger">{error}</Notice>;
  } else if (loading) {
    submissionsContent = (
      <div className="grid min-h-56 place-items-center">
        <Spinner />
      </div>
    );
  } else if (rows.length === 0) {
    submissionsContent = (
      <Card className="grid min-h-56 place-items-center p-8 text-center">
        <div>
          <FileCheck2
            className="mx-auto mb-3 text-[var(--ink-soft)]"
            size={30}
          />
          <h2 className="font-semibold">No submissions yet</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            Published responses will appear here.
          </p>
        </div>
      </Card>
    );
  } else {
    submissionsContent = (
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)]">
        <div className="divide-y divide-[var(--line)]">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-semibold">{row.userEmail ?? "Respondent"}</p>
                <p className="mt-1 text-sm text-[var(--ink-soft)]">
                  Submitted {formatDate(row.submittedAt ?? row.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge tone="success">{row.status ?? "Submitted"}</Badge>
                <Link
                  to="/admin/forms/$formId/submissions/$submissionId"
                  params={{ formId, submissionId: row.id }}
                  className="inline-flex items-center gap-1 text-sm font-semibold"
                >
                  Inspect <ArrowUpRight size={15} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <Link
        to="/admin/forms/$formId"
        params={{ formId }}
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
      >
        <ArrowLeft size={15} />
        Back to editor
      </Link>
      <PageHeader
        title="Submissions"
        description="Every completed response for this form, with owner-protected downloads."
      />
      {submissionsContent}
    </>
  );
};

export const Route = createFileRoute("/admin/forms/$formId/submissions/")({
  component: SubmissionsRoute,
});
