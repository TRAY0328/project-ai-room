/**
 * The 108 content features from `content_feature_catalog.json`, one row each.
 *
 * Generated from the catalog fixture (sha256 in CATALOG_SHA256). Every row names
 * where the feature lives and which surface proves it:
 *  - "blocks"  → packages/message-blocks/test/*.test.mjs
 *  - "message" → same harness, on the message envelope
 *  - "app"     → apps/web component tests via src/lib/app-feature-manifest.ts
 */
export type FeatureSurface = "blocks" | "message" | "app";
export type FeatureGroup = "작성·형식" | "참조·조직" | "파일·미디어" | "개발·작업" | "협업·소셜" | "구조화 자료";

export interface FeatureRow {
  readonly id: string;
  readonly group: FeatureGroup;
  readonly label: string;
  readonly surface: FeatureSurface;
  /** Module or screen that implements the behaviour. */
  readonly where: string;
}

export const CATALOG_SHA256 = "3bc8385b1a6cc8f7b22486c2d0e18b8ed8422e4056299cb9c5475864dd337ca0";
export const FEATURES: readonly FeatureRow[] = Object.freeze([
  { id: "F-001", group: "작성·형식", label: "일반 텍스트", surface: "blocks", where: "text" },
  { id: "F-002", group: "작성·형식", label: "단락 나누기", surface: "blocks", where: "markdown paragraph" },
  { id: "F-003", group: "작성·형식", label: "굵게", surface: "blocks", where: "inline strong" },
  { id: "F-004", group: "작성·형식", label: "기울임", surface: "blocks", where: "inline em" },
  { id: "F-005", group: "작성·형식", label: "밑줄", surface: "blocks", where: "inline u" },
  { id: "F-006", group: "작성·형식", label: "취소선", surface: "blocks", where: "inline s" },
  { id: "F-007", group: "작성·형식", label: "인라인 코드", surface: "blocks", where: "inline code" },
  { id: "F-008", group: "작성·형식", label: "다중 언어 코드블록", surface: "blocks", where: "code block" },
  { id: "F-009", group: "작성·형식", label: "제목 1~3", surface: "blocks", where: "markdown heading" },
  { id: "F-010", group: "작성·형식", label: "순서 있는 목록", surface: "blocks", where: "ordered list" },
  { id: "F-011", group: "작성·형식", label: "순서 없는 목록", surface: "blocks", where: "unordered list" },
  { id: "F-012", group: "작성·형식", label: "체크리스트", surface: "blocks", where: "task list" },
  { id: "F-013", group: "작성·형식", label: "인용 블록", surface: "blocks", where: "blockquote" },
  { id: "F-014", group: "작성·형식", label: "구분선", surface: "blocks", where: "hr" },
  { id: "F-015", group: "작성·형식", label: "하이퍼링크", surface: "blocks", where: "safe link" },
  { id: "F-016", group: "작성·형식", label: "Markdown 소스 보기", surface: "app", where: "ComposerScreen" },
  { id: "F-017", group: "작성·형식", label: "Markdown 미리보기", surface: "app", where: "ComposerScreen" },
  { id: "F-018", group: "작성·형식", label: "수학 수식", surface: "blocks", where: "math source" },
  { id: "F-019", group: "작성·형식", label: "자동 줄바꿈", surface: "blocks", where: "line break" },
  { id: "F-020", group: "작성·형식", label: "초안 저장", surface: "app", where: "ComposerScreen" },
  { id: "F-021", group: "참조·조직", label: "AI 멘션", surface: "app", where: "ComposerScreen" },
  { id: "F-022", group: "참조·조직", label: "사용자 멘션", surface: "app", where: "ComposerScreen" },
  { id: "F-023", group: "참조·조직", label: "메시지 답글", surface: "app", where: "MainChatScreen" },
  { id: "F-024", group: "참조·조직", label: "스레드 생성", surface: "app", where: "MainChatScreen" },
  { id: "F-025", group: "참조·조직", label: "스레드 알림", surface: "app", where: "MainChatScreen" },
  { id: "F-026", group: "참조·조직", label: "대화 인용", surface: "blocks", where: "quote block" },
  { id: "F-027", group: "참조·조직", label: "메시지 고정", surface: "app", where: "RoomDetailScreen" },
  { id: "F-028", group: "참조·조직", label: "북마크", surface: "app", where: "MainChatScreen" },
  { id: "F-029", group: "참조·조직", label: "메시지 공유 참조", surface: "app", where: "MainChatScreen" },
  { id: "F-030", group: "참조·조직", label: "메시지 링크 복사", surface: "app", where: "MainChatScreen" },
  { id: "F-031", group: "참조·조직", label: "프로젝트 링크", surface: "blocks", where: "project_ref" },
  { id: "F-032", group: "참조·조직", label: "작업 ID 참조", surface: "blocks", where: "task_ref" },
  { id: "F-033", group: "참조·조직", label: "파일 참조", surface: "blocks", where: "file_ref" },
  { id: "F-034", group: "참조·조직", label: "코드 줄 링크", surface: "blocks", where: "code start_line" },
  { id: "F-035", group: "참조·조직", label: "원본 출처 표시", surface: "blocks", where: "source footer" },
  { id: "F-036", group: "파일·미디어", label: "이미지 첨부", surface: "blocks", where: "image_ref" },
  { id: "F-037", group: "파일·미디어", label: "여러 이미지 묶음", surface: "message", where: "grouped image_ref" },
  { id: "F-038", group: "파일·미디어", label: "원본 이미지 열기", surface: "blocks", where: "image link" },
  { id: "F-039", group: "파일·미디어", label: "이미지 대체 텍스트", surface: "blocks", where: "image alt" },
  { id: "F-040", group: "파일·미디어", label: "PDF 첨부", surface: "blocks", where: "file_ref pdf" },
  { id: "F-041", group: "파일·미디어", label: "PDF 안전 미리보기", surface: "app", where: "FilesScreen" },
  { id: "F-042", group: "파일·미디어", label: "TXT 파일", surface: "blocks", where: "file_ref preview" },
  { id: "F-043", group: "파일·미디어", label: "Markdown 파일", surface: "blocks", where: "file_ref preview" },
  { id: "F-044", group: "파일·미디어", label: "JSON 미리보기", surface: "blocks", where: "json block" },
  { id: "F-045", group: "파일·미디어", label: "CSV 미리보기", surface: "blocks", where: "csv table" },
  { id: "F-046", group: "파일·미디어", label: "ZIP 첨부", surface: "blocks", where: "file_ref zip" },
  { id: "F-047", group: "파일·미디어", label: "오디오 첨부", surface: "blocks", where: "audio_ref" },
  { id: "F-048", group: "파일·미디어", label: "비디오 첨부", surface: "blocks", where: "video_ref" },
  { id: "F-049", group: "파일·미디어", label: "업로드 진행률", surface: "app", where: "FilesScreen" },
  { id: "F-050", group: "파일·미디어", label: "이어올리기", surface: "app", where: "FilesScreen" },
  { id: "F-051", group: "파일·미디어", label: "SHA-256 표시", surface: "blocks", where: "hash row" },
  { id: "F-052", group: "파일·미디어", label: "다운로드 진행", surface: "app", where: "FilesScreen" },
  { id: "F-053", group: "파일·미디어", label: "권한형 공유 다운로드", surface: "app", where: "FilesScreen" },
  { id: "F-054", group: "개발·작업", label: "코드 구문 강조", surface: "blocks", where: "highlight" },
  { id: "F-055", group: "개발·작업", label: "코드 복사", surface: "app", where: "CodeActions" },
  { id: "F-056", group: "개발·작업", label: "코드 다운로드", surface: "app", where: "CodeActions" },
  { id: "F-057", group: "개발·작업", label: "Git Diff 표시", surface: "blocks", where: "diff block" },
  { id: "F-058", group: "개발·작업", label: "Diff 줄 댓글", surface: "app", where: "ReviewScreen" },
  { id: "F-059", group: "개발·작업", label: "PR 참조", surface: "blocks", where: "pr_ref" },
  { id: "F-060", group: "개발·작업", label: "커밋 SHA 참조", surface: "blocks", where: "commit_ref" },
  { id: "F-061", group: "개발·작업", label: "실행 로그 스트림", surface: "blocks", where: "terminal_log" },
  { id: "F-062", group: "개발·작업", label: "빌드 상태 블록", surface: "blocks", where: "status block" },
  { id: "F-063", group: "개발·작업", label: "테스트 결과 블록", surface: "blocks", where: "test_result" },
  { id: "F-064", group: "개발·작업", label: "테스트 실패 위치 링크", surface: "blocks", where: "failure link" },
  { id: "F-065", group: "개발·작업", label: "터미널 세션 참조", surface: "blocks", where: "terminal job ref" },
  { id: "F-066", group: "개발·작업", label: "실행 취소 메시지", surface: "app", where: "CIScreen" },
  { id: "F-067", group: "개발·작업", label: "작업 카드", surface: "blocks", where: "task_ref" },
  { id: "F-068", group: "개발·작업", label: "작업 담당자 변경 제안", surface: "app", where: "TaskBoardScreen" },
  { id: "F-069", group: "개발·작업", label: "작업 의존성", surface: "app", where: "DependenciesScreen" },
  { id: "F-070", group: "개발·작업", label: "승인 요청 블록", surface: "blocks", where: "approval pending" },
  { id: "F-071", group: "개발·작업", label: "승인 결과 블록", surface: "blocks", where: "approval decided" },
  { id: "F-072", group: "개발·작업", label: "아티팩트 카드", surface: "blocks", where: "artifact_ref" },
  { id: "F-073", group: "개발·작업", label: "해시 검증 상태", surface: "blocks", where: "artifact hash status" },
  { id: "F-074", group: "협업·소셜", label: "이모지 반응", surface: "app", where: "Reactions" },
  { id: "F-075", group: "협업·소셜", label: "사용자 정의 이모지", surface: "app", where: "Reactions" },
  { id: "F-076", group: "협업·소셜", label: "리액션 취소", surface: "app", where: "Reactions" },
  { id: "F-077", group: "협업·소셜", label: "리액션 집계", surface: "app", where: "Reactions" },
  { id: "F-078", group: "협업·소셜", label: "입력 중 상태", surface: "app", where: "ComposerScreen" },
  { id: "F-079", group: "협업·소셜", label: "실제 전달 확인", surface: "message", where: "delivery state" },
  { id: "F-080", group: "협업·소셜", label: "읽음 확인(지원시)", surface: "app", where: "MainChatScreen" },
  { id: "F-081", group: "협업·소셜", label: "읽지 않은 메시지", surface: "app", where: "RoomsScreen" },
  { id: "F-082", group: "협업·소셜", label: "중요 메시지 표시", surface: "app", where: "MainChatScreen" },
  { id: "F-083", group: "협업·소셜", label: "알림 음소거", surface: "app", where: "AlertsScreen" },
  { id: "F-084", group: "협업·소셜", label: "알림 우선도", surface: "app", where: "AlertsScreen" },
  { id: "F-085", group: "협업·소셜", label: "빠른 검색", surface: "app", where: "SearchScreen" },
  { id: "F-086", group: "협업·소셜", label: "검색 필터", surface: "app", where: "SearchScreen" },
  { id: "F-087", group: "협업·소셜", label: "검색 결과로 이동", surface: "app", where: "SearchScreen" },
  { id: "F-088", group: "협업·소셜", label: "편집 기록", surface: "message", where: "version chain" },
  { id: "F-089", group: "협업·소셜", label: "삭제 tombstone", surface: "message", where: "tombstone" },
  { id: "F-090", group: "협업·소셜", label: "삭제 복원", surface: "app", where: "RoomDetailScreen" },
  { id: "F-091", group: "협업·소셜", label: "중복 전송 차단", surface: "app", where: "ComposerScreen" },
  { id: "F-092", group: "협업·소셜", label: "낮은 네트워크 복구", surface: "app", where: "Outbox" },
  { id: "F-093", group: "협업·소셜", label: "시간대별 표시", surface: "message", where: "utc + relative" },
  { id: "F-094", group: "구조화 자료", label: "표 블록", surface: "blocks", where: "table block" },
  { id: "F-095", group: "구조화 자료", label: "차트 참조", surface: "blocks", where: "chart svg" },
  { id: "F-096", group: "구조화 자료", label: "투표 블록", surface: "blocks", where: "poll" },
  { id: "F-097", group: "구조화 자료", label: "투표 결과", surface: "blocks", where: "poll results" },
  { id: "F-098", group: "구조화 자료", label: "설문 항목", surface: "blocks", where: "poll options" },
  { id: "F-099", group: "구조화 자료", label: "상태 배지 데이터", surface: "blocks", where: "status badge" },
  { id: "F-100", group: "구조화 자료", label: "키-값 데이터 카드", surface: "blocks", where: "kv table" },
  { id: "F-101", group: "구조화 자료", label: "타임라인 이벤트", surface: "app", where: "AlertsScreen" },
  { id: "F-102", group: "구조화 자료", label: "코드 리뷰 체크리스트", surface: "app", where: "ReviewScreen" },
  { id: "F-103", group: "구조화 자료", label: "출처 인용 블록", surface: "blocks", where: "quote source" },
  { id: "F-104", group: "구조화 자료", label: "위험 경고 블록", surface: "blocks", where: "callout risk" },
  { id: "F-105", group: "구조화 자료", label: "메모리 참조 블록", surface: "blocks", where: "memory_ref" },
  { id: "F-106", group: "구조화 자료", label: "프로젝트 목표 카드", surface: "blocks", where: "project_ref" },
  { id: "F-107", group: "구조화 자료", label: "활동 요약 블록", surface: "blocks", where: "activity summary" },
  { id: "F-108", group: "구조화 자료", label: "변경 전후 비교 블록", surface: "blocks", where: "before/after diff" },
]);
export const FEATURE_COUNT = FEATURES.length;

export function featureById(id: string): FeatureRow | undefined {
  return FEATURES.find((f) => f.id === id);
}

export function featuresBySurface(surface: FeatureSurface): readonly FeatureRow[] {
  return FEATURES.filter((f) => f.surface === surface);
}
