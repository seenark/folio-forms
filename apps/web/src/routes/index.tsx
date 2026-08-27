import { createFileRoute, Navigate } from "@tanstack/react-router";

import { useAuth } from "@/lib/auth";

const HomeRoute = () => {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-[var(--ink-soft)]">
        Loading Folio Forms…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" />;
  }
  if (user.role === "admin") {
    return <Navigate to="/admin" />;
  }
  return <Navigate to="/dashboard" />;
};

export const Route = createFileRoute("/")({ component: HomeRoute });
