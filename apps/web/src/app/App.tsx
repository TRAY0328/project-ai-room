import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { SkeletonBlock, ThemeProvider, ToastProvider } from "@ai-room/design-system";
import { AppStateProvider } from "../state/AppState.js";
import { Shell } from "../components/Shell.js";
import { SCREEN_BY_ID, matchRoute, type ScreenId } from "../lib/router.js";
import { LandingPage } from "../screens/Landing.js";
import { StartScreen, SignInScreen, AiJoinScreen, ProfileScreen } from "../screens/Start.js";
import { MainChatScreen, RoomsScreen, RoomDetailScreen, SearchScreen, MemoryScreen } from "../screens/Chat.js";
import { ProjectListScreen, ProjectOverviewScreen, TaskBoardScreen, DependenciesScreen } from "../screens/Projects.js";
import { ApprovalsScreen, ReportsScreen, AdminScreen, AuditScreen, BackupScreen, ReleaseGateScreen } from "../screens/Governance.js";
import { ConnectionsScreen, AlertsScreen } from "../screens/Ops.js";
import { demoAlerts } from "../demo/fixtures.js";
import { useApp } from "../state/AppState.js";

/** The editor/CI screens pull in Monaco + Yjs; they load on demand. */
const EditorScreen = lazy(() => import("../screens/CodeEditor.js").then((m) => ({ default: m.EditorScreen })));
const SourceTreeScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.SourceTreeScreen })));
const ReviewScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.ReviewScreen })));
const CiScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.CiScreen })));
const DebugScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.DebugScreen })));
const ArtifactsScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.ArtifactsScreen })));
const FilesScreen = lazy(() => import("../screens/Code.js").then((m) => ({ default: m.FilesScreen })));

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppStateProvider>
          <Root />
        </AppStateProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

const isLanding = (hashPath: string): boolean => {
  const clean = hashPath.replace(/^#/, "").replace(/\?.*$/, "");
  return clean === "" || clean === "/";
};

function Root() {
  const { demoMode } = useApp();
  const [landing, setLanding] = useState(() => isLanding(window.location.hash));
  const [route, setRoute] = useState(() => matchRoute(window.location.hash.replace(/^#/, "") || "/chat"));

  useEffect(() => {
    const onHash = () => {
      setLanding(isLanding(window.location.hash));
      setRoute(matchRoute(window.location.hash.replace(/^#/, "") || "/chat"));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = landing ? "PROJECT AI ROOM — AI가 스스로 가입하는 협업 공간" : `${route.screen.title} · PROJECT AI ROOM`;
  }, [route.screen.title, landing]);

  const navigate = useCallback((id: ScreenId | "HOME", params: Record<string, string> = {}) => {
    if (id === "HOME") {
      window.location.hash = "/";
      return;
    }
    const target = SCREEN_BY_ID[id];
    const path = target.path
      .split("/")
      .map((seg) => (seg.startsWith(":") ? encodeURIComponent(params[seg.slice(1)] ?? route.params[seg.slice(1)] ?? "proj-ai-room") : seg))
      .join("/");
    window.location.hash = path;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [route.params]);

  const notifications = useMemo(() => (demoMode ? demoAlerts.filter((a) => !a.read && a.severity !== "info").length : 0), [demoMode]);

  if (landing) {
    return (
      <Suspense fallback={<div style={{ padding: 24 }}><SkeletonBlock lines={6} /></div>}>
        <LandingPage navigate={navigate} />
      </Suspense>
    );
  }

  const body = renderScreen(route.screen.id, route.params, (id, params) => navigate(id, params));

  return (
    <Shell screen={route.screen} params={route.params} navigate={navigate} notifications={notifications}>
      <Suspense fallback={<div style={{ padding: 24 }}><SkeletonBlock lines={6} /></div>}>
        {body}
      </Suspense>
    </Shell>
  );
}

function renderScreen(id: ScreenId, params: Record<string, string>, navigate: (id: ScreenId, params?: Record<string, string>) => void) {
  switch (id) {
    case "START": return <StartScreen navigate={navigate} />;
    case "SIGNIN": return <SignInScreen navigate={navigate} />;
    case "AIJOIN": return <AiJoinScreen navigate={navigate} />;
    case "PROFILE": return <ProfileScreen />;
    case "MAINCHAT": return <MainChatScreen navigate={navigate} />;
    case "ROOMS": return <RoomsScreen navigate={navigate} />;
    case "ROOMDETAIL": return <RoomDetailScreen params={params} />;
    case "SEARCH": return <SearchScreen navigate={navigate} />;
    case "MEMORY": return <MemoryScreen />;
    case "PROJECTLIST": return <ProjectListScreen navigate={navigate} />;
    case "PROJECTOV": return <ProjectOverviewScreen params={params} navigate={navigate} />;
    case "TASKBOARD": return <TaskBoardScreen params={params} />;
    case "DEPENDENCIES": return <DependenciesScreen params={params} />;
    case "EDITOR": return <EditorScreen params={params} />;
    case "SOURCETREE": return <SourceTreeScreen params={params} />;
    case "REVIEW": return <ReviewScreen params={params} />;
    case "CI": return <CiScreen params={params} />;
    case "DEBUG": return <DebugScreen />;
    case "ARTIFACTS": return <ArtifactsScreen params={params} />;
    case "FILES": return <FilesScreen params={params} />;
    case "APPROVALS": return <ApprovalsScreen />;
    case "REPORTS": return <ReportsScreen />;
    case "ADMIN": return <AdminScreen />;
    case "AUDIT": return <AuditScreen />;
    case "BACKUP": return <BackupScreen />;
    case "CONNECTIONS": return <ConnectionsScreen />;
    case "ALERTS": return <AlertsScreen />;
    case "REL_GATE": return <ReleaseGateScreen />;
    default: return <MainChatScreen navigate={navigate} />;
  }
}
