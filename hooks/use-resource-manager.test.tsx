import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResourceManager } from "./use-resource-manager";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function callsFor(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useResourceManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not re-fetch after the initial instance-file state update", async () => {
    invokeMock
      .mockResolvedValueOnce([
        { name: "installed.zip", is_dir: false, extension: "zip", size: 42 },
      ])
      .mockResolvedValueOnce(["cached.zip"]);

    renderHook(() =>
      useResourceManager(
        "/minecraft/versions/example",
        "resourcepacks",
        "resourcepack",
        "1.21.1",
        undefined,
        ["zip"],
      ),
    );

    await waitFor(() => {
      expect(callsFor("vm_list_dir")).toHaveLength(1);
      expect(callsFor("list_cached_files")).toHaveLength(1);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(callsFor("vm_list_dir")).toHaveLength(1);
    expect(callsFor("list_cached_files")).toHaveLength(1);
  });

  it("opens a schematic subdirectory and lists its entries", async () => {
    invokeMock.mockImplementation((command, options) => {
      if (command === "vm_list_dir") {
        const { dirPath } = options as { dirPath: string };
        return Promise.resolve(
          dirPath.endsWith("/schematics/castle")
            ? [{ name: "gate.schem", is_dir: false, extension: "schem", size: 128 }]
            : [{ name: "castle", is_dir: true, extension: "", size: 0 }],
        );
      }
      if (command === "list_cached_files") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() =>
      useResourceManager(
        "/minecraft/versions/example",
        "schematics",
        "world",
        "1.21.1",
        undefined,
        ["schem", "schematic"],
        true,
      ),
    );

    await waitFor(() => {
      expect(result.current.instanceFiles).toEqual([
        { name: "castle", isDir: true, size: 0 },
      ]);
    });

    act(() => {
      result.current.openInstanceDirectory("castle");
    });

    await waitFor(() => {
      expect(result.current.instanceDirectoryPath).toEqual(["castle"]);
      expect(result.current.instanceFiles).toEqual([
        { name: "gate.schem", isDir: false, size: 128 },
      ]);
    });

    expect(callsFor("vm_list_dir")).toContainEqual([
      "vm_list_dir",
      {
        dirPath: "/minecraft/versions/example/schematics/castle",
        extensionsFilter: ["schem", "schematic"],
      },
    ]);
  });

  it("keeps every supported schematic format when listing a subdirectory", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "vm_list_dir") {
        return Promise.resolve([
          { name: "build.litematic", is_dir: false, extension: "litematic", size: 256 },
          { name: "build.nbt", is_dir: false, extension: "nbt", size: 128 },
          { name: "收藏", is_dir: true, extension: "", size: 0 },
        ]);
      }
      if (command === "list_cached_files") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() =>
      useResourceManager(
        "/minecraft/versions/example",
        "schematics",
        "world",
        "1.21.1",
        undefined,
        ["schem", "schematic", "litematic", "nbt"],
        true,
      ),
    );

    await waitFor(() => {
      expect(result.current.instanceFiles).toEqual([
        { name: "收藏", isDir: true, size: 0 },
        { name: "build.litematic", isDir: false, size: 256 },
        { name: "build.nbt", isDir: false, size: 128 },
      ]);
    });
  });
});
