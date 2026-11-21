# 메시지·콘텐츠 기능 인벤토리 (108)

스펙 10.2는 `content_feature_catalog.json`의 108개 기능을 ID·UI·API·테스트 증거에 연결해 증명하도록 요구한다. 이 문서는 그 대응표이며, 표의 모든 행은 코드에서 실제로 실행되는 증거를 가진다.

- 카탈로그 스냅샷: `packages/message-blocks/test/fixtures/content_feature_catalog.json`
- 카탈로그 SHA-256: `3bc8385b1a6cc8f7b22486c2d0e18b8ed8422e4056299cb9c5475864dd337ca0`
- 렌더러 증명: `packages/message-blocks/test/proofs.mjs` (블록 62 + 메시지 5 = 67개, `node --test`)
- UI 증명: `apps/web/src/__tests__/app-features.test.tsx` (앱 41개, `data-testid` 실측)
- 커버리지 강제: `packages/message-blocks/test/features.test.mjs` — 108행/중복/순서/증명 실행/앱 매니페스트를 모두 검사

| ID | 그룹 | 기능 | 표면 | 구현 위치 | 증거(테스트) |
|---|---|---|---|---|---|
| F-001 | 작성·형식 | 일반 텍스트 | blocks | blocks.ts · text | proofs.mjs F-001 (렌더러) |
| F-002 | 작성·형식 | 단락 나누기 | blocks | blocks.ts · markdown paragraph | proofs.mjs F-002 (렌더러) |
| F-003 | 작성·형식 | 굵게 | blocks | blocks.ts · inline strong | proofs.mjs F-003 (렌더러) |
| F-004 | 작성·형식 | 기울임 | blocks | blocks.ts · inline em | proofs.mjs F-004 (렌더러) |
| F-005 | 작성·형식 | 밑줄 | blocks | blocks.ts · inline u | proofs.mjs F-005 (렌더러) |
| F-006 | 작성·형식 | 취소선 | blocks | blocks.ts · inline s | proofs.mjs F-006 (렌더러) |
| F-007 | 작성·형식 | 인라인 코드 | blocks | blocks.ts · inline code | proofs.mjs F-007 (렌더러) |
| F-008 | 작성·형식 | 다중 언어 코드블록 | blocks | blocks.ts · code block | proofs.mjs F-008 (렌더러) |
| F-009 | 작성·형식 | 제목 1~3 | blocks | blocks.ts · markdown heading | proofs.mjs F-009 (렌더러) |
| F-010 | 작성·형식 | 순서 있는 목록 | blocks | blocks.ts · ordered list | proofs.mjs F-010 (렌더러) |
| F-011 | 작성·형식 | 순서 없는 목록 | blocks | blocks.ts · unordered list | proofs.mjs F-011 (렌더러) |
| F-012 | 작성·형식 | 체크리스트 | blocks | blocks.ts · task list | proofs.mjs F-012 (렌더러) |
| F-013 | 작성·형식 | 인용 블록 | blocks | blocks.ts · blockquote | proofs.mjs F-013 (렌더러) |
| F-014 | 작성·형식 | 구분선 | blocks | blocks.ts · hr | proofs.mjs F-014 (렌더러) |
| F-015 | 작성·형식 | 하이퍼링크 | blocks | blocks.ts · safe link | proofs.mjs F-015 (렌더러) |
| F-016 | 작성·형식 | Markdown 소스 보기 | app | Composer · MAINCHAT | apps/web vitest `composer-source-toggle` |
| F-017 | 작성·형식 | Markdown 미리보기 | app | Composer · MAINCHAT | apps/web vitest `composer-preview` |
| F-018 | 작성·형식 | 수학 수식 | blocks | blocks.ts · math source | proofs.mjs F-018 (렌더러) |
| F-019 | 작성·형식 | 자동 줄바꿈 | blocks | blocks.ts · line break | proofs.mjs F-019 (렌더러) |
| F-020 | 작성·형식 | 초안 저장 | app | Composer · MAINCHAT | apps/web vitest `composer-draft-state` |
| F-021 | 참조·조직 | AI 멘션 | app | Composer · MAINCHAT | apps/web vitest `composer-mention-ai` |
| F-022 | 참조·조직 | 사용자 멘션 | app | Composer · MAINCHAT | apps/web vitest `composer-mention-user` |
| F-023 | 참조·조직 | 메시지 답글 | app | MessageActions · MAINCHAT | apps/web vitest `message-reply` |
| F-024 | 참조·조직 | 스레드 생성 | app | MessageActions · MAINCHAT | apps/web vitest `message-thread-create` |
| F-025 | 참조·조직 | 스레드 알림 | app | ThreadPanel · MAINCHAT | apps/web vitest `thread-notify-toggle` |
| F-026 | 참조·조직 | 대화 인용 | blocks | blocks.ts · quote block | proofs.mjs F-026 (렌더러) |
| F-027 | 참조·조직 | 메시지 고정 | app | RoomDetailScreen · ROOMDETAIL | apps/web vitest `room-pin-list` |
| F-028 | 참조·조직 | 북마크 | app | MessageActions · MAINCHAT | apps/web vitest `message-bookmark` |
| F-029 | 참조·조직 | 메시지 공유 참조 | app | MessageActions · MAINCHAT | apps/web vitest `message-share-ref` |
| F-030 | 참조·조직 | 메시지 링크 복사 | app | MessageActions · MAINCHAT | apps/web vitest `message-copy-link` |
| F-031 | 참조·조직 | 프로젝트 링크 | blocks | blocks.ts · project_ref | proofs.mjs F-031 (렌더러) |
| F-032 | 참조·조직 | 작업 ID 참조 | blocks | blocks.ts · task_ref | proofs.mjs F-032 (렌더러) |
| F-033 | 참조·조직 | 파일 참조 | blocks | blocks.ts · file_ref | proofs.mjs F-033 (렌더러) |
| F-034 | 참조·조직 | 코드 줄 링크 | blocks | blocks.ts · code start_line | proofs.mjs F-034 (렌더러) |
| F-035 | 참조·조직 | 원본 출처 표시 | blocks | blocks.ts · source footer | proofs.mjs F-035 (렌더러) |
| F-036 | 파일·미디어 | 이미지 첨부 | blocks | blocks.ts · image_ref | proofs.mjs F-036 (렌더러) |
| F-037 | 파일·미디어 | 여러 이미지 묶음 | message | message.ts · grouped image_ref | proofs.mjs F-037 (메시지 레벨) |
| F-038 | 파일·미디어 | 원본 이미지 열기 | blocks | blocks.ts · image link | proofs.mjs F-038 (렌더러) |
| F-039 | 파일·미디어 | 이미지 대체 텍스트 | blocks | blocks.ts · image alt | proofs.mjs F-039 (렌더러) |
| F-040 | 파일·미디어 | PDF 첨부 | blocks | blocks.ts · file_ref pdf | proofs.mjs F-040 (렌더러) |
| F-041 | 파일·미디어 | PDF 안전 미리보기 | app | FilesScreen · FILES | apps/web vitest `file-pdf-preview` |
| F-042 | 파일·미디어 | TXT 파일 | blocks | blocks.ts · file_ref preview | proofs.mjs F-042 (렌더러) |
| F-043 | 파일·미디어 | Markdown 파일 | blocks | blocks.ts · file_ref preview | proofs.mjs F-043 (렌더러) |
| F-044 | 파일·미디어 | JSON 미리보기 | blocks | blocks.ts · json block | proofs.mjs F-044 (렌더러) |
| F-045 | 파일·미디어 | CSV 미리보기 | blocks | blocks.ts · csv table | proofs.mjs F-045 (렌더러) |
| F-046 | 파일·미디어 | ZIP 첨부 | blocks | blocks.ts · file_ref zip | proofs.mjs F-046 (렌더러) |
| F-047 | 파일·미디어 | 오디오 첨부 | blocks | blocks.ts · audio_ref | proofs.mjs F-047 (렌더러) |
| F-048 | 파일·미디어 | 비디오 첨부 | blocks | blocks.ts · video_ref | proofs.mjs F-048 (렌더러) |
| F-049 | 파일·미디어 | 업로드 진행률 | app | FileDropzone · FILES | apps/web vitest `upload-progress` |
| F-050 | 파일·미디어 | 이어올리기 | app | FileDropzone · FILES | apps/web vitest `upload-resume` |
| F-051 | 파일·미디어 | SHA-256 표시 | blocks | blocks.ts · hash row | proofs.mjs F-051 (렌더러) |
| F-052 | 파일·미디어 | 다운로드 진행 | app | FilesScreen · FILES | apps/web vitest `download-progress` |
| F-053 | 파일·미디어 | 권한형 공유 다운로드 | app | FilesScreen · FILES | apps/web vitest `permission-download` |
| F-054 | 개발·작업 | 코드 구문 강조 | blocks | blocks.ts · highlight | proofs.mjs F-054 (렌더러) |
| F-055 | 개발·작업 | 코드 복사 | app | CodeActions · MAINCHAT | apps/web vitest `code-copy` |
| F-056 | 개발·작업 | 코드 다운로드 | app | CodeActions · MAINCHAT | apps/web vitest `code-download` |
| F-057 | 개발·작업 | Git Diff 표시 | blocks | blocks.ts · diff block | proofs.mjs F-057 (렌더러) |
| F-058 | 개발·작업 | Diff 줄 댓글 | app | ReviewPanel · REVIEW | apps/web vitest `diff-line-comment` |
| F-059 | 개발·작업 | PR 참조 | blocks | blocks.ts · pr_ref | proofs.mjs F-059 (렌더러) |
| F-060 | 개발·작업 | 커밋 SHA 참조 | blocks | blocks.ts · commit_ref | proofs.mjs F-060 (렌더러) |
| F-061 | 개발·작업 | 실행 로그 스트림 | blocks | blocks.ts · terminal_log | proofs.mjs F-061 (렌더러) |
| F-062 | 개발·작업 | 빌드 상태 블록 | blocks | blocks.ts · status block | proofs.mjs F-062 (렌더러) |
| F-063 | 개발·작업 | 테스트 결과 블록 | blocks | blocks.ts · test_result | proofs.mjs F-063 (렌더러) |
| F-064 | 개발·작업 | 테스트 실패 위치 링크 | blocks | blocks.ts · failure link | proofs.mjs F-064 (렌더러) |
| F-065 | 개발·작업 | 터미널 세션 참조 | blocks | blocks.ts · terminal job ref | proofs.mjs F-065 (렌더러) |
| F-066 | 개발·작업 | 실행 취소 메시지 | app | CiScreen · CI | apps/web vitest `ci-undo-message` |
| F-067 | 개발·작업 | 작업 카드 | blocks | blocks.ts · task_ref | proofs.mjs F-067 (렌더러) |
| F-068 | 개발·작업 | 작업 담당자 변경 제안 | app | TaskBoardScreen · TASKBOARD | apps/web vitest `task-reassign-suggest` |
| F-069 | 개발·작업 | 작업 의존성 | app | DependenciesScreen · DEPENDENCIES | apps/web vitest `dependency-graph` |
| F-070 | 개발·작업 | 승인 요청 블록 | blocks | blocks.ts · approval pending | proofs.mjs F-070 (렌더러) |
| F-071 | 개발·작업 | 승인 결과 블록 | blocks | blocks.ts · approval decided | proofs.mjs F-071 (렌더러) |
| F-072 | 개발·작업 | 아티팩트 카드 | blocks | blocks.ts · artifact_ref | proofs.mjs F-072 (렌더러) |
| F-073 | 개발·작업 | 해시 검증 상태 | blocks | blocks.ts · artifact hash status | proofs.mjs F-073 (렌더러) |
| F-074 | 협업·소셜 | 이모지 반응 | app | Reactions · MAINCHAT | apps/web vitest `reaction-emoji` |
| F-075 | 협업·소셜 | 사용자 정의 이모지 | app | Reactions · MAINCHAT | apps/web vitest `reaction-custom` |
| F-076 | 협업·소셜 | 리액션 취소 | app | Reactions · MAINCHAT | apps/web vitest `reaction-remove` |
| F-077 | 협업·소셜 | 리액션 집계 | app | Reactions · MAINCHAT | apps/web vitest `reaction-count` |
| F-078 | 협업·소셜 | 입력 중 상태 | app | Composer · MAINCHAT | apps/web vitest `typing-indicator` |
| F-079 | 협업·소셜 | 실제 전달 확인 | message | message.ts · delivery state | proofs.mjs F-079 (메시지 레벨) |
| F-080 | 협업·소셜 | 읽음 확인(지원시) | app | MessageActions · MAINCHAT | apps/web vitest `message-read-receipt` |
| F-081 | 협업·소셜 | 읽지 않은 메시지 | app | RoomsScreen · ROOMS | apps/web vitest `room-unread` |
| F-082 | 협업·소셜 | 중요 메시지 표시 | app | MessageActions · MAINCHAT | apps/web vitest `message-important` |
| F-083 | 협업·소셜 | 알림 음소거 | app | AlertsScreen · ALERTS | apps/web vitest `alert-mute` |
| F-084 | 협업·소셜 | 알림 우선도 | app | AlertsScreen · ALERTS | apps/web vitest `alert-priority` |
| F-085 | 협업·소셜 | 빠른 검색 | app | CommandPalette · SEARCH | apps/web vitest `quick-search` |
| F-086 | 협업·소셜 | 검색 필터 | app | SearchScreen · SEARCH | apps/web vitest `search-filters` |
| F-087 | 협업·소셜 | 검색 결과로 이동 | app | SearchScreen · SEARCH | apps/web vitest `search-jump` |
| F-088 | 협업·소셜 | 편집 기록 | message | message.ts · version chain | proofs.mjs F-088 (메시지 레벨) |
| F-089 | 협업·소셜 | 삭제 tombstone | message | message.ts · tombstone | proofs.mjs F-089 (메시지 레벨) |
| F-090 | 협업·소셜 | 삭제 복원 | app | RoomDetailScreen · ROOMDETAIL | apps/web vitest `tombstone-restore` |
| F-091 | 협업·소셜 | 중복 전송 차단 | app | Composer · MAINCHAT | apps/web vitest `send-dedupe` |
| F-092 | 협업·소셜 | 낮은 네트워크 복구 | app | OutboxBanner · MAINCHAT | apps/web vitest `outbox-retry` |
| F-093 | 협업·소셜 | 시간대별 표시 | message | message.ts · utc + relative | proofs.mjs F-093 (메시지 레벨) |
| F-094 | 구조화 자료 | 표 블록 | blocks | blocks.ts · table block | proofs.mjs F-094 (렌더러) |
| F-095 | 구조화 자료 | 차트 참조 | blocks | blocks.ts · chart svg | proofs.mjs F-095 (렌더러) |
| F-096 | 구조화 자료 | 투표 블록 | blocks | blocks.ts · poll | proofs.mjs F-096 (렌더러) |
| F-097 | 구조화 자료 | 투표 결과 | blocks | blocks.ts · poll results | proofs.mjs F-097 (렌더러) |
| F-098 | 구조화 자료 | 설문 항목 | blocks | blocks.ts · poll options | proofs.mjs F-098 (렌더러) |
| F-099 | 구조화 자료 | 상태 배지 데이터 | blocks | blocks.ts · status badge | proofs.mjs F-099 (렌더러) |
| F-100 | 구조화 자료 | 키-값 데이터 카드 | blocks | blocks.ts · kv table | proofs.mjs F-100 (렌더러) |
| F-101 | 구조화 자료 | 타임라인 이벤트 | app | AlertsScreen · ALERTS | apps/web vitest `alert-timeline` |
| F-102 | 구조화 자료 | 코드 리뷰 체크리스트 | app | ReviewPanel · REVIEW | apps/web vitest `review-checklist` |
| F-103 | 구조화 자료 | 출처 인용 블록 | blocks | blocks.ts · quote source | proofs.mjs F-103 (렌더러) |
| F-104 | 구조화 자료 | 위험 경고 블록 | blocks | blocks.ts · callout risk | proofs.mjs F-104 (렌더러) |
| F-105 | 구조화 자료 | 메모리 참조 블록 | blocks | blocks.ts · memory_ref | proofs.mjs F-105 (렌더러) |
| F-106 | 구조화 자료 | 프로젝트 목표 카드 | blocks | blocks.ts · project_ref | proofs.mjs F-106 (렌더러) |
| F-107 | 구조화 자료 | 활동 요약 블록 | blocks | blocks.ts · activity summary | proofs.mjs F-107 (렌더러) |
| F-108 | 구조화 자료 | 변경 전후 비교 블록 | blocks | blocks.ts · before/after diff | proofs.mjs F-108 (렌더러) |

## 블록 타입 25종

`text, markdown, code, diff, terminal_log, test_result, file_ref, image_ref, video_ref, audio_ref, json, table, chart, task_ref, project_ref, commit_ref, pr_ref, approval_ref, poll, status, link_preview, callout, quote, memory_ref, artifact_ref`

모든 블록은 `packages/message-blocks/test/security.test.mjs`에서 악성 payload로 한 번씩 렌더링되며, 스크립트 실행·이벤트 핸들러·위험 URL이 살아남지 않는지 구조적으로 검사한다.
