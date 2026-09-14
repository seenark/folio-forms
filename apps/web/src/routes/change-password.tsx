import {
  createFileRoute,
  Navigate,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, KeyRound, LockKeyhole } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { Button, Card, Input, Notice, Spinner } from "@/components/ui";
import { safeReturnPath } from "@/lib/api";
import { authErrorMessage, useAuth } from "@/lib/auth";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const SUCCESS_REDIRECT_DELAY_MS = 900;

const ChangePasswordRoute = () => {
  const { loading: authLoading, replacePassword, user } = useAuth();
  const navigate = useNavigate();
  const { returnTo } = useSearch({ from: "/change-password" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    if (!success) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void navigate({
        replace: true,
        search: { returnTo },
        to: "/login",
      });
    }, SUCCESS_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [navigate, returnTo, success]);

  if (authLoading) {
    return (
      <div className="grid min-h-screen place-items-center gap-3 bg-[var(--ink)] text-sm text-[var(--paper)]">
        <Spinner />
        <span>กำลังตรวจสอบเซสชัน…</span>
      </div>
    );
  }

  if (success) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--ink)] px-5 py-12">
        <Card className="w-full max-w-[440px] p-6 sm:p-8">
          <Notice tone="success">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 size={18} />
              เปลี่ยนรหัสผ่านสำเร็จ กำลังกลับไปหน้าเข้าสู่ระบบ…
            </span>
          </Notice>
        </Card>
      </div>
    );
  }

  if (!user) {
    if (busy) {
      return (
        <div className="grid min-h-screen place-items-center gap-3 bg-[var(--ink)] text-sm text-[var(--paper)]">
          <Spinner />
          <span>กำลังเปลี่ยนรหัสผ่าน…</span>
        </div>
      );
    }
    return <Navigate to="/login" search={{ returnTo }} replace />;
  }

  const mandatoryChange = user.mustChangePassword;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (!currentPassword || !newPassword || !confirmation) {
      setError("กรุณากรอกข้อมูลให้ครบถ้วน");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError("รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร");
      return;
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      setError("รหัสผ่านใหม่ต้องมีไม่เกิน 128 ตัวอักษร");
      return;
    }
    if (newPassword !== confirmation) {
      setError("รหัสผ่านใหม่และการยืนยันรหัสผ่านไม่ตรงกัน");
      return;
    }

    setBusy(true);
    try {
      await replacePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSuccess(true);
    } catch (caughtError) {
      setError(authErrorMessage(caughtError, "changePassword"));
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
            {mandatoryChange ? "ตั้งรหัสผ่านใหม่" : "เปลี่ยนรหัสผ่าน"}
          </h1>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            {mandatoryChange
              ? "เพื่อความปลอดภัย กรุณาตั้งรหัสผ่านใหม่ก่อนดำเนินการต่อ"
              : "ตั้งรหัสผ่านใหม่เพื่อรักษาความปลอดภัยของบัญชี"}
          </p>
          {error ? (
            <div
              ref={errorRef}
              id="change-password-error"
              className="mt-5"
              tabIndex={-1}
            >
              <Notice tone="danger">{error}</Notice>
            </div>
          ) : null}
          <form
            className="mt-7 space-y-5"
            onSubmit={submit}
            aria-busy={busy}
            noValidate
          >
            <label
              className="block text-sm font-semibold"
              htmlFor="current-password"
            >
              รหัสผ่านปัจจุบัน
              <Input
                id="current-password"
                className="mt-2"
                type="password"
                autoComplete="current-password"
                autoFocus
                maxLength={MAX_PASSWORD_LENGTH}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                aria-describedby={error ? "change-password-error" : undefined}
                aria-invalid={error ? "true" : undefined}
                required
              />
            </label>
            <label
              className="block text-sm font-semibold"
              htmlFor="new-password"
            >
              รหัสผ่านใหม่
              <Input
                id="new-password"
                className="mt-2"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={MAX_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-describedby={error ? "change-password-error" : undefined}
                aria-invalid={error ? "true" : undefined}
                required
              />
            </label>
            <label
              className="block text-sm font-semibold"
              htmlFor="confirm-password"
            >
              ยืนยันรหัสผ่านใหม่
              <Input
                id="confirm-password"
                className="mt-2"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={MAX_PASSWORD_LENGTH}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                aria-describedby={error ? "change-password-error" : undefined}
                aria-invalid={error ? "true" : undefined}
                required
              />
            </label>
            <Button className="w-full" size="lg" type="submit" disabled={busy}>
              {busy ? <Spinner /> : <KeyRound size={17} />}
              {busy ? "กำลังเปลี่ยนรหัสผ่าน…" : "บันทึกรหัสผ่านใหม่"}
              <ArrowRight size={16} />
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
};

export const Route = createFileRoute("/change-password")({
  component: ChangePasswordRoute,
  validateSearch: (search) => ({
    returnTo: safeReturnPath(search.returnTo) ?? undefined,
  }),
});
