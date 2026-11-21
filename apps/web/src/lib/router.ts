/**
 * Screen registry (ui_screen_registry.json, 28 screens).
 *
 * The route table is the single list of screens; the shell builds navigation
 * from it and the coverage test asserts all 28 registry ids render.
 */
import type { IconName } from "@ai-room/design-system";

export type ScreenId =
  | "START"
  | "SIGNIN"
  | "AIJOIN"
  | "PROFILE"
  | "MAINCHAT"
  | "ROOMS"
  | "ROOMDETAIL"
  | "SEARCH"
  | "MEMORY"
  | "PROJECTLIST"
  | "PROJECTOV"
  | "TASKBOARD"
  | "DEPENDENCIES"
  | "EDITOR"
  | "SOURCETREE"
  | "REVIEW"
  | "CI"
  | "DEBUG"
  | "ARTIFACTS"
  | "FILES"
  | "APPROVALS"
  | "REPORTS"
  | "ADMIN"
  | "AUDIT"
  | "BACKUP"
  | "CONNECTIONS"
  | "ALERTS"
  | "REL_GATE";

export type NavGroup = "시작" | "대화" | "프로젝트" | "코드·배포" | "거버넌스";

export interface ScreenMeta {
  id: ScreenId;
  /** Path pattern; `:id` params are read from the hash route. */
  path: string;
  title: string;
  subtitle: string;
  group: NavGroup;
  icon: IconName;
  /** Only the owner sees governance screens, AI keys cannot open them. */
  ownerOnly?: boolean;
}

export const SCREENS: readonly ScreenMeta[] = Object.freeze([
  { id: "START", path: "/start", title: "시작하기", subtitle: "소유자 초기 설정 · Cloudflare/GitHub 연결 확인", group: "시작", icon: "sparkles", ownerOnly: true },
  { id: "SIGNIN", path: "/signin", title: "로그인", subtitle: "소유자 세션 · CSRF 보호 · 장치 세션", group: "시작", icon: "lock" },
  { id: "AIJOIN", path: "/ai-join", title: "AI 참여 포털", subtitle: "AI가 브라우저로 직접 가입·로그인·작업하는 전용 화면", group: "시작", icon: "key" },
  { id: "PROFILE", path: "/profile", title: "AI 프로필", subtitle: "이름·아바타·자체신고/검증 상태 구분", group: "시작", icon: "user" },
  { id: "MAINCHAT", path: "/chat", title: "단체 채팅", subtitle: "기본 단체방 · 스레드 · 반응 · 구조화 블록", group: "대화", icon: "chat" },
  { id: "ROOMS", path: "/rooms", title: "방 목록", subtitle: "방 생성·초대·프로젝트 연결", group: "대화", icon: "rooms" },
  { id: "ROOMDETAIL", path: "/rooms/:id", title: "방 상세", subtitle: "구성원·핀·미디어·내보내기", group: "대화", icon: "rooms" },
  { id: "SEARCH", path: "/search", title: "통합 검색", subtitle: "본문·코드·파일·기억 · ACL 필터", group: "대화", icon: "search" },
  { id: "MEMORY", path: "/memory", title: "기억 관리", subtitle: "개인·방·프로젝트·공유 기억과 출처", group: "대화", icon: "memory" },
  { id: "PROJECTLIST", path: "/projects", title: "전체 프로젝트", subtitle: "실검증 진행률 · 차단 사유", group: "프로젝트", icon: "project" },
  { id: "PROJECTOV", path: "/projects/:id", title: "프로젝트 개요", subtitle: "목표·요구사항·AI 배정", group: "프로젝트", icon: "columns" },
  { id: "TASKBOARD", path: "/projects/:id/board", title: "작업 보드", subtitle: "칸반 · lease · 인계", group: "프로젝트", icon: "board" },
  { id: "DEPENDENCIES", path: "/projects/:id/dependencies", title: "의존성 그래프", subtitle: "선행 작업 · 순환 감지", group: "프로젝트", icon: "graph" },
  { id: "EDITOR", path: "/projects/:id/ide", title: "웹 IDE", subtitle: "Monaco + Yjs · 실제 커서만 표시", group: "코드·배포", icon: "code" },
  { id: "SOURCETREE", path: "/projects/:id/git", title: "Git 탐색", subtitle: "브랜치·파일·커밋 이력", group: "코드·배포", icon: "branch" },
  { id: "REVIEW", path: "/projects/:id/review", title: "코드 리뷰", subtitle: "Diff · SHA 고정 승인 · 체크리스트", group: "코드·배포", icon: "review" },
  { id: "CI", path: "/projects/:id/ci", title: "빌드·테스트", subtitle: "Actions 실제 실행 기록", group: "코드·배포", icon: "ci" },
  { id: "DEBUG", path: "/projects/:id/debug", title: "디버깅", subtitle: "스택·로그·재현 테스트 · 지원 범위", group: "코드·배포", icon: "debug" },
  { id: "ARTIFACTS", path: "/projects/:id/artifacts", title: "산출물", subtitle: "버전·SHA-256·다운로드 검증", group: "코드·배포", icon: "artifact" },
  { id: "FILES", path: "/projects/:id/files", title: "프로젝트 파일", subtitle: "업로드·미리보기·권한형 다운로드", group: "코드·배포", icon: "file" },
  { id: "APPROVALS", path: "/approvals", title: "승인 센터", subtitle: "위험 작업 · 변경 해시 · 승인/거절", group: "거버넌스", icon: "approval", ownerOnly: true },
  { id: "REPORTS", path: "/reports", title: "보고서", subtitle: "근거 링크가 있는 진행/차단 보고", group: "거버넌스", icon: "report" },
  { id: "ADMIN", path: "/admin", title: "운영 설정", subtitle: "AI 차단·키 회전·예산 (OWNER ONLY)", group: "거버넌스", icon: "admin", ownerOnly: true },
  { id: "AUDIT", path: "/audit", title: "감사 로그", subtitle: "누가 무엇을 했는지 · PII 마스킹", group: "거버넌스", icon: "audit", ownerOnly: true },
  { id: "BACKUP", path: "/backup", title: "백업·복구", subtitle: "체크섬·복원 시험·삭제 승인", group: "거버넌스", icon: "backup", ownerOnly: true },
  { id: "CONNECTIONS", path: "/connections", title: "AI 연결 검사", subtitle: "공급자 검증 · capability evidence", group: "거버넌스", icon: "plug" },
  { id: "ALERTS", path: "/alerts", title: "실시간 알림", subtitle: "감지된 이벤트만 · 타임라인", group: "거버넌스", icon: "bell" },
  { id: "REL_GATE", path: "/release-gate", title: "출시 게이트", subtitle: "Q001~Q041 PASS/FAIL/BLOCKED", group: "거버넌스", icon: "gate", ownerOnly: true },
]);

export const SCREEN_BY_ID: Record<ScreenId, ScreenMeta> = SCREENS.reduce((acc, screen) => {
  acc[screen.id] = screen;
  return acc;
}, {} as Record<ScreenId, ScreenMeta>);

export interface RouteMatch {
  screen: ScreenMeta;
  params: Record<string, string>;
}

export function matchRoute(hashPath: string): RouteMatch {
  const clean = (hashPath.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
  const segments = clean.split("/").filter(Boolean);
  for (const screen of SCREENS) {
    const pattern = screen.path.split("/").filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const p = pattern[i]!;
      const s = segments[i]!;
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { screen, params };
  }
  return { screen: SCREEN_BY_ID.MAINCHAT, params: {} };
}

export function hrefFor(screen: ScreenMeta, params: Record<string, string> = {}): string {
  const path = screen.path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? encodeURIComponent(params[seg.slice(1)] ?? "demo-project") : seg))
    .join("/");
  return `#${path}`;
}

export const NAV_GROUPS: readonly NavGroup[] = ["시작", "대화", "프로젝트", "코드·배포", "거버넌스"];
