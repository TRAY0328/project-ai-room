# 3단계 검증 로그 (실행 그대로)

- 실행일: 2026-11-21 (KST), UTC 03:52~04:05
- 작업 디렉터리: `/workspace/project-ai-room`
- 도구: node v22.20.0, npm 10.9.3, TypeScript 5.9.3, zod 4.6.7, SQLite 3.50.4 (`node:sqlite`)
- 원칙: 아래 숫자는 모두 실제 명령 출력이다. 실행하지 않은 것은 "미실행"으로 적었다.

## 1. 타입체크 / 클린 빌드

```
$ npx tsc -b tsconfig.build.json
typecheck exit=0

$ rm -rf packages/contracts/dist services/*/dist
$ npx tsc -b tsconfig.build.json
force exit=0
```

대상: `packages/contracts` + `services/{gateway-worker,room-do,collab-do,provider-adapters,github-integration,job-orchestrator}` (7개 프로젝트, 프로젝트 레퍼런스 순서 강제).

## 2. 계약 교차검증

```
$ node scripts/verify-contracts.mjs
CONTRACT VERIFICATION PASSED
 - qa_matrix.json: 6 top-level entries
 - metrics_catalog.json: 50 top-level entries
 - content_feature_catalog.json: 6 top-level entries
 - security_cases.json: 50 top-level entries
 - ui_screen_registry.json: 28 top-level entries
 - contract version 2026-11-21.1
 - endpoints 78, error codes 26, events 45, permissions 57
 - providers 8, Q039 gate BLOCKED_EXTERNAL_DEPENDENCY (8 blockers)
```

검사 항목: 스펙 `api_catalog.json` ↔ 생성 코드 78개 1:1 일치, operationId 78개 고유, 78개 경로 전부 `matchRoute`로 해석, 공급자 레지스트리 8종 ↔ `required_agents.example.json` 일치, 각 공급자에 공식 문서 URL 존재, Q039 게이트가 차단 상태인지.

## 3. D1 마이그레이션 실제 실행

```
$ node scripts/db-migrate.mjs --memory --check
applied 0001_initial.sql (62823 bytes, sha256 8c5d028db9fa…)
{
  "database": ":memory:",
  "applied": [{ "version": "0001_initial",
                "checksum": "8c5d028db9fad60de15abdaa74425ac72755ace5a612602d5822bf7f4d0b0564",
                "bytes": 62823 }],
  "foreign_keys": 1,
  "tables": 94,
  "indexes": 44,
  "triggers": 26,
  "fts": ["memory_fts", "message_fts"],
  "journal": { "journal_mode": "memory" }
}
```

- `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` = 위반 0건 (스크립트가 실패 시 예외를 던짐)
- 테이블 94개에는 FTS5 그림자 테이블이 포함된다. 사용자 정의 테이블 기준 목록은 `scripts/db-migrate.mjs`의 `schemaSummary()` 출력 참조.

## 4. DB 무결성 통합 테스트

```
$ node --test tests/integration/*.test.mjs
# tests 16
# pass 16
# fail 0
```

통과한 불변식(각 테스트가 **거부**를 확인):
1. 스펙 05.2의 모든 테이블 존재 + FTS5 2종 + `foreign_keys=ON`
2. 외래키 위반 거부 (고아 메시지·존재하지 않는 의존 작업)
3. CHECK 거부: 잘못된 방 타입, 음수 파일 크기, `+09:00` 타임스탬프, 초 단위 타임스탬프, 잘못된 prefix ID, 검사 전 `ready` 파일
4. `room_seq` 방별 중복 거부, `main` 방 1개 제한
5. 메시지 author 불변·revision +1·하드 삭제 금지·버전 본문 불변
6. `DONE`은 검증된 증거 없이 거부, `pending` 증거로도 거부, 증거 연결 시 성공
7. 작업 revision +1 강제
8. 아티팩트 `VERIFIED`는 해시 일치 검증 행 없이는 거부
9. 승인: 만료 후 승인 거부(`APPROVAL_EXPIRED`), 대상/커밋 변경 시 자동 `INVALIDATED` + 감사 이벤트 생성
10. capability proof `verified`는 provider 응답 ID + 비자기신고 증명 필수
11. 메모리 FTS 색인·재색인·삭제 시 제거 + `search_tombstones` 기록
12. 메시지 FTS 최신 revision만 색인, soft delete 시 제거, 복원 시 재색인
13. 감사 로그 UPDATE/DELETE 거부
14. agent `platform_admin` 금지, owner 2명 거부
15. 작업이 있는 프로젝트 DELETE 거부(암묵 cascade 없음)
16. CI 결론은 completed 상태에서만 저장, `measured` 사용량은 값 필수

## 5. 계약 단위 테스트

```
$ node --test tests/unit/*.test.mjs
# tests 11
# pass 11
# fail 0
```

핵심: UUIDv7 정렬성·prefix 불일치 거부, UTC ISO-ms만 허용(오프셋·초 단위·불가능 날짜 거부), 오류 상태/재시도 매핑·내부 오류 비노출, 권한 기본 거부·플랫폼 관리자 전용·AI 자기 프로필 한정·방/프로젝트 멤버십·고위험 승인 digest, 이벤트 envelope 타입/버전, 재연결 계획, 작업 전이·DONE 증거·잡 취소 확정, 78 엔드포인트/라우트 매칭/페이지 상한, 공급자 8종 전부 `VERIFIED` 아님, Room DO seq 멱등성, Yjs 게시 충돌, 임대 fencing.

## 6. 파일 해시 (SHA-256)

| 파일 | SHA-256 |
|---|---|
| `db/migrations/0001_initial.sql` | `8c5d028db9fad60de15abdaa74425ac72755ace5a612602d5822bf7f4d0b0564` |
| `packages/contracts/src/ids.ts` | `140827c2980c78ec55c844ca0506d36ba01a6ac5d0f22709e711a682796428d5` |
| `packages/contracts/src/time.ts` | `7dae7191e1d6e226a4a953142c91187932668ca7b972f7e7770934635d5c158a` |
| `packages/contracts/src/errors.ts` | `789257be9085e2b0175d298c51e8122251144821cecf572548c549262f46db57` |
| `packages/contracts/src/permissions.ts` | `ca4f9f3947614b063f01c47f347be554f9ffbb148ba79c4d3a3168a5883495a1` |
| `packages/contracts/src/events.ts` | `667178ab298db788b5d375b455605978a3c71e18b24853b78c9aa0042c026fbf` |
| `packages/contracts/src/provider.ts` | `1fed1b3811c639fec7463068d40fa93491f30bf6e0b79ea01c955a74b614b6eb` |
| `packages/contracts/src/lifecycle.ts` | `e578eec710e58846d894066fbcaad72d189d324bcc7e045aa37458616c051537` |
| `packages/contracts/src/api.ts` | `e430995137b06c9d9005ad9004ff6a1f174e69489c1f3b7305f40d88121b4891` |
| `packages/contracts/src/api-catalog.generated.ts` | `6d2cbe427929f34ceb0a23209c30b49d6cb98ee5dfa322b773e2ede251472b76` |

> 해시는 이후 편집으로 바뀔 수 있다. 값이 필요하면 같은 폴더에서 `sha256sum db/migrations/0001_initial.sql packages/contracts/src/*.ts`를 다시 실행한다.

## 7. 실행하지 않은 것 (증거 없음)

- Cloudflare D1 원격 생성·마이그레이션·쿼리
- Worker/DO 배포, R2 활성화
- GitHub 리포지토리 생성·푸시, Actions 실행
- 웹/EXE/APK 빌드 및 설치 시험
- 실제 AI 공급자 호출 (키·계정 없음)
- 부하·침투·장애 주입 시험

이 항목들은 `FINAL_RELEASE_REPORT.md`에서 `NOT_TESTED`/`NOT_PRODUCED`로 표시되어 있다.
