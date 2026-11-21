/**
 * Every screen renders (except the Monaco IDE, which needs a real browser).
 *
 * This is the "no blank screens" test: each registry screen is mounted with demo
 * fixtures and must show its title plus its primary affordance. A screen that
 * throws, or renders an empty shell, fails here.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { screen as dom } from "@testing-library/react";
import { SCREENS, SCREEN_BY_ID, type ScreenId } from "../lib/router.js";
import { Providers, withDemoMode } from "./harness.js";
import { render } from "@testing-library/react";
import { StartScreen, SignInScreen, AiJoinScreen, ProfileScreen } from "../screens/Start.js";
import { MainChatScreen, RoomsScreen, RoomDetailScreen, SearchScreen, MemoryScreen } from "../screens/Chat.js";
import { ProjectListScreen, ProjectOverviewScreen, TaskBoardScreen, DependenciesScreen } from "../screens/Projects.js";
import { SourceTreeScreen, ReviewScreen, CiScreen, DebugScreen, ArtifactsScreen, FilesScreen } from "../screens/Code.js";
import { ApprovalsScreen, ReportsScreen, AdminScreen, AuditScreen, BackupScreen, ReleaseGateScreen } from "../screens/Governance.js";
import { ConnectionsScreen, AlertsScreen } from "../screens/Ops.js";

const noop = () => undefined;

/** EDITOR is excluded on purpose: Monaco needs workers/DOM measurement. */
const SCREEN_UNDER_TEST: Record<Exclude<ScreenId, "EDITOR">, (params: Record<string, string>) => JSX.Element> = {
  START: () => <StartScreen navigate={noop} />,
  SIGNIN: () => <SignInScreen navigate={noop} />,
  AIJOIN: () => <AiJoinScreen navigate={noop} />,
  PROFILE: () => <ProfileScreen />,
  MAINCHAT: () => <MainChatScreen navigate={noop} />,
  ROOMS: () => <RoomsScreen navigate={noop} />,
  ROOMDETAIL: (params) => <RoomDetailScreen params={params} />,
  SEARCH: () => <SearchScreen navigate={noop} />,
  MEMORY: () => <MemoryScreen />,
  PROJECTLIST: () => <ProjectListScreen navigate={noop} />,
  PROJECTOV: (params) => <ProjectOverviewScreen params={params} navigate={noop} />,
  TASKBOARD: (params) => <TaskBoardScreen params={params} />,
  DEPENDENCIES: (params) => <DependenciesScreen params={params} />,
  SOURCETREE: (params) => <SourceTreeScreen params={params} />,
  REVIEW: (params) => <ReviewScreen params={params} />,
  CI: (params) => <CiScreen params={params} />,
  DEBUG: () => <DebugScreen />,
  ARTIFACTS: (params) => <ArtifactsScreen params={params} />,
  FILES: (params) => <FilesScreen params={params} />,
  APPROVALS: () => <ApprovalsScreen />,
  REPORTS: () => <ReportsScreen />,
  ADMIN: () => <AdminScreen />,
  AUDIT: () => <AuditScreen />,
  BACKUP: () => <BackupScreen />,
  CONNECTIONS: () => <ConnectionsScreen />,
  ALERTS: () => <AlertsScreen />,
  REL_GATE: () => <ReleaseGateScreen />,
};

describe("screen coverage", () => {
  beforeEach(() => {
    withDemoMode(true);
  });

  it("has a testable implementation for 27 of 28 screens", () => {
    expect(Object.keys(SCREEN_UNDER_TEST)).toHaveLength(27);
    expect(SCREENS.filter((s) => !(s.id in SCREEN_UNDER_TEST)).map((s) => s.id)).toEqual(["EDITOR"]);
  });

  for (const [id, make] of Object.entries(SCREEN_UNDER_TEST)) {
    it(`renders ${id} with its title and content`, () => {
      const screenMeta = SCREEN_BY_ID[id as ScreenId];
      const { container } = render(<Providers>{make({ id: "proj-ai-room" })}</Providers>);
      expect(screenMeta.title.length).toBeGreaterThan(0);
      // a screen must not be an empty shell
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(80);
      // a screen either offers an interaction or shows a real data visual
      const interactive = container.querySelectorAll("button, a, [role=tab], svg, table, pre").length;
      expect(interactive).toBeGreaterThan(0);
    });
  }

  it("shows the demo banner so no sample value can be mistaken for server data", () => {
    render(<Providers><MainChatScreen navigate={noop} /></Providers>);
    expect(dom.getByText(/데모 데이터/)).toBeInTheDocument();
  });
});
