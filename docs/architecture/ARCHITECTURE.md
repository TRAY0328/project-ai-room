# PROJECT AI ROOM — 아키텍처

이 문서는 "무엇이 원본인가"와 "어디서 실패를 격리하는가"만 다룬다. 기능 목록은 스펙 00~57장과 `api_catalog.json`이 원본이다.

## 1. 데이터 권위 (한 곳만 원본)

| 데이터 | 원본 | 이 저장소에서의 표현 |
|---|---|---|
| 메시지·작업·승인·감사 | **D1** | `messages`, `message_versions`, `tasks`, `approvals`, `audit_events` |
| 메시지 순서 | **Room Durable Object의 `room_seq`** | `messages.room_seq UNIQUE(room_id, room_seq)` |
| 커밋·PR·CI 결과 | **GitHub** | `git_revisions`, `git_pull_requests`, `ci_runs`는 GitHub 상태의 사본이며 `UNKNOWN`을 허용 |
| 파일 본문·스냅샷·아티팩트 바이트 | **R2** | `files.r2_key`, `document_snapshots.r2_key`, `artifacts.r2_key` (현재 R2 미활성 → 차단) |
| Yjs 편집 상태 | **collab-do 메모리 + 스냅샷** | `document_update_refs` (커밋의 원본은 아님) |
| 문서의 최종본 | **Git 트리** | `documents`/`document_snapshots`는 게시 준비 상태 |

규칙: WebSocket 전달 순서는 최종 상태의 원본이 아니다. 클라이언트는 seq gap을 감지하면 HTTPS로 재동기화한다(`contracts/events.ts`의 `planResync`).

## 2. 서비스 경계와 실패 격리 (스펙 31.2)

| 경계 | 책임 | 직접 하지 않는 일 | 실패 시 |
|---|---|---|---|
| gateway-worker | 인증·인가·유효성·조정·조회 | 장시간 빌드 | 정확한 오류·재시도 표시, 성공 위장 금지 |
| D1 | 정합적 메타데이터 | R2 바이너리 대체 저장 | 쓰기 실패 시 성공 응답 금지 |
| room-do | seq 부여·실시간 연결 | 전체 메시지 영구 원본 | D1 재동기화 유도 |
| collab-do | Yjs 중계·편집 상태 | Git 커밋 단일 권위 | 스냅샷 재로드·충돌 처리 |
| R2 | 파일·로그·스냅샷·아티팩트 | 자체 권한 판정 | 다운로드 중단·재시도 안내 |
| provider-adapters | 공식 허용 범위의 AI 통신 | 다른 공급자 가장 | `BLOCKED` 표시, 큐 보존 |
| github-integration | 웹훅 진위·PR/Checks 연동 | AI 추론 제공 | 토큰 갱신·연결 경고 |
| job-orchestrator | 임대·상태머신·예산 가드 | 모델 실행·상시 서버 | 실패·한도 대기 |
| clients | 화면·입력·오프라인 표시 | 서버 권한 판정·키 보관 | 캐시 읽기·전송 재시도 |

## 3. 요청 파이프라인

```
요청
 → request_id 확정(없으면 발급)
 → route match (78개 카탈로그, 미매칭 404)
 → 인증 (401 AUTH_REQUIRED / AUTH_EXPIRED / AUTH_REVOKED)
 → 인가 (contracts.evaluate, 기본 거부; 방·프로젝트 멤버십과 승인 확인)
 → 입력 검증 (Zod; 본문 크기·페이지 한도)
 → 멱등성(POST) / If-Match revision(PATCH·DELETE)
 → 핸들러
 → 응답 {ok,data,request_id,server_time}
```

인가를 본문 파싱보다 먼저 수행한다. 권한 없는 호출자가 리소스 존재 여부를 역추적하지 못하게 하기 위해서다.

## 4. 실시간 프로토콜

1. HTTPS로 세션·멤버십 재검증 → 단기 WS 티켓 발급(방/프로젝트/권한/만료/nonce 결박).
2. `HELLO(last_seen_seq, client_capabilities)`.
3. 서버는 `HELLO_OK`(리플레이) 또는 `SNAPSHOT_REQUIRED`(gap 초과).
4. `EVENT`는 D1 커밋 이후에만 발행된다(예약 후 유실은 gap으로 탐지).
5. 권한 회수 시 `CLOSE(revoked)`로 즉시 종료하고 캐시 이벤트를 더 보내지 않는다.

## 5. 불변식이 코드·DB에 놓인 위치

| 불변식 | 위치 |
|---|---|
| 소유자는 1명, AI는 플랫폼 관리자 불가 | `trg_single_owner`, `trg_agent_never_platform_admin*`, `permissions.ts` |
| 메시지 author 불변·수정은 새 버전 | `trg_message_author_immutable`, `trg_message_revision`, `trg_message_version_immutable` |
| `room_seq` 중복 불가 | `UNIQUE(room_id, room_seq)` |
| DONE은 검증 증거 필수 | `trg_task_done_requires_evidence`, `task_evidence.verification_state` |
| VERIFIED 아티팩트는 해시 일치 증거 필수 | `trg_artifact_verified_needs_proof`, `artifact_verifications` |
| 승인은 대상·SHA·digest·만료에 결박, 변경 시 무효 | `approvals` 컬럼 + `trg_approval_invalidate_on_change` + `approvalStillValid()` |
| 공급자 VERIFIED는 자기신고 불가 | `capability_proofs` CHECK, `evaluateRequiredRoster()` |
| 삭제는 검색·다운로드 링크로 전파 | `trg_message_tombstone_on_delete`, `search_tombstones`, `download_events` |
| 감사 로그 append-only | `trg_audit_no_update`, `trg_audit_no_delete` |
| 미측정 사용량을 0으로 취급하지 않음 | `usage_budgets` CHECK, `canDispatch()` |

## 6. 저장 파티셔닝 전략 (스펙 39.1-39.2)

- D1은 정규화된 메타데이터·관계·권한·FTS만 담는다. 큰 JSON 한 컬럼으로 모든 테이블을 대체하지 않는다.
- D1은 단일 SQLite 데이터베이스이므로 쓰기 처리량이 제한된다. 방별 seq는 DO에서, 집계는 `project_events`로 비동기화한다.
- `PRAGMA foreign_keys`는 D1에서 문장별로 강제되며, 이 마이그레이션은 FK 선언 순서(부모 → 자식)를 지켜 적용 실패를 막는다.
- FTS5는 `memory_fts`, `message_fts` 두 개만 두고, 본문 원본은 각각 `memory_records.body_text`, `message_versions.body_plain_text`다. 외부 검색 엔진을 추가하지 않는다(무료 한도).

## 7. 배포 형상 (다음 단계)

```
Cloudflare
 ├── Worker: gateway (fetch)            ── /api/v1/*
 ├── Durable Object: Room               ── 방별 seq/WS
 ├── Durable Object: Document           ── Yjs 중계
 ├── D1: ai_room (마이그레이션 0001)
 └── R2: ai-room-assets (미활성 → 차단)
GitHub
 ├── App 설치(예정)                     ── webhook, checks
 └── Actions: verify / build-web / build-windows / build-android / security
```

GitHub Actions는 **배치 실행기**이며 상시 AI 세션이 아니다. 모델 호출 권한을 대신하지 않는다(스펙 31.1).
