// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Outlet } from "@tanstack/react-router";

const SubmissionsLayout = () => <Outlet />;

export const Route = createFileRoute("/admin/forms/$formId/submissions")({
  component: SubmissionsLayout,
});
