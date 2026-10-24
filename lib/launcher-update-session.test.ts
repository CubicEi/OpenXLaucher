import { afterEach, describe, expect, it } from "vitest";

import {
  __hydrateLauncherUpdateSessionForTests,
  __resetLauncherUpdateSessionForTests,
  markStartupUpdateCheckCompleted,
  markStartupUpdatePromptDismissed,
  shouldRunStartupUpdateCheck,
  shouldShowStartupUpdatePrompt,
  shouldSkipAutomaticUpdateCheck,
} from "./launcher-update-session";

afterEach(() => {
  __resetLauncherUpdateSessionForTests();
});

describe("launcher-update-session persistence", () => {
  it("restores startup check completion after simulated full reload", () => {
    markStartupUpdateCheckCompleted();
    expect(shouldRunStartupUpdateCheck()).toBe(false);

    __hydrateLauncherUpdateSessionForTests();

    expect(shouldRunStartupUpdateCheck()).toBe(false);
    expect(shouldSkipAutomaticUpdateCheck()).toBe(true);
  });

  it("remembers dismissed target version across reload", () => {
    markStartupUpdatePromptDismissed("0.3.3-beta");
    expect(shouldShowStartupUpdatePrompt("0.3.3-beta")).toBe(false);

    __hydrateLauncherUpdateSessionForTests();

    expect(shouldShowStartupUpdatePrompt("0.3.3-beta")).toBe(false);
    expect(shouldShowStartupUpdatePrompt("0.3.4-beta")).toBe(true);
  });
});
