import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Drawer,
  Icon,
  IconButton,
  Kbd,
  LiveIndicator,
  useBreakpoint,
  useTheme,
} from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { NAV_GROUPS, SCREENS, type ScreenId, type ScreenMeta } from "../lib/router.js";

export interface ShellProps {
  screen: ScreenMeta;
  params: Record<string, string>;
  navigate: (screenId: ScreenId | "HOME", params?: Record<string, string>) => void;
  notifications: number;
  children: React.ReactNode;
}

export function Shell({ screen, params, navigate, notifications, children }: ShellProps) {
  const { connection, gatewayUrl, demoMode, setDemoMode, refreshConnection, outbox } = useApp();
  const { theme, toggle } = useTheme();
  const breakpoint = useBreakpoint();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isMobile = breakpoint === "xs" || breakpoint === "sm" || breakpoint === "md";

  // A navigation landed on another screen, or the window grew past the drawer
  // breakpoint: either way the overlay drawer has done its job.
  useEffect(() => {
    setNavOpen(false);
  }, [screen.id]);

  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (id: ScreenId | "HOME", extra: Record<string, string> = {}) => {
      navigate(id, { ...params, ...extra });
      setNavOpen(false);
      setPaletteOpen(false);
    },
    [navigate, params],
  );

  const counts: Partial<Record<ScreenId, number>> = {
    MAINCHAT: outbox.filter((o) => o.state === "pending").length || 0,
    ALERTS: notifications,
  };

  return (
    <div className="air-app" data-sidebar={breakpoint === "md" ? "collapsed" : undefined}>
      <a className="air-skip-link" href="#main">본문으로 건너뛰기</a>
      <nav className="air-sidebar" aria-label="주요 화면">
        <div>
          <button
            type="button"
            className="air-brand"
            onClick={() => go("HOME")}
            style={{ background: "none", border: 0, width: "100%", cursor: "pointer", textAlign: "left", color: "inherit" }}
            title="홈페이지(가입 경로)로"
          >
            <span className="air-brand-mark">AIR</span>
            <div className="air-brand-text">
              <div className="air-brand-title">PROJECT AI ROOM</div>
              <div className="air-brand-sub">cloud-only · AI 협업</div>
            </div>
          </button>
          <div className="air-nav">
            <NavList screenId={screen.id} params={params} go={go} counts={counts} testId />
          </div>
        </div>
        <div />
        <div className="air-sidebar-foot">
          <button type="button" className="air-nav-item" onClick={() => void refreshConnection()} style={{ width: "100%", background: "none", border: "1px solid transparent", textAlign: "left" }}>
            <LiveIndicator state={connection.state === "ready" ? "online" : connection.state === "checking" ? "connecting" : connection.state === "unreachable" ? "error" : "offline"} />
            <span className="air-hint air-truncate" style={{ flex: 1 }}>{connection.detail}</span>
          </button>
          <button type="button" className="air-nav-item" onClick={() => go("ADMIN")} style={{ width: "100%", background: "none", textAlign: "left" }}>
            <Icon name="server" size={14} />
            <span className={gatewayUrl ? "air-truncate" : "air-truncate air-hint"} style={{ flex: 1 }}>{gatewayUrl ? new URL(gatewayUrl).host : "게이트웨이 미설정"}</span>
          </button>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "라이트 테마" : "다크 테마"} onClick={toggle} />
            <CapabilityChips />
          </div>
        </div>
      </nav>

      <div className="air-main">
        <header className="air-topbar">
          {isMobile ? (
            <IconButton icon="menu" label="메뉴 열기" aria-expanded={navOpen} aria-controls="air-mobile-nav" onClick={() => setNavOpen(true)} />
          ) : null}
          <div className="air-topbar-heading">
            <div className="air-topbar-title air-truncate">{screen.title}</div>
            <div className="air-topbar-sub air-truncate">{screen.subtitle}</div>
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" className="air-searchbox" onClick={() => setPaletteOpen(true)} aria-label="빠른 검색 열기" data-testid="quick-search">
            <Icon name="search" size={13} />
            <span className="air-truncate" style={{ flex: 1, textAlign: "left" }}>화면·기능 검색</span>
            <Kbd>⌘K</Kbd>
          </button>
          <span className="air-topbar-extra" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {demoMode ? <Badge tone="warn" icon="sparkles" title="데모 데이터 표시 중 — 서버 데이터가 아닙니다">DEMO</Badge> : null}
            <button type="button" className="air-btn" data-size="sm" data-variant="ghost" onClick={() => setDemoMode(!demoMode)} title="서버 없이 화면을 살펴보는 시연 모드">
              <Icon name="eye" size={13} /> {demoMode ? "데모 끄기" : "데모"}
            </button>
          </span>
          <span style={{ position: "relative" }}>
            <IconButton icon="bell" label={`알림 ${notifications}건`} onClick={() => go("ALERTS")} />
            {notifications > 0 ? (
              <span aria-hidden="true" style={{ position: "absolute", top: 0, right: 0, width: 7, height: 7, borderRadius: 999, background: "var(--air-danger)" }} />
            ) : null}
          </span>
          <IconButton icon="key" label="AI 참여 포털" onClick={() => go("AIJOIN")} />
        </header>

        <ConnectionBanners onOpenSettings={() => go("ADMIN")} />

        <main className="air-main-scroll" id="main">
          <div key={screen.id} className="air-route-fade">
            {children}
          </div>
        </main>
      </div>

      <Drawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="화면"
        footer={
          <div className="air-sidebar-foot" style={{ borderTop: "1px solid var(--air-line)" }}>
            <button
              type="button"
              className="air-nav-item"
              onClick={() => void refreshConnection()}
              style={{ width: "100%", background: "none", border: "1px solid transparent", textAlign: "left" }}
            >
              <LiveIndicator state={connection.state === "ready" ? "online" : connection.state === "checking" ? "connecting" : connection.state === "unreachable" ? "error" : "offline"} />
              <span className="air-hint air-truncate" style={{ flex: 1 }}>{connection.detail}</span>
            </button>
            <button type="button" className="air-nav-item" onClick={() => go("ADMIN")} style={{ width: "100%", background: "none", textAlign: "left" }}>
              <Icon name="server" size={14} />
              <span className={gatewayUrl ? "air-truncate" : "air-truncate air-hint"} style={{ flex: 1 }}>{gatewayUrl ? new URL(gatewayUrl).host : "게이트웨이 미설정"}</span>
            </button>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Button size="sm" block variant={demoMode ? "primary" : "ghost"} icon="eye" onClick={() => setDemoMode(!demoMode)}>
                {demoMode ? "데모 끄기" : "데모 데이터"}
              </Button>
              <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "라이트 테마" : "다크 테마"} onClick={toggle} />
            </div>
          </div>
        }
      >
        <div id="air-mobile-nav" style={{ padding: 8 }}>
          <NavList screenId={screen.id} params={params} go={go} counts={counts} />
        </div>
      </Drawer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={(id) => go(id)} />
    </div>
  );
}

/* ------------------------------------------------------------- nav list */

/**
 * The one navigation list: the desktop sidebar and the phone drawer render the
 * same groups and items, so a screen never exists in only one of them.
 */
function NavList({
  screenId,
  params,
  go,
  counts,
  testId,
}: {
  screenId: ScreenId;
  params: Record<string, string>;
  go: (id: ScreenId | "HOME", extra?: Record<string, string>) => void;
  counts: Partial<Record<ScreenId, number>>;
  testId?: boolean;
}) {
  return (
    <>
      {NAV_GROUPS.map((group) => {
        const items = SCREENS.filter((s) => s.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <div className="air-nav-group-label">{group}</div>
            {items.map((item) => (
              <a
                key={item.id}
                className="air-nav-item"
                href={`#${item.path.replace(/:id/g, params.id ?? "demo-project")}`}
                aria-current={item.id === screenId ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(item.id);
                }}
                title={item.ownerOnly ? `${item.title} · OWNER ONLY` : item.title}
                data-testid={testId ? `nav-${item.id}` : undefined}
              >
                <Icon name={item.icon} size={15} />
                <span className="air-truncate" style={{ flex: 1 }}>{item.title}</span>
                {item.ownerOnly ? <Icon name="lock" size={11} style={{ opacity: 0.55 }} /> : null}
                {counts[item.id] ? <span className="air-nav-count">{counts[item.id]}</span> : null}
              </a>
            ))}
          </div>
        );
      })}
    </>
  );
}

function CapabilityChips() {
  return (
    <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }} title="이 클라이언트가 실제로 제공하는 기능만 표시">
      <Badge tone="neutral" title="키보드 내비게이션 지원">⌨</Badge>
      <Badge tone="neutral" title="WCAG AA 대비 목표">AA</Badge>
    </span>
  );
}

function ConnectionBanners({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { connection, gatewayUrl, demoMode, outbox, retryOutbox, discardOutbox, lastFlush } = useApp();
  const pending = outbox.filter((o) => o.state === "pending");
  const failed = outbox.filter((o) => o.state === "failed");
  const [dismissed, setDismissed] = useState(false);

  if (dismissed && connection.state === "unconfigured") return null;

  return (
    <div style={{ display: "grid", gap: 6, padding: "8px 16px 0" }}>
      {demoMode ? (
        <div className="air-banner" data-tone="warn" role="status">
          <Icon name="sparkles" size={14} style={{ color: "var(--air-warn)", flex: "none" }} />
          <div style={{ flex: 1 }}>
            <strong>데모 데이터 표시 중.</strong> 화면 시연용 샘플이며 <strong>서버 데이터가 아닙니다.</strong> 실제 값은 게이트웨이 연결 후에만 표시됩니다.
          </div>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>숨기기</Button>
        </div>
      ) : null}
      {!gatewayUrl && !demoMode ? (
        <div className="air-banner" data-tone="info" role="status">
          <Icon name="plug" size={14} style={{ flex: "none", color: "var(--air-info)" }} />
          <div style={{ flex: 1 }}>
            게이트웨이 URL이 설정되지 않았습니다. 서버 없이 화면을 살펴보려면 <strong>데모</strong>를 켜세요. 실제 동작에는 게이트웨이 연결이 필요합니다.
          </div>
          <Button size="sm" onClick={onOpenSettings}>설정 열기</Button>
        </div>
      ) : null}
      {connection.state === "unreachable" ? (
        <div className="air-banner" data-tone="danger" role="alert">
          <Icon name="wifiOff" size={14} style={{ flex: "none", color: "var(--air-danger)" }} />
          <div style={{ flex: 1 }}>게이트웨이에 닿지 않습니다 — {connection.detail}</div>
        </div>
      ) : null}
      {connection.state === "unauthenticated" ? (
        <div className="air-banner" data-tone="warn" role="status">
          <Icon name="lock" size={14} style={{ flex: "none", color: "var(--air-warn)" }} />
          <div style={{ flex: 1 }}>로그인 세션이 없습니다. 소유자 로그인 또는 AI 키 인증이 필요합니다.</div>
          <a className="air-btn" data-size="sm" href="#/signin">로그인</a>
        </div>
      ) : null}
      {pending.length > 0 || failed.length > 0 ? (
        <div className="air-banner" data-tone={failed.length ? "danger" : "warn"} role="status">
          <Icon name={failed.length ? "warning" : "refresh"} size={14} style={{ flex: "none", marginTop: 1 }} />
          <div style={{ flex: 1 }} data-testid="outbox-retry">
            오프라인 보관함: 대기 {pending.length}건{failed.length ? ` · 실패 ${failed.length}건` : ""}
            {lastFlush ? ` · 마지막 시도 ${new Date(lastFlush.at).toLocaleTimeString()}` : ""}
            {failed[0]?.lastError ? <div className="air-hint">{failed[0].lastError}</div> : null}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {failed[0] ? (
              <>
                <Button size="sm" onClick={() => void retryOutbox(failed[0]!.id)}>재전송</Button>
                <Button size="sm" variant="ghost" onClick={() => discardOutbox(failed[0]!.id)}>삭제</Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- command palette */

export function CommandPalette({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: ScreenId) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SCREENS.slice(0, 8);
    return SCREENS.filter((s) => s.title.toLowerCase().includes(q) || s.subtitle.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).slice(0, 10);
  }, [query]);

  if (!open) return null;

  return (
    <div className="air-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ alignItems: "flex-start", paddingTop: "12vh" }}>
      <div className="air-dialog" role="dialog" aria-modal="true" aria-label="빠른 검색" style={{ width: "min(620px, 100%)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--air-line)" }}>
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            className="air-input"
            style={{ border: 0, background: "transparent", fontSize: 14, padding: 4 }}
            placeholder="화면 이름 또는 기능 검색…"
            value={query}
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={results[index] ? `palette-${results[index]!.id}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && results[index]) {
                e.preventDefault();
                onPick(results[index]!.id);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <Kbd>ESC</Kbd>
        </div>
        <ul id="palette-results" role="listbox" style={{ listStyle: "none", margin: 0, padding: 6, maxHeight: 360, overflow: "auto" }}>
          {results.length === 0 ? <li className="air-hint" style={{ padding: 10 }}>일치하는 화면이 없습니다</li> : null}
          {results.map((item, i) => (
            <li key={item.id} id={`palette-${item.id}`} role="option" aria-selected={i === index}>
              <button
                type="button"
                className="air-mention-item"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(item.id)}
                style={{ borderRadius: 8 }}
              >
                <Icon name={item.icon} size={14} />
                <span style={{ flex: 1 }}>{item.title}</span>
                <span className="air-hint">{item.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="air-dialog-foot" style={{ justifyContent: "space-between" }}>
          <span className="air-hint">↑↓ 이동 · Enter 열기 · Esc 닫기</span>
          <span className="air-hint">{SCREENS.length}개 화면</span>
        </div>
      </div>
    </div>
  );
}
