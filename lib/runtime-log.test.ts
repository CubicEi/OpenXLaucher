import { describe, expect, it } from "vitest";

import {
  buildLogBody,
  formatLocalTimestamp,
  formatRuntimeLogLine,
} from "@/lib/runtime-log";

describe("runtime-log format", () => {
  const fixed = new Date(2026, 9, 22, 7, 49, 5);

  it("formats local timestamp", () => {
    expect(formatLocalTimestamp(fixed)).toBe("2026-10-22 07:49:05");
  });

  it("builds category/message body with optional data", () => {
    expect(buildLogBody("launch", "config loaded")).toBe("launch/config loaded");
    expect(buildLogBody("launch", "config loaded", { id: 1 })).toBe(
      'launch/config loaded {"id":1}',
    );
  });

  it("formats full log line", () => {
    expect(
      formatRuntimeLogLine("warn", "nav", "route fallback", undefined, fixed),
    ).toBe("[2026-10-22 07:49:05 WARN] nav/route fallback");
  });
});
