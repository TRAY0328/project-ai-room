# PROJECT AI ROOM — monorepo

Q001–Q041 명세를 **실제 코드·스키마·테스트**로 옮기는 모노레포다. 현재 상태는 **3단계(기반 구축)** 이며, 제품 기능·배포·클라이언트 빌드는 아직 없다.

- 스펙 팩: `../work/ai_room_pack/PROJECT_AI_ROOM/` (00~57장, 카탈로그 7종)
- 진행 증거: [`docs/evidence/FINAL_RELEASE_REPORT.md`](docs/evidence/FINAL_RELEASE_REPORT.md), [`docs/evidence/provider-capabilities.md`](docs/evidence/provider-capabilities.md), [`docs/evidence/phase-3-verification.md`](docs/evidence/phase-3-verification.md)
- 차단·가정 등록부: [`docs/ASSUMPTIONS_AND_BLOCKERS.md`](docs/ASSUMPTIONS_AND_BLOCKERS.md)

## 지켜야 하는 조건 (제품 요구사항)

1. **CLOUD-ONLY** — Cloudflare Workers + D1 + Durable Objects + R2, GitHub Actions. 로컬 PC·로컬 브리지·상시 로컬 실행기를 필수 구성으로 두지 않는다.
2. **신규 유료 AI 추론 API 금지, 무료 우선.** 없는 무료 경로를 가정하지 않는다.
3. **가짜 AI·가짜 로그·가짜 성공 금지.** 상태는 `ACKNOWLEDGED`/`QUEUED`/`RUNNING`/`SUCCEEDED`를 구분하고, 검증 증거 없이는 `DONE`·`VERIFIED`를 쓰지 않는다.
4. 운영 배포, 공개 전환, 파괴적 삭제는 사용자 승인 전 금지.

## 구조

```
apps/            web(React+Monaco) · desktop(Tauri) · android(Kotlin/Compose)   [자리표시자]
services/
  gateway-worker/      HTTP 파이프라인: request_id → 인증 → 인가 → 검증 → 핸들러
  room-do/             방 단위 room_seq 발급·실시간 팬아웃·재연결
  collab-do/           Yjs 업데이트 중계·게시(base SHA 3자 검사)
  provider-adapters/   실제 AI 연결기 레지스트리 8종 (전부 정직하게 차단 상태)
  github-integration/  웹훅 HMAC·delivery 멱등·run 결론 매핑·dispatch 승인 가드
  job-orchestrator/    작업 임대(fencing)·잡 상태머신·무료 예산 가드
packages/
  contracts/           ⭐ 단일 공통 계약(ID·시간·오류·권한·이벤트·공급자·78 API·상태머신)
  design-system/ auth/ permissions/ message-blocks/ memory/ search/ editor/ git/ telemetry/ testing/  [자리표시자]
db/migrations/0001_initial.sql   D1 전체 스키마(테이블 94, 트리거 26, FTS5 2종)
docs/{architecture,adr,api,evidence,security,user-guide,operator-guide}
tests/{unit,integration,e2e,security,chaos,acceptance}
scripts/  gen-api-contracts.mjs · verify-contracts.mjs · db-migrate.mjs
```

## 실행 (로컬 검증)

요구: Node ≥ 22.5 (이 환경은 22.20.0). 이 워크스페이스에서는 `/workspace/node/bin`이 PATH에 없다면 앞에 붙인다.

```bash
npm install                 # npm workspaces (lockfile 고정)
npm run typecheck           # contracts + services 전부 tsc -b
npm run verify:contracts    # 78 엔드포인트·Q039 게이트 교차검증
npm run test:db             # 실제 SQLite에 마이그레이션 적용 + 무결성 테스트 16개
npm run test                # build + unit 11 + integration 16
npm run db:migrate          # db/local/ai_room_dev.sqlite 생성
```

## 현재 검증 상태 (사실만)

| 항목 | 결과 |
|---|---|
| 타입체크 (`tsc -b`) | **PASS** (contracts + 6 services) |
| 계약 검증 | **PASS** — 78 엔드포인트, operationId 78개 고유, 전 라우트 매칭 |
| 스키마 마이그레이션 | **PASS** — 로컬 SQLite 3.50.4, `integrity_check=ok`, FK 위반 0 |
| DB 통합 테스트 | **16/16 PASS** |
| 계약 단위 테스트 | **11/11 PASS** |
| 원격 CI | **없음** (리포지토리 미생성) |
| D1 원격 적용 | **없음** (승인 전) |
| Q039 필수 AI 연결 | **BLOCKED_EXTERNAL_DEPENDENCY 8/8** |
| 웹/EXE/APK | **없음** |

## 다음 단계

`docs/evidence/FINAL_RELEASE_REPORT.md`의 "운영 인계" 절 참조: 비공개 리포 생성·푸시 → D1 생성·원격 마이그레이션 → R2 활성화 → 인증·방/메시지 핸들러 → 웹 UI.

## 라이선스

아직 확정하지 않았다. 공개 배포 전에 사용자가 선택해야 하며, 그 전까지는 `UNLICENSED`(내부 전용)다.
