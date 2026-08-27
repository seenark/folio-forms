import { createRootRoute, Outlet } from "@tanstack/react-router";

import { AuthProvider } from "@/lib/auth";

import "@/index.css";

const RootLayout = () => (
  <AuthProvider>
    <Outlet />
  </AuthProvider>
);

export const Route = createRootRoute({ component: RootLayout });
