// oxlint-disable no-nested-ternary -- Keeps explicit loading, empty, and populated states local to the audit table.
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Button, Card, Input, Notice, Spinner } from "@/components/ui";
import { ApiError, apiGet, formatDateTime } from "@/lib/api";
import type {
  AdminAuditEvent,
  AdminAuditListResponse,
  AuditOutcome,
} from "@/lib/api";

const selectClass =
  "min-h-11 w-full rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-[var(--ink)] shadow-sm focus:border-[var(--ink)] focus:outline-none";

const outcomeLabels: Record<AuditOutcome, string> = {
  failure: "ไม่สำเร็จ",
  success: "สำเร็จ",
};

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 403) {
    return "คุณไม่มีสิทธิ์ดู Audit Trail ของระบบ";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
  }
  return "ไม่สามารถโหลด Audit Trail ได้ กรุณาลองใหม่อีกครั้ง";
};

const metadataText = (event: AdminAuditEvent): string => {
  const entries = Object.entries(event.safeMetadata);
  return entries.length === 0
    ? "—"
    : entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
};

const targetText = (event: AdminAuditEvent): string =>
  `${event.targetType} / ${event.targetId ?? "ระบบ"}`;

const AdminAuditRoute = () => {
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [filters, setFilters] = useState({
    action: "",
    actor: "",
    from: "",
    outcome: "all" as AuditOutcome | "all",
    target: "",
    to: "",
  });
  const [draftFilters, setDraftFilters] = useState(filters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadEvents = async () => {
      setLoading(true);
      setError(null);
      const query = new URLSearchParams();
      if (currentCursor) {
        query.set("cursor", currentCursor);
      }
      for (const [key, value] of Object.entries(filters)) {
        if (value && value !== "all") {
          query.set(key, key === "to" ? `${value}T23:59:59.999Z` : value);
        }
      }
      try {
        const payload = await apiGet<AdminAuditListResponse>(
          `/api/admin/audit-events?${query.toString()}`
        );
        if (!cancelled) {
          setEvents(payload.events);
          setNextCursor(payload.nextCursor);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setEvents([]);
          setNextCursor(null);
          setError(errorMessage(caughtError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [currentCursor, filters, reloadVersion]);

  const applyFilters = () => {
    setFilters(draftFilters);
    setCursorHistory([]);
    setCurrentCursor(null);
  };
  const nextPage = () => {
    if (!nextCursor) {
      return;
    }
    setCursorHistory((history) => [...history, currentCursor]);
    setCurrentCursor(nextCursor);
  };
  const previousPage = () => {
    setCursorHistory((history) => {
      const previous = history.at(-1) ?? null;
      setCurrentCursor(previous);
      return history.slice(0, -1);
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        description="ตรวจสอบเหตุการณ์สำคัญของระบบแบบอ่านอย่างเดียว"
      />
      <Card>
        <form
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            Actor ID
            <Input
              aria-label="Actor ID"
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  actor: event.target.value,
                }))
              }
              value={draftFilters.actor}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            Action
            <Input
              aria-label="Action"
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  action: event.target.value,
                }))
              }
              value={draftFilters.action}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            Target ID
            <Input
              aria-label="Target ID"
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  target: event.target.value,
                }))
              }
              value={draftFilters.target}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            ผลลัพธ์
            <select
              aria-label="ผลลัพธ์"
              className={selectClass}
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  outcome: event.target.value as AuditOutcome | "all",
                }))
              }
              value={draftFilters.outcome}
            >
              <option value="all">ทั้งหมด</option>
              <option value="success">สำเร็จ</option>
              <option value="failure">ไม่สำเร็จ</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            ตั้งแต่
            <Input
              aria-label="ตั้งแต่"
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
              type="date"
              value={draftFilters.from}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            ถึง
            <Input
              aria-label="ถึง"
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  to: event.target.value,
                }))
              }
              type="date"
              value={draftFilters.to}
            />
          </label>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-6">
            <Button type="submit">
              <Search size={16} />
              ค้นหา
            </Button>
            <Button
              onClick={() => setReloadVersion((version) => version + 1)}
              type="button"
              variant="secondary"
            >
              <RefreshCw size={16} />
              โหลดใหม่
            </Button>
          </div>
        </form>
      </Card>

      {error ? (
        <Notice tone="danger">
          <div className="flex flex-wrap items-center gap-3">
            <strong>โหลด Audit Trail ไม่สำเร็จ</strong>
            <span>{error}</span>
            <Button
              onClick={() => setReloadVersion((version) => version + 1)}
              size="sm"
            >
              ลองใหม่
            </Button>
          </div>
        </Notice>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 className="font-semibold">เหตุการณ์ระบบ</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            แสดงเฉพาะข้อมูลอ้างอิงและ Metadata ที่ปลอดภัย ไม่มีค่าจากแบบฟอร์ม
          </p>
        </div>
        {loading ? (
          <div
            aria-busy="true"
            aria-label="กำลังโหลด Audit Trail"
            className="flex min-h-48 items-center justify-center"
            role="status"
          >
            <Spinner />
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-[var(--ink-soft)]">
            ไม่พบเหตุการณ์ตามตัวกรอง
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <caption className="sr-only">รายการ Audit Event ของระบบ</caption>
              <thead className="border-b border-[var(--line)] bg-[var(--paper-soft)] text-xs uppercase tracking-[0.12em] text-[var(--ink-soft)]">
                <tr>
                  <th className="px-5 py-3" scope="col">
                    เวลา
                  </th>
                  <th className="px-5 py-3" scope="col">
                    Action
                  </th>
                  <th className="px-5 py-3" scope="col">
                    Actor
                  </th>
                  <th className="px-5 py-3" scope="col">
                    Target
                  </th>
                  <th className="px-5 py-3" scope="col">
                    ผลลัพธ์
                  </th>
                  <th className="px-5 py-3" scope="col">
                    Metadata
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr
                    className="border-b border-[var(--line)] last:border-0"
                    key={event.id}
                  >
                    <td className="whitespace-nowrap px-5 py-4 text-[var(--ink-soft)]">
                      {formatDateTime(event.createdAt)}
                    </td>
                    <td className="px-5 py-4 font-semibold">{event.action}</td>
                    <td className="max-w-48 break-all px-5 py-4 font-mono text-xs text-[var(--ink-soft)]">
                      {event.actorId ?? "ระบบ"}
                    </td>
                    <td className="max-w-56 break-all px-5 py-4 font-mono text-xs text-[var(--ink-soft)]">
                      {targetText(event)}
                    </td>
                    <td className="px-5 py-4">
                      <Badge
                        tone={
                          event.outcome === "success" ? "success" : "warning"
                        }
                      >
                        {outcomeLabels[event.outcome]}
                      </Badge>
                    </td>
                    <td className="max-w-80 break-words px-5 py-4 text-xs text-[var(--ink-soft)]">
                      {metadataText(event)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-4">
          <span className="text-sm text-[var(--ink-soft)]" aria-live="polite">
            {loading ? "กำลังโหลด…" : `พบ ${events.length} รายการในหน้านี้`}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={loading || cursorHistory.length === 0}
              onClick={previousPage}
              size="sm"
              variant="secondary"
            >
              ก่อนหน้า
            </Button>
            <Button
              disabled={loading || !nextCursor}
              onClick={nextPage}
              size="sm"
              variant="secondary"
            >
              ถัดไป
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

export const Route = createFileRoute("/admin/audit")({
  component: AdminAuditRoute,
});
