import { expect, test } from "bun:test";

import { safeReturnPath } from "../src/lib/api";
import {
  SESSION_WARNING_WINDOW_MS,
  isSaveFlowBusy,
  saveThenDownload,
  shouldBlockDirtyNavigation,
  shouldWarnBeforeSessionExpiry,
} from "../src/lib/form-lifecycle";

test("dirty navigation blocks until an explicit bypass", () => {
  expect(shouldBlockDirtyNavigation(false, false)).toBe(false);
  expect(shouldBlockDirtyNavigation(true, false)).toBe(true);
  expect(shouldBlockDirtyNavigation(true, true)).toBe(false);
});

test("save and export never downloads after a failed save", async () => {
  const events: string[] = [];
  await expect(
    saveThenDownload(
      () => {
        events.push("save");
        throw new Error("save failed");
      },
      () => {
        events.push("download");
      }
    )
  ).rejects.toThrow("save failed");
  expect(events).toEqual(["save"]);

  await saveThenDownload(
    () => {
      events.push("save-success");
    },
    () => {
      events.push("download-success");
    }
  );
  expect(events).toEqual(["save", "save-success", "download-success"]);
});

test("save and exit stays blocked while save and export is pending", () => {
  expect(isSaveFlowBusy(false, "docx", false)).toBe(true);
});

test("session warning has an exact five-minute window", () => {
  const now = Date.parse("2026-09-15T00:00:00.000Z");
  expect(
    shouldWarnBeforeSessionExpiry(
      new Date(now + SESSION_WARNING_WINDOW_MS).toISOString(),
      now
    )
  ).toBe(true);
  expect(
    shouldWarnBeforeSessionExpiry(
      new Date(now + SESSION_WARNING_WINDOW_MS + 1).toISOString(),
      now
    )
  ).toBe(false);
  expect(shouldWarnBeforeSessionExpiry(new Date(now).toISOString(), now)).toBe(
    false
  );
});

test("safe return paths keep only the opaque response id", () => {
  expect(safeReturnPath("/forms/public/fill?responseId=response-1")).toBe(
    "/forms/public/fill?responseId=response-1"
  );
  expect(safeReturnPath("/forms/public/fill?prefill=secret")).toBeNull();
  expect(safeReturnPath("https://attacker.example/claim")).toBeNull();
  expect(safeReturnPath("//attacker.example/claim")).toBeNull();
});
