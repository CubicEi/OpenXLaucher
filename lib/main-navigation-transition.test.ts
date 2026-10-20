import { describe, expect, it } from "vitest";

import {
  isDescendantAppPath,
  isSharedLayoutRoute,
  isWithinSameLayoutSection,
  normalizeAppPathname,
  pathnameMatchesNavigationTarget,
  shouldUseLightweightAppNavigation,
  toAppHref,
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

describe("toAppHref", () => {
  it("adds trailing slash for static export routes", () => {
    expect(toAppHref("/game-settings/mods")).toBe("/game-settings/mods/");
    expect(toAppHref("/")).toBe("/");
  });
});

describe("isWithinSameLayoutSection", () => {
  it("groups game-settings hub and sub-routes", () => {
    expect(isWithinSameLayoutSection("/game-settings", "/game-settings/mods")).toBe(
      true,
    );
    expect(isWithinSameLayoutSection("/game-settings/", "/game-settings/resources/")).toBe(
      true,
    );
    expect(isWithinSameLayoutSection("/download", "/game-settings/mods")).toBe(false);
  });
});

describe("isDescendantAppPath", () => {
  it("detects child routes", () => {
    expect(isDescendantAppPath("/game-settings", "/game-settings/mods")).toBe(true);
    expect(isDescendantAppPath("/game-settings/mods", "/game-settings")).toBe(false);
  });
});

describe("shouldUseLightweightAppNavigation", () => {
  it("allows home → game-settings sub-route without same-section current path", () => {
    expect(isSharedLayoutRoute("/game-settings/mods")).toBe(true);
    expect(shouldUseLightweightAppNavigation("/", "/game-settings/mods")).toBe(true);
    expect(shouldUseLightweightAppNavigation("/", "/download")).toBe(false);
  });
});
