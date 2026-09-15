import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { ArrowUpRight, ClipboardList, FileCheck2, Inbox } from "lucide-react";
import { useEffect, useState } from "react";

import { AppShell, PageHeader } from "@/components/app-shell";
import { Badge, Card, Notice, Spinner } from "@/components/ui";
import { apiGet, formatDate } from "@/lib/api";
import type { Submission } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const Stat = ({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) => (
  <Card className="flex items-center gap-4 p-5">
    <span className="grid size-10 place-items-center rounded-[10px] bg-[var(--accent-soft)] text-[var(--ink)]">
      {icon}
    </span>
    <div>
      <p className="text-2xl font-bold tracking-[-0.04em]">{value}</p>
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
    </div>
  </Card>
);

const Centered = ({ message }: { message: string }) => (
  <div className="grid min-h-64 place-items-center text-sm text-[var(--ink-soft)]">
    <Spinner />
    <span className="sr-only">{message}</span>
  </div>
);

const DashboardRoute = () => {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const loadResponses = async () => {
      try {
        const payload = await apiGet<
          { responses: Submission[] } | Submission[]
        >("/api/responses/me");
        if (cancelled) {
          return;
        }
        setRows(Array.isArray(payload) ? payload : payload.responses);
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load responses."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadResponses();
    return () => {
      cancelled = true;
    };
  }, [user]);
  if (authLoading) {
    return <Centered message="Checking session…" />;
  }
  if (!user) {
    return <Navigate to="/login" search={{ returnTo: "/dashboard" }} />;
  }

  let responseContent: React.ReactNode;
  if (error) {
    responseContent = <Notice tone="danger">{error}</Notice>;
  } else if (loading) {
    responseContent = <Centered message="Loading responses…" />;
  } else if (rows.length === 0) {
    responseContent = (
      <Card className="grid min-h-56 place-items-center p-8 text-center">
        <div>
          <Inbox className="mx-auto mb-3 text-[var(--ink-soft)]" size={30} />
          <h2 className="font-semibold">No responses yet</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            Open a shared form link to begin.
          </p>
        </div>
      </Card>
    );
  } else {
    responseContent = (
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)]">
        <div className="divide-y divide-[var(--line)]">
          {rows.map((row) => {
            const submitted =
              row.status === "submitted" || row.status === "completed";
            return (
              <div
                className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
                key={row.id}
              >
                <div>
                  <h2 className="font-semibold">
                    {row.formTitle ?? "Untitled form"}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">
                    Last activity {formatDate(row.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={submitted ? "success" : "warning"}>
                    {submitted ? "Submitted" : "Draft"}
                  </Badge>
                  {submitted ? (
                    <Link
                      to="/receipt/$submissionId"
                      params={{ submissionId: row.submissionId ?? row.id }}
                      className="inline-flex items-center gap-1 text-sm font-semibold underline decoration-[var(--line-strong)] underline-offset-4 hover:decoration-[var(--ink)]"
                    >
                      View receipt <ArrowUpRight size={15} />
                    </Link>
                  ) : (
                    <Link
                      to="/forms/$publicId/fill"
                      params={{
                        publicId: row.formPublicId ?? "",
                      }}
                      search={{ responseId: row.id }}
                      className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--success)]"
                    >
                      Resume <ArrowUpRight size={15} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="My responses"
        description="Pick up a saved draft or review a completed submission."
      />
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat
          label="In progress"
          value={
            rows.filter(
              (row) => row.status === "draft" || row.status === "in_progress"
            ).length
          }
          icon={<ClipboardList size={18} />}
        />
        <Stat
          label="Submitted"
          value={
            rows.filter(
              (row) => row.status === "submitted" || row.status === "completed"
            ).length
          }
          icon={<FileCheck2 size={18} />}
        />
        <Stat
          label="Total responses"
          value={rows.length}
          icon={<Inbox size={18} />}
        />
      </div>
      {responseContent}
    </AppShell>
  );
};

export const Route = createFileRoute("/dashboard")({
  component: DashboardRoute,
});
