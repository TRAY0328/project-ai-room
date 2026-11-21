import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { ThemeProvider, ToastProvider, applyThemeVariables } from "@ai-room/design-system";
import { AppStateProvider } from "../state/AppState.js";
import { Shell } from "../components/Shell.js";
import { SCREEN_BY_ID, type ScreenId } from "../lib/router.js";

/** Demo mode is the only way the client shows sample data — tests turn it on explicitly. */
export function withDemoMode(on = true): void {
  localStorage.setItem("air.demo", on ? "1" : "0");
  localStorage.removeItem("air.gateway");
}

export function Providers({ children }: { children: ReactNode }) {
  applyThemeVariables("light");
  return (
    <ThemeProvider initialPreference="light">
      <ToastProvider>
        <AppStateProvider initialGateway={null}>{children}</AppStateProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export function renderScreen(screenId: ScreenId, params: Record<string, string> = { id: "proj-ai-room" }): RenderResult {
  const screen = SCREEN_BY_ID[screenId];
  return render(
    <Providers>
      <Shell screen={screen} params={params} navigate={() => undefined} notifications={0}>
        {null}
      </Shell>
    </Providers>,
  );
}

/** Renders arbitrary UI inside the same provider stack the app uses. */
export function renderWithProviders(ui: ReactNode): RenderResult {
  return render(<Providers>{ui}</Providers>);
}
