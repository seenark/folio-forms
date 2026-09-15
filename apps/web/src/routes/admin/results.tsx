import { createFileRoute, Outlet } from "@tanstack/react-router";

const ResultsLayout = () => <Outlet />;

export const Route = createFileRoute("/admin/results")({
  component: ResultsLayout,
  validateSearch: (search) => ({
    form: typeof search.form === "string" ? search.form : undefined,
  }),
});
