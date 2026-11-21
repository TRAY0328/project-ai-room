import type { ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  LiveIndicator,
  SkeletonBlock,
  StateView,
  UnavailablePanel,
  type DataState,
} from "@ai-room/design-system";
import type { ResourceState } from "../api/hooks.js";
import { useApp } from "../state/AppState.js";

export function ScreenHeader({ title, subtitle, actions, badges }: { title: string; subtitle?: string; actions?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="air-screen-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="air-screen-title">{title}</h1>
        {subtitle ? <div className="air-screen-sub">{subtitle}</div> : null}
        {badges ? <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>{badges}</div> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}

export function DemoChip({ on }: { on: boolean }) {
  if (!on) return null;
  return <Badge tone="warn" shape="dashed" title="데모 픽스처 값 — 서버 데이터 아님">DEMO</Badge>;
}

/**
 * One renderer for the four non-ready states, so no screen can quietly show
 * "0" instead of "데이터 없음".
 */
export function ResourceView<T>({
  state,
  children,
  loadingLabel = "불러오는 중",
  emptyTitle = "데이터 없음",
  emptyDetail,
  unavailableDetail,
  onRetry,
}: {
  state: ResourceState<T>;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
  unavailableDetail?: string;
  onRetry?: () => void;
}) {
  const { gatewayUrl, demoMode } = useApp();

  switch (state.kind) {
    case "idle":
      return (
        <UnavailablePanel
          title="서버 미연결"
          detail={
            gatewayUrl
              ? "요청이 시작되지 않았습니다. 새로고침하거나 게이트웨이 설정을 확인하세요."
              : "게이트웨이 URL이 없어 API를 호출하지 않았습니다. 관리자 설정에서 URL을 등록하거나 데모 모드로 화면을 확인하세요."
          }
          reason={demoMode ? "데모 모드: 위 데이터는 데모 픽스처입니다" : undefined}
        />
      );
    case "loading":
      return <SkeletonBlock lines={4} />;
    case "unauthenticated":
      return (
        <UnavailablePanel
          title="로그인 필요"
          detail="세션이 없어 데이터를 가져올 수 없습니다. 소유자로 로그인하거나 AI 키로 인증하세요."
          reason={state.detail}
        />
      );
    case "unavailable":
      return <UnavailablePanel title="데이터 없음 (UNAVAILABLE)" detail={unavailableDetail ?? "게이트웨이에 닿지 않아 값을 표시할 수 없습니다."} reason={`${state.code} · ${state.detail}`} onRetry={onRetry} />;
    case "error":
      return <UnavailablePanel title={`오류 (${state.code})`} detail={state.detail} onRetry={onRetry} />;
    case "ready":
      return <>{children(state.data)}</>;
    default:
      return null;
  }
}

export function StateChip({ state }: { state: "PASS" | "FAIL" | "BLOCKED" | "RUNNING" | "QUEUED" | "SUCCEEDED" | "FAILED" | "UNAVAILABLE" }) {
  const map = {
    PASS: ["ok", "PASS"],
    SUCCEEDED: ["ok", "SUCCEEDED"],
    FAIL: ["danger", "FAIL"],
    FAILED: ["danger", "FAILED"],
    BLOCKED: ["warn", "BLOCKED"],
    RUNNING: ["info", "RUNNING"],
    QUEUED: ["neutral", "QUEUED"],
    UNAVAILABLE: ["neutral", "UNAVAILABLE"],
  } as const;
  const [tone, label] = map[state];
  return <Badge tone={tone} shape={state === "UNAVAILABLE" ? "dashed" : "pill"} dot>{label}</Badge>;
}

export function KeyValue({ items }: { items: Array<{ key: string; value: ReactNode }> }) {
  return (
    <dl className="air-kv">
      {items.map((item) => (
        <div key={item.key} style={{ display: "contents" }}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusLine({ state, label }: { state: "online" | "offline" | "connecting" | "error"; label?: string }) {
  return <LiveIndicator state={state} label={label} />;
}

export function Section({
  title,
  sub,
  actions,
  children,
  id,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Card id={id as never}>
      <div className="air-section-head">
        <div style={{ minWidth: 0 }}>
          <div className="air-section-title">{title}</div>
          {sub ? <div className="air-section-sub">{sub}</div> : null}
        </div>
        {actions ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{actions}</div> : null}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </Card>
  );
}

export function NotConnectedNote() {
  const { gatewayUrl, demoMode, setDemoMode } = useApp();
  if (demoMode) return <DemoNote />;
  if (gatewayUrl) return null;
  return (
    <Banner tone="info" icon="info">
      게이트웨이 URL이 없습니다. <Button size="sm" variant="ghost" onClick={() => setDemoMode(true)}>데모 모드 켜기</Button> 로 화면을 확인하거나, 운영 설정에서 URL을 등록하세요.
    </Banner>
  );
}

export function DemoNote({ detail = "이 화면의 값은 데모 픽스처입니다. 서버에서 가져온 값이 아닙니다." }: { detail?: string }) {
  return (
    <Banner tone="warn" icon="sparkles">
      <strong>데모 데이터.</strong> {detail}
    </Banner>
  );
}

export function DataStateView({ state, children }: { state: DataState; children: ReactNode }) {
  return <StateView state={state}>{children}</StateView>;
}

export function EmptyHint({ icon = "sparkles", title, detail, action }: { icon?: Parameters<typeof Icon>[0]["name"]; title: string; detail?: ReactNode; action?: ReactNode }) {
  return <EmptyState icon={icon} title={title} detail={detail} action={action} />;
}

export function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {keys.map((k) => (
        <kbd key={k} className="air-kbd">{k}</kbd>
      ))}
    </span>
  );
}
