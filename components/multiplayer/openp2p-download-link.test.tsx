import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPENP2P_LATEST_RELEASE_URL,
  OpenP2PDownloadLink,
} from "@/components/multiplayer/openp2p-download-link";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OpenP2PDownloadLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the latest-version download action and network hint", () => {
    render(<OpenP2PDownloadLink />);

    expect(
      screen.getByRole("button", { name: "下载 OpenP2P 最新版本" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("若 GitHub 无法访问，可尝试使用网络加速工具")
    ).toBeInTheDocument();
  });

  it("opens the latest release in the system browser", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<OpenP2PDownloadLink />);

    fireEvent.click(
      screen.getByRole("button", { name: "下载 OpenP2P 最新版本" })
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_external", {
        url: OPENP2P_LATEST_RELEASE_URL,
      });
    });
  });

  it("falls back to a safe browser window when Tauri cannot open the link", async () => {
    invokeMock.mockRejectedValue(new Error("Tauri unavailable"));
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<OpenP2PDownloadLink />);

    fireEvent.click(
      screen.getByRole("button", { name: "下载 OpenP2P 最新版本" })
    );

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        OPENP2P_LATEST_RELEASE_URL,
        "_blank",
        "noopener,noreferrer"
      );
    });
  });

  it("disables the action while the system browser is opening", async () => {
    let finishOpening: (() => void) | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishOpening = resolve;
        })
    );
    render(<OpenP2PDownloadLink />);
    const downloadButton = screen.getByRole("button", {
      name: "下载 OpenP2P 最新版本",
    });

    fireEvent.click(downloadButton);
    expect(downloadButton).toBeDisabled();

    finishOpening?.();
    await waitFor(() => expect(downloadButton).toBeEnabled());
  });

  it("shows an error when neither browser-opening method works", async () => {
    invokeMock.mockRejectedValue(new Error("Tauri unavailable"));
    vi.spyOn(window, "open").mockImplementation(() => null);
    render(<OpenP2PDownloadLink />);

    fireEvent.click(
      screen.getByRole("button", { name: "下载 OpenP2P 最新版本" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法打开下载页面，请稍后重试"
    );
  });
});
