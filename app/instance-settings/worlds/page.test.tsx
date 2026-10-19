import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorldsPage from "./page";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/hooks/use-instance-path", () => ({
  useInstancePath: () => ({
    instanceDir: "/minecraft/versions/example",
    selectedInstance: {
      name: "example",
      minecraft_version: "1.21.1",
    },
    minecraftPath: "/minecraft",
    configLoaded: true,
  }),
}));

const invokeMock = vi.mocked(invoke);

function callsFor(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorldsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads each source once when the page opens", async () => {
    invokeMock
      .mockResolvedValueOnce([
        { name: "Existing world", is_dir: true, extension: "", size: 0 },
      ])
      .mockResolvedValueOnce(["Existing world", "Cached world"]);

    render(<WorldsPage />);

    await waitFor(() => {
      expect(callsFor("vm_list_dir")).toHaveLength(1);
      expect(callsFor("list_cached_files")).toHaveLength(1);
    });

    expect(await screen.findByText("Cached world")).toBeInTheDocument();
    expect(screen.getAllByText("Existing world")).toHaveLength(1);

    // Give state updates a chance to settle. A dependency cycle would trigger
    // another pair of invokes during this interval.
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(callsFor("vm_list_dir")).toHaveLength(1);
    expect(callsFor("list_cached_files")).toHaveLength(1);
  });
});
