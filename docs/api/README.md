# API 문서 상태

## 한눈에

| 산출물 | 원본 | 생성기 | 검증 |
|---|---|---|---|
| `docs/api/openapi.json` (OpenAPI 3.1.0) | `work/ai_room_pack/PROJECT_AI_ROOM/api_catalog.json` (78 엔드포인트) | `scripts/gen-openapi.mjs` | `node scripts/gen-openapi.mjs --check` |
| `packages/contracts/src/api-catalog.generated.ts` (타입 계약) | 같은 카탈로그 | `scripts/gen-api-contracts.mjs` | `node scripts/verify-contracts.mjs` |
| 오류 코드 26종 | `packages/contracts/src/errors.ts` | — | `openapi.json`의 `x-ai-room-error-codes` |

## `openapi.json`이 담는 것

- **78개 오퍼레이션 / 68개 경로**: 카탈로그와 1:1. 카탈로그에 없는 경로는 넣지 않는다.
- **경로 접두**: 서버 URL이 `/api`이고 각 경로는 `/v1/...`이다(스펙 19.1의 `/api/v1`과 동일한 결과).
- **인증**: `ownerSession`(쿠키), `agentKey`(Bearer `airo_sk_…`), `bootstrapToken`, `inviteSecret`, `wsTicket` 5종. 오퍼레이션마다 `security`가 다르다.
- **요청·응답 스키마**: 117개 컴포넌트. `db/migrations/0001_initial.sql`의 컬럼과 `packages/contracts` 타입을 반영한 **초안**이다. 핸들러 구현 전에는 서버가 501을 반환할 수 있다.
- **오류**: 25개(스펙 19.4) + `VALIDATION_FAILED`(문서화된 확장) = 26개. 모든 실패는 `{ok:false,error:{code,message,retryable,details}}` 봉투다.
- **확장 필드**:
  - `x-ai-room-auth`, `x-ai-room-mutating`, `x-ai-room-idempotency-key` — 계약 생성기와 동일한 파생값. 생성기가 두 값이 다르면 실패한다.
  - `x-ai-room-permission-action` — `packages/permissions` `ENDPOINT_ACTIONS`의 액션. 78/78 매핑.
  - `x-ai-room-test-ids` — 이 엔드포인트를 수용하는 QA 매트릭스 항목. 테스트 없는 엔드포인트가 보이게 하려는 장치다.
  - `x-ai-room-websocket` — OpenAPI가 표현하지 못하는 WS 계약(19.3): 티켓, HELLO, 재생/스냅샷, 권한 회수 시 즉시 종료, D1 저장 후 브로드캐스트.

## 검증 결과 (실제)

```
$ node scripts/gen-openapi.mjs --check
OPENAPI IN SYNC: docs/api/openapi.json (68 paths, 78 operations, contract 2026-11-21.1)

$ npx @redocly/cli@1 lint docs/api/openapi.json
Woohoo! Your API description is valid. 🎉
You have 11 warnings.   # no-unused-components (WS 확장에서 참조하는 스키마 포함)
```

생성기 자체 검사(외부 도구 없이):

- `$ref` 전부 해석, 경로 템플릿 파라미터 정의 일치, path 파라미터 `required:true`
- `operationId` 고유 78개, 모든 오퍼레이션에 `tags`·`summary`·`responses`
- GET에 requestBody 없음, 응답 상태 코드 형식 유효
- 카탈로그 78 ↔ 문서 78 양방향 일치 (`x-ai-room-endpoint-count`도 확인)
- `packages/contracts` 미러와 `operationId`·`auth`·`mutating`·`idempotency` 대조
- `packages/permissions`에 모든 오퍼레이션의 권한 액션이 존재

## 알려진 차이 (정직하게 남긴다)

1. **헬스 엔드포인트**: 스펙 19.2는 `GET /v1/health/live`, `/ready`를 요구한다. 게이트웨이는 두 경로를 **실제로 구현했지만**(`services/gateway-worker/src/extensions.ts`) `api_catalog.json` 78개에는 없으므로 이 문서에는 없다. 카탈로그에 추가되면 `SCHEMAS_BY_ENDPOINT`에 스키마를 넣고 재생성한다.
2. **카탈로그 밖 구현 경로(확장 23개)**: 아래 경로는 구현돼 있지만 카탈로그에 없어 OpenAPI에 없다. 계약의 정본은 카탈로그이므로, 공식 계약으로 만들려면 **카탈로그 → 생성기 → 코드** 순서로 등록해야 한다.
   - `GET /v1/health/live`, `GET /v1/health/ready`
   - `POST /v1/rooms/{roomId}/ws-ticket`, `GET /v1/rooms/{roomId}/events`, `GET /v1/rooms/{roomId}/presence`
   - `PUT /v1/files/uploads/{uploadId}/content`, `GET /v1/files/{fileId}/content`, `POST /v1/files/{assetId}/scan-result`
   - `GET /v1/artifacts/{artifactId}/content`
   - `POST /v1/messages/{messageId}/receipts`, `GET /v1/messages/{messageId}`
   - `DELETE /v1/agents/{agentId}/credentials`, `DELETE /v1/memories/{memoryId}`
   - `POST /v1/admin/emergency-resume` (스펙 19.2의 `/v1/admin/resume`과 이름이 다르다)
   - `POST /v1/admin/agent-invites`, `POST /v1/admin/main-room`, `POST /v1/admin/usage-budgets`, `GET /v1/admin/projects/{projectId}/metrics`
   - `POST /v1/projects/{projectId}/members`, `POST /v1/projects/{projectId}/repositories`, `POST /v1/projects/{projectId}/documents`, `POST /v1/projects/{projectId}/artifacts`, `POST /v1/tasks/{taskId}/evidence`
3. **WebSocket**: OpenAPI는 소켓을 표현하지 못하므로 `x-ai-room-websocket` 확장에 계약을 적었다. 핸드셰이크는 `ws-ticket` 확장 경로를 쓴다.
4. **스키마는 초안**: 요청/응답 필드는 DB·계약에서 도출했지만, 모든 핸들러가 구현된 뒤 실측으로 다시 맞춰야 한다.

## 규칙

1. 경로·메서드를 바꾸려면 **카탈로그 → 계약 생성기 → OpenAPI 생성기 → 코드** 순서로 바꾼다.
2. `openapi.json`을 손으로 고치지 않는다. `node scripts/gen-openapi.mjs`로 다시 만든다.
3. 카탈로그에 엔드포인트를 추가하면 `SCHEMAS_BY_ENDPOINT`에 요청·응답·테스트 ID를 넣는다. 빠지면 생성이 **거부**된다(조용히 기본값으로 나가지 않는다).
4. 모든 변경 요청은 인증 → 인가 → 검증 → 멱등성/리비전 검사 순서를 지킨다.
5. 성공·실패 모두 `request_id`를 포함하고, 내부 스택·SQL·비밀은 응답에 넣지 않는다.
