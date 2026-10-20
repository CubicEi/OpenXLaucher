import { describe, expect, it } from "vitest";

import {
  normalizeAppPathname,
  pathnameMatchesNavigationTarget,
} from "./main-navigation-transition";

describe("pathnameMatchesNavigationTarget", () => {
  it("matches exact paths with optional trailing slash", () => {
    expect(pathnameMatchesNavigationTarget("/game-settings/", "/game-settings")).toBe(true);
    expect(pathnameMatchesNavigationTarget("/game-settings", "/game-settings")).toBe(true);
  });

  it("matches nested child routes under the target", () => {
    expect(pathnameMatchesNavigationTarget("/game-settings/mods", "/game-settings")).toBe(
      true,
    );
    expect(
      pathnameMatchesNavigationTarget("/game-settings/resources", "/game-settings"),
    ).toBe(true);
  });

  it("does not treat sibling routes as nested matches", () => {
    expect(pathnameMatchesNavigationTarget("/game-settings-old", "/game-settings")).toBe(
      false,
    );
    expect(pathnameMatchesNavigationTarget("/launch", "/game-settings")).toBe(false);
  });

  it("normalizes pathnames consistently", () => {
    expect(normalizeAppPathname("/game-settings/mods/")).toBe("/game-settings/mods");
  });
});
