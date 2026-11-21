/**
 * Screen registry + routing tests.
 *
 * The 28 ids are the `ui_screen_registry.json` contract; this list is the
 * client-side copy of it. If a screen is dropped, routing and coverage fail here
 * before anyone claims the UI is complete.
 */
import { describe, expect, it } from "vitest";
import { SCREENS, SCREEN_BY_ID, NAV_GROUPS, matchRoute, hrefFor, type ScreenId } from "../lib/router.js";

export const REGISTRY_IDS: ScreenId[] = [
  "START", "SIGNIN", "AIJOIN", "PROFILE", "MAINCHAT", "ROOMS", "ROOMDETAIL", "SEARCH",
  "MEMORY", "PROJECTLIST", "PROJECTOV", "TASKBOARD", "DEPENDENCIES", "EDITOR", "SOURCETREE",
  "REVIEW", "CI", "DEBUG", "ARTIFACTS", "FILES", "APPROVALS", "REPORTS", "ADMIN",
  "AUDIT", "BACKUP", "CONNECTIONS", "ALERTS", "REL_GATE",
];

describe("screen registry", () => {
  it("covers all 28 registry screens exactly once", () => {
    expect(SCREENS).toHaveLength(28);
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(28);
    expect(SCREENS.map((s) => s.id).sort()).toEqual([...REGISTRY_IDS].sort());
  });

  it("gives every screen a path, title, group and icon", () => {
    for (const screen of SCREENS) {
      expect(screen.path.startsWith("/")).toBe(true);
      expect(screen.title.length).toBeGreaterThan(0);
      expect(NAV_GROUPS).toContain(screen.group);
      expect(screen.icon.length).toBeGreaterThan(0);
    }
  });

  it("keeps governance screens owner-only", () => {
    const ownerOnly = SCREENS.filter((s) => s.ownerOnly).map((s) => s.id);
    expect(ownerOnly).toEqual(expect.arrayContaining(["APPROVALS", "ADMIN", "AUDIT", "BACKUP", "REL_GATE", "START"]));
  });

  it("uses unique routes", () => {
    const paths = SCREENS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("routing", () => {
  it("matches a static route", () => {
    const match = matchRoute("/chat");
    expect(match.screen.id).toBe("MAINCHAT");
    expect(match.params).toEqual({});
  });

  it("matches parameterised routes and decodes the id", () => {
    const match = matchRoute("/projects/proj%20a/board");
    expect(match.screen.id).toBe("TASKBOARD");
    expect(match.params.id).toBe("proj a");
  });

  it("falls back to the main chat for unknown paths", () => {
    expect(matchRoute("/does-not-exist").screen.id).toBe("MAINCHAT");
  });

  it("builds hrefs with params", () => {
    expect(hrefFor(SCREEN_BY_ID.ROOMDETAIL, { id: "room-1" })).toBe("#/rooms/room-1");
    expect(hrefFor(SCREEN_BY_ID.MAINCHAT)).toBe("#/chat");
  });
});
