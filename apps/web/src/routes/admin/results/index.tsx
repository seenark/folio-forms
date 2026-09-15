// oxlint-disable no-nested-ternary -- Keeps the three explicit loading, empty, and populated table states local to the route.
import { Link, createFileRoute, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Badge, Button, Card, Input, Notice, Spinner } from "@/components/ui";
import { ApiError, apiGet, formatDate } from "@/lib/api";
import type {
  AdminResult,
  AdminResultListResponse,
  AdminResultState,
} from "@/lib/api";

const selectClass =
  "min-h-11 w-full rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-[var(--ink)] shadow-sm focus:border-[var(--ink)] focus:outline-none";

const errorMessage = (error: unknown) => {
  if (error instanceof ApiError && error.status === 403) {
    return "คุณไม่มีสิทธิ์ดูผลลัพธ์ของระบบ";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
  }
  return "ไม่สามารถโหลดผลลัพธ์ได้ กรุณาลองใหม่อีกครั้ง";
};

const stateLabel = (state: AdminResultState) =>
  state === "submitted" ? "ส่งแล้ว" : "ฉบับร่าง";

const AdminResultsRoute = () => {
  const { form: preselectedForm } = useSearch({ from: "/admin/results" });
  const initialForm = preselectedForm ?? "";
  const [results, setResults] = useState<AdminResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [formFilter, setFormFilter] = useState(initialForm);
  const [userFilter, setUserFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<AdminResultState | "all">(
    "all"
  );
  const [correctionFilter, setCorrectionFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [draftFilters, setDraftFilters] = useState({
    correction: "",
    form: initialForm,
    from: "",
    state: "all" as AdminResultState | "all",
    to: "",
    user: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadResults = async () => {
      setLoading(true);
      setError(null);
      const query = new URLSearchParams();
      if (currentCursor) {
        query.set("cursor", currentCursor);
      }
      if (formFilter.trim()) {
        query.set("form", formFilter.trim());
      }
      if (userFilter.trim()) {
        query.set("user", userFilter.trim());
      }
      if (stateFilter !== "all") {
        query.set("state", stateFilter);
      }
      if (correctionFilter.trim()) {
        query.set("correction", correctionFilter.trim());
      }
      if (fromFilter) {
        query.set("from", fromFilter);
      }
      if (toFilter) {
        query.set("to", `${toFilter}T23:59:59.999Z`);
      }
      try {
        const payload = await apiGet<AdminResultListResponse>(
          `/api/admin/results?${query.toString()}`
        );
        if (!cancelled) {
          setNextCursor(payload.nextCursor);
          setResults(payload.results);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(errorMessage(caughtError));
          setResults([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void loadResults();
    return () => {
      cancelled = true;
    };
  }, [
    correctionFilter,
    currentCursor,
    formFilter,
    fromFilter,
    reloadVersion,
    stateFilter,
    toFilter,
    userFilter,
  ]);

  const applyFilters = () => {
    setFormFilter(draftFilters.form);
    setUserFilter(draftFilters.user);
    setStateFilter(draftFilters.state);
    setCorrectionFilter(draftFilters.correction);
    setFromFilter(draftFilters.from);
    setToFilter(draftFilters.to);
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
        title="ตรวจทานคำตอบ"
        description="เปิดดูฉบับร่างและคำตอบที่ส่งแล้วแบบอ่านอย่างเดียว"
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
            Form Public ID
            <Input
              aria-label="Form Public ID"
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
                  form: event.target.value,
                }))
              }
              value={draftFilters.form}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            อีเมลผู้ใช้
            <Input
              aria-label="อีเมลผู้ใช้"
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
                  user: event.target.value,
                }))
              }
              value={draftFilters.user}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            สถานะ
            <select
              className={selectClass}
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
                  state: event.target.value as AdminResultState | "all",
                }))
              }
              value={draftFilters.state}
            >
              <option value="all">ทั้งหมด</option>
              <option value="draft">ฉบับร่าง</option>
              <option value="submitted">ส่งแล้ว</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            Correction ล่าสุด
            <Input
              aria-label="Correction ล่าสุด"
              max="10000"
              min="0"
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
                  correction: event.target.value,
                }))
              }
              step="1"
              type="number"
              value={draftFilters.correction}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ink-soft)]">
            ตั้งแต่
            <Input
              aria-label="ตั้งแต่"
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
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
                setDraftFilters((filters) => ({
                  ...filters,
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
              โหลดใหม่
            </Button>
          </div>
        </form>
      </Card>

      {error ? (
        <Notice tone="danger">
          <div className="flex flex-wrap items-center gap-3">
            <strong>โหลดผลลัพธ์ไม่สำเร็จ</strong>
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
          <h2 className="font-semibold">รายการคำตอบ</h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            เปิดรายละเอียดเพื่ออ่านข้อมูลและส่งออกเฉพาะคำตอบที่ส่งแล้ว
          </p>
        </div>
        {loading ? (
          <div
            className="flex min-h-48 items-center justify-center"
            aria-label="กำลังโหลดผลลัพธ์"
          >
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <div className="p-8 text-center text-[var(--ink-soft)]">
            ไม่พบผลลัพธ์ตามตัวกรอง
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-sm">
              <caption className="sr-only">รายการฉบับร่างและคำตอบที่ส่งแล้ว</caption>
              <thead className="border-b border-[var(--line)] bg-[var(--paper-soft)] text-xs uppercase tracking-[0.12em] text-[var(--ink-soft)]">
                <tr>
                  <th className="px-5 py-3" scope="col">
                    แบบฟอร์ม
                  </th>
                  <th className="px-5 py-3" scope="col">
                    ผู้ใช้
                  </th>
                  <th className="px-5 py-3" scope="col">
                    สถานะ
                  </th>
                  <th className="px-5 py-3" scope="col">
                    แก้ไขล่าสุด
                  </th>
                  <th className="px-5 py-3" scope="col">
                    Correction
                  </th>
                  <th className="px-5 py-3" scope="col">
                    <span className="sr-only">เปิด</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr
                    className="border-b border-[var(--line)] last:border-0"
                    key={result.id}
                  >
                    <td className="px-5 py-4">
                      <div className="font-semibold">{result.formTitle}</div>
                      <div className="mt-1 font-mono text-xs text-[var(--ink-soft)]">
                        {result.formPublicId}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-[var(--ink-soft)]">
                      {result.userEmail}
                    </td>
                    <td className="px-5 py-4">
                      <Badge
                        tone={
                          result.state === "submitted" ? "success" : "warning"
                        }
                      >
                        {stateLabel(result.state)}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-[var(--ink-soft)]">
                      {formatDate(result.updatedAt)}
                    </td>
                    <td className="px-5 py-4 text-[var(--ink-soft)]">
                      {result.latestCorrectionNumber ?? "—"}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Link
                        className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline"
                        params={{ responseId: result.id }}
                        to="/admin/results/$responseId"
                        search={{ form: undefined }}
                      >
                        เปิดอ่าน
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-4">
          <span className="text-sm text-[var(--ink-soft)]" aria-live="polite">
            {loading ? "กำลังโหลด…" : `พบ ${results.length} รายการในหน้านี้`}
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

export const Route = createFileRoute("/admin/results/")({
  component: AdminResultsRoute,
});
