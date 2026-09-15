import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button, Card, Notice } from "@/components/ui";

const HANDOFF_ERROR_CODE = "handoff_unavailable" as const;
const retryHandoff = () => {
  window.location.reload();
};
const returnToSource = () => {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.assign("/");
};

const HandoffRoute = () => {
  const { error } = useSearch({ from: "/handoff" });
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedbackRef.current?.focus();
  }, []);

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--canvas)] px-5 py-12">
      <main className="w-full max-w-xl">
        <Card className="p-6 sm:p-8">
          <div ref={feedbackRef} tabIndex={-1}>
            <Notice tone="danger">
              <div className="space-y-2">
                <h1 className="font-semibold">ไม่สามารถเปิดแบบฟอร์มได้</h1>
                <p>
                  {error === HANDOFF_ERROR_CODE
                    ? "ลิงก์เปิดแบบฟอร์มหมดอายุหรือใช้ไม่ได้ กรุณากลับไปยังระบบต้นทางแล้วลองใหม่"
                    : "การเปิดแบบฟอร์มไม่พร้อมใช้งาน กรุณากลับไปยังระบบต้นทางแล้วลองใหม่"}
                </p>
              </div>
            </Notice>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={retryHandoff}>
              <RefreshCw size={16} />
              ลองใหม่
            </Button>
            <Button type="button" variant="ghost" onClick={returnToSource}>
              <ArrowLeft size={16} />
              กลับไปยังระบบต้นทาง
            </Button>
          </div>
        </Card>
      </main>
    </div>
  );
};

export const Route = createFileRoute("/handoff")({
  component: HandoffRoute,
  validateSearch: (search) => ({
    error: search.error === HANDOFF_ERROR_CODE ? HANDOFF_ERROR_CODE : undefined,
  }),
});
