// oxlint-disable unicorn/filename-case -- TanStack Router requires this dynamic route filename.
import { createFileRoute, Outlet } from "@tanstack/react-router";

const FormLayout = () => <Outlet />;

export const Route = createFileRoute("/admin/forms/$formId")({
  component: FormLayout,
});
