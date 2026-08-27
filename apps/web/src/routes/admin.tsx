import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { Spinner } from "@/components/ui";
import { roleFor, useAuth } from "@/lib/auth";

const AdminLayout = () => {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" search={{ returnTo: "/admin" }} />;
  }
  if (roleFor(user) !== "admin") {
    return <Navigate to="/dashboard" />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
};

export const Route = createFileRoute("/admin")({ component: AdminLayout });
