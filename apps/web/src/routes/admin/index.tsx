import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, FileText, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Button, Card, Badge, Notice, Spinner } from "@/components/ui";
import { apiDelete, apiGet, formatDate } from "@/lib/api";
import type { FormSummary } from "@/lib/api";

const fetchForms = async () => {
  const payload = await apiGet<{ forms: FormSummary[] } | FormSummary[]>(
    "/api/admin/forms"
  );
  return Array.isArray(payload) ? payload : payload.forms;
};

const AdminFormsRoute = () => {
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const restoreFocusId = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setMutationError(null);
    try {
      const nextForms = await fetchForms();
      setForms(nextForms);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not load forms."
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (confirmingId) {
      document
        .querySelector<HTMLButtonElement>(
          `button[data-confirm-form-id="${CSS.escape(confirmingId)}"]`
        )
        ?.focus();
      return;
    }
    const formId = restoreFocusId.current;
    if (formId) {
      document
        .querySelector<HTMLButtonElement>(
          `button[data-remove-form-id="${CSS.escape(formId)}"]`
        )
        ?.focus();
      restoreFocusId.current = null;
    }
  }, [confirmingId]);
  const removeDraft = async (form: FormSummary) => {
    if (form.status !== "draft" || removingId) {
      return;
    }
    setRemovingId(form.id);
    setMutationError(null);
    try {
      await apiDelete<{ deleted: boolean }>(`/api/admin/forms/${form.id}`);
      setForms((currentForms) =>
        currentForms.filter((currentForm) => currentForm.id !== form.id)
      );
    } catch (caughtError) {
      setMutationError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not remove this draft form."
      );
    } finally {
      restoreFocusId.current = form.id;
      setRemovingId(null);
      setConfirmingId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadInitialForms = async () => {
      setLoading(true);
      try {
        const nextForms = await fetchForms();
        if (!cancelled) {
          setForms(nextForms);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load forms."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadInitialForms();
    return () => {
      cancelled = true;
    };
  }, []);

  let formsContent: React.ReactNode;
  if (error) {
    formsContent = <Notice tone="danger">{error}</Notice>;
  } else if (loading) {
    formsContent = (
      <div className="grid min-h-56 place-items-center">
        <Spinner />
      </div>
    );
  } else if (forms.length === 0) {
    formsContent = (
      <Card className="grid min-h-56 place-items-center p-8 text-center">
        <div>
          <FileText className="mx-auto mb-3 text-[var(--ink-soft)]" size={30} />
          <h2 className="font-semibold">Your first form starts here</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            Create a draft, then open the editor to shape it.
          </p>
          <Link
            to="/admin/forms/new"
            className="mt-4 inline-block text-sm font-semibold text-[var(--success)] underline underline-offset-4"
          >
            Create a form
          </Link>
        </div>
      </Card>
    );
  } else {
    formsContent = (
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)]">
        <div className="divide-y divide-[var(--line)]">
          {forms.map((form) => (
            <div
              key={form.id}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-4">
                <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--accent-soft)]">
                  <FileText size={18} />
                </span>
                <div>
                  <h2 className="font-semibold">{form.title}</h2>
                  <p className="mt-1 max-w-xl text-sm text-[var(--ink-soft)]">
                    {form.description || "No description yet."}
                  </p>
                  <p className="mt-2 text-xs text-[var(--ink-soft)]">
                    Updated {formatDate(form.updatedAt)} ·{" "}
                    {form.submissionCount ?? 0} submissions
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 pl-14 sm:pl-0">
                <Badge
                  tone={form.status === "published" ? "success" : "warning"}
                >
                  {form.status === "published" ? "Published" : "Draft"}
                </Badge>
                {form.status === "draft" && confirmingId !== form.id ? (
                  <Button
                    variant="danger"
                    size="sm"
                    data-remove-form-id={form.id}
                    onClick={() => {
                      setConfirmingId(form.id);
                      setMutationError(null);
                    }}
                    disabled={Boolean(removingId)}
                  >
                    <Trash2 size={15} />
                    Remove
                  </Button>
                ) : null}
                {form.status === "draft" && confirmingId === form.id ? (
                  <div
                    className="flex items-center gap-2"
                    role="alertdialog"
                    aria-label={`Remove ${form.title}`}
                  >
                    <Button
                      variant="danger"
                      size="sm"
                      data-confirm-form-id={form.id}
                      onClick={() => {
                        void removeDraft(form);
                      }}
                      disabled={Boolean(removingId)}
                    >
                      {removingId === form.id ? (
                        <Spinner />
                      ) : (
                        <Trash2 size={15} />
                      )}
                      {removingId === form.id ? "Removing…" : "Confirm remove"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        restoreFocusId.current = form.id;
                        setConfirmingId(null);
                      }}
                      disabled={Boolean(removingId)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
                <Link
                  to="/admin/forms/$formId"
                  params={{ formId: form.id }}
                  className="inline-flex items-center gap-1 text-sm font-semibold"
                >
                  Open <ArrowUpRight size={15} />
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
      <PageHeader
        title="Forms"
        description="Design once, publish intentionally, and review every response."
        action={
          <Link to="/admin/forms/new">
            <Button>
              <Plus size={17} />
              New form
            </Button>
          </Link>
        }
      />
      {mutationError ? (
        <div className="mb-4">
          <Notice tone="danger">{mutationError}</Notice>
        </div>
      ) : null}
      {formsContent}
      <button
        onClick={() => {
          void load();
        }}
        className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
      >
        <RefreshCw size={14} />
        Refresh list
      </button>
    </>
  );
};

export const Route = createFileRoute("/admin/")({ component: AdminFormsRoute });
