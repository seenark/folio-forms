import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FilePlus2 } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

import {
  Button,
  Card,
  Input,
  Notice,
  Spinner,
  Textarea,
} from "@/components/ui";
import { apiPost } from "@/lib/api";

const NewFormRoute = () => {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ form: { id: string } } | { id: string }>(
        "/api/admin/forms",
        { description, title }
      );
      const form = "form" in result ? result.form : result;
      await navigate({
        params: { formId: form.id },
        to: "/admin/forms/$formId",
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not create form."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl">
      <button
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-soft)] hover:text-[var(--ink)]"
        onClick={() => navigate({ to: "/admin" })}
      >
        <ArrowLeft size={15} />
        Back to forms
      </button>
      <div className="mb-7">
        <span className="mb-3 grid size-11 place-items-center rounded-[10px] bg-[var(--accent-soft)]">
          <FilePlus2 size={20} />
        </span>
        <h1 className="text-3xl font-bold tracking-[-0.04em]">Create a form</h1>
        <p className="mt-2 text-[var(--ink-soft)]">
          Start with a clear purpose. You can shape the document in the editor
          next.
        </p>
      </div>
      <Card className="p-6 sm:p-8">
        {error ? (
          <div className="mb-5">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <form className="space-y-5" onSubmit={submit}>
          <label className="block text-sm font-semibold">
            Title
            <Input
              className="mt-2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Annual research consent"
              required
            />
          </label>
          <label className="block text-sm font-semibold">
            Description
            <span className="ml-2 font-normal text-[var(--ink-soft)]">
              Optional
            </span>
            <Textarea
              className="mt-2 min-h-28"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this form for?"
            />
          </label>
          <div className="flex justify-end border-t border-[var(--line)] pt-5">
            <Button size="lg" disabled={busy}>
              {busy ? <Spinner /> : null}
              {busy ? "Creating…" : "Create draft"}
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
