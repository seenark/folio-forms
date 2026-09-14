import {
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowRight, KeyRound, LockKeyhole } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";

import { Button, Card, Input, Notice, Spinner } from "@/components/ui";
import { roleFor, useAuth } from "@/lib/auth";

const safeReturnTo = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return null;
  }
  return value;
};

const LoginRoute = () => {
  const { signIn, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnTo(
    new URLSearchParams(location.searchStr).get("returnTo")
  );
  const [email, setEmail] = useState("user-a@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) {
      return;
    }

    const redirect = async () => {
      if (returnTo) {
        await navigate({ to: returnTo });
        return;
      }
      if (roleFor(user) === "admin") {
        await navigate({ to: "/admin" });
        return;
      }
      await navigate({ to: "/dashboard" });
    };

    void redirect();
  }, [navigate, returnTo, user]);

  if (user) {
    return null;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await signIn(email, password);
      if (returnTo) {
        await navigate({ to: returnTo });
      } else if (roleFor(next) === "admin") {
        await navigate({ to: "/admin" });
      } else {
        await navigate({ to: "/dashboard" });
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Sign in failed. Check your email and password."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--ink)] px-5 py-12">
      <div className="w-full max-w-[440px] animate-rise">
        <div className="mb-8 flex items-center gap-3 text-[var(--paper)]">
          <span className="grid size-10 place-items-center rounded-[10px] bg-[var(--accent)] text-[var(--ink)]">
            <LockKeyhole size={19} />
          </span>
          <span className="text-xl font-bold tracking-[-0.03em]">
            Folio Forms
          </span>
        </div>
        <Card className="p-6 sm:p-8">
          <h1 className="text-2xl font-bold tracking-[-0.04em]">
            Sign in to continue
          </h1>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            Your secure workspace for thoughtful, traceable forms.
          </p>
          {error ? (
            <div className="mt-5">
              <Notice tone="danger">{error}</Notice>
            </div>
          ) : null}
          <form className="mt-7 space-y-5" onSubmit={submit}>
            <label className="block text-sm font-semibold">
              Email
              <Input
                className="mt-2"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="block text-sm font-semibold">
              Password
              <Input
                className="mt-2"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <Button className="w-full" size="lg" disabled={busy}>
              {busy ? <Spinner /> : <KeyRound size={17} />}
              {busy ? "Signing in…" : "Sign in"}
              <ArrowRight size={16} />
            </Button>
          </form>
        </Card>
        <p className="mt-5 text-center text-xs text-[#b8c5c5]">
          Local workspace · Sessions use opaque bearer tokens
        </p>
      </div>
    </div>
  );
};
export const Route = createFileRoute("/login")({ component: LoginRoute });
