# 릴리스 게이트 검증 결과 (자동 생성)

- 실행: 2026-11-21T05:56:43.796Z
- 판정: **INCOMPLETE**
- 증거 원장: docs/evidence/release-evidence.json

| Gate | 상태 | 내용 | 근거 |
|---|---|---|---|
| G-01 | BLOCKED | Q001–Q041 추적표 전 항목 구현 및 테스트 | QA 103항목=BLOCKED (QA 103항목: PASS 46, BLOCKED 8, NOT_TESTED 25, PARTIAL 24 (103항목)) |
| G-02 | BLOCKED | 지정 모든 실제 AI의 공식 연결·자율성·코드 능력 | provider-gate=BLOCKED (Q039 BLOCKED_EXTERNAL_DEPENDENCY, blocker 8건); required-roster=PASS (spec/required_agents.example.json: 필수 8종) |
| G-03 | BLOCKED | 다중 실제 AI의 상호 작업 종단간 시연 | ledger:G-03=BLOCKED (1개 증거 · Pickle(에이전트) — qa_matrix_runner/verify-release 실행 · 지정 AI 8종의 키·계정이 없다(Q039 blocker 8/8). 실제 다중 AI 협업 시연 불가.) |
| G-04 | PARTIAL | GitHub PR, Actions 빌드/테스트, 검증 병합 | ledger:G-04=PARTIAL (3개 증거 · Pickle(에이전트) — gh run list/download로 실행·아티팩트 확인 · Actions 5종 전부 success(커밋 cf00dd8). 다만 PR 생성·리뷰·검증 병합 흐름은 실제로 돌리지 않았다(푸시 직행).) |
| G-05 | PARTIAL | 웹 앱 실제 로그인·대화·프로젝트·IDE | web-build=PASS (apps/web/dist 파일 4개); ledger:G-05=PARTIAL (2개 증거 · Pickle(에이전트) — 원격 HTTP 실측 · 홈/포털문서/헬스/인증가드 라이브 200·401 확인. 소유자 계정 미생성으로 로그인·대화·IDE 실사용 시연은 미실시.) |
| G-06 | PARTIAL | Windows EXE 및 설치 파일 생성·설치·실행 | windows-artifact=NOT_TESTED (apps/desktop 아래 .exe/.msi 없음); ledger:G-06=PARTIAL (2개 증거 · Pickle(에이전트) — CI 아티팩트 다운로드·해시 대조 · AI ROOM.exe 4,820,992B / NSIS 1,873,114B / MSI 2,510,848B 생성, SHA-256 기록. 실제 Windows 기기 설치·실행 시험과 코드 서명은 미실시(미서명).) |
| G-07 | PARTIAL | Android APK 생성·서명 상태·실기기 설치 | android-artifact=PASS (apps/android/app/build/outputs/apk/debug/app-debug.apk, apps/android/app/build/outputs/apk/release/app-release-unsigned.apk); ledger:G-07=PARTIAL (3개 증거 · Pickle(에이전트) — CI 아티팩트 다운로드·해시 대조 · CI debug APK 9,146,029B SHA-256 d254707b…95b60de0f. release APK는 서명 키 부재로 미생성, 실기기 설치 미실시.) |
| G-08 | BLOCKED | 보안(인증·ACL·CI·파일·비밀·인젝션) | security-cases=BLOCKED (Critical/High 37건 중 PASS 14 · FAILED 0 · 전체 50건 {"PASS":17,"PARTIAL":11,"FAILED":0,"BLOCKED":2,"NOT_TESTED":20}) |
| G-09 | PARTIAL | 장애·재접속·인계·중복 방지 | 장애·복구 항목=PARTIAL (장애·복구 항목: PASS 5, NOT_TESTED 2, PARTIAL 2 (9항목)) |
| G-10 | BLOCKED | 메시지·기억·파일·코드·백업 무결성 | 무결성 항목=BLOCKED (무결성 항목: PASS 7, BLOCKED 1, PARTIAL 3 (11항목)); db-integrity-suite=PASS (tests/integration/api_admin.test.mjs: 8 pass/0 fail, tests/integration/api_chat.test.mjs: 9 pass/0 fail, tests/integration/api_code.test.mjs: 8 pass/0 fail, tests/integration/api_coverage.test.mjs: 2 pass/0 fail, tests/integration/api_cross_cutting.test.mjs: 4 pass/0 fail, tests/integration/api_identity.test.mjs: 10 pass/0 fail, tests/integration/api_projects.test.mjs: 6 pass/0 fail, tests/integration/db_schema.test.mjs: 16 pass/0 fail); ledger:G-10=PARTIAL (1개 증거 · Pickle(에이전트) — wrangler d1 원격 실행 · 원격 D1에 0001_initial 적용(테이블 97·트리거 26·인덱스 151). PRAGMA integrity_check는 D1이 SQLITE_AUTH로 거부해 로컬 SQLite에서만 확인.) |
| G-11 | PARTIAL | 무료 운영·사용량·자동 과금 방지 | 사용량·과금 항목=PARTIAL (사용량·과금 항목: NOT_TESTED 1, PARTIAL 3 (4항목)); ledger:G-11=PARTIAL (1개 증거 · Pickle(에이전트) — 테스트 실행 · 유료 AI API 미사용, 비용 0. 다만 실제 사용량 수집·선제 경보는 AI 호출 경로가 없어 미시험.) |
| G-12 | PARTIAL | 운영 문서·테스트·결과물·보고서 | required-docs=PASS (13개 문서 존재(200바이트 이상)); release-report=PASS (라벨 8개 모두 존재); openapi-sync=PASS (OPENAPI IN SYNC: /workspace/project-ai-room/docs/api/openapi.json (68 paths, 78 operations, contract 2026-11-21.1)); test-suite=PASS (16파일 · 120 pass); release-artifacts=PARTIAL (누락: Windows EXE (보고서 26.2 미충족)) |

## 차단 사유

- **G-01 BLOCKED**
  - QA 103항목: QA 103항목: PASS 46, BLOCKED 8, NOT_TESTED 25, PARTIAL 24 (103항목)
- **G-02 BLOCKED**
  - provider-gate: Q039 BLOCKED_EXTERNAL_DEPENDENCY, blocker 8건
- **G-03 BLOCKED**
  - ledger:G-03: 1개 증거 · Pickle(에이전트) — qa_matrix_runner/verify-release 실행 · 지정 AI 8종의 키·계정이 없다(Q039 blocker 8/8). 실제 다중 AI 협업 시연 불가.
- **G-04 PARTIAL**
  - ledger:G-04: 3개 증거 · Pickle(에이전트) — gh run list/download로 실행·아티팩트 확인 · Actions 5종 전부 success(커밋 cf00dd8). 다만 PR 생성·리뷰·검증 병합 흐름은 실제로 돌리지 않았다(푸시 직행).
- **G-05 PARTIAL**
  - ledger:G-05: 2개 증거 · Pickle(에이전트) — 원격 HTTP 실측 · 홈/포털문서/헬스/인증가드 라이브 200·401 확인. 소유자 계정 미생성으로 로그인·대화·IDE 실사용 시연은 미실시.
- **G-06 PARTIAL**
  - windows-artifact: apps/desktop 아래 .exe/.msi 없음
  - ledger:G-06: 2개 증거 · Pickle(에이전트) — CI 아티팩트 다운로드·해시 대조 · AI ROOM.exe 4,820,992B / NSIS 1,873,114B / MSI 2,510,848B 생성, SHA-256 기록. 실제 Windows 기기 설치·실행 시험과 코드 서명은 미실시(미서명).
- **G-07 PARTIAL**
  - ledger:G-07: 3개 증거 · Pickle(에이전트) — CI 아티팩트 다운로드·해시 대조 · CI debug APK 9,146,029B SHA-256 d254707b…95b60de0f. release APK는 서명 키 부재로 미생성, 실기기 설치 미실시.
- **G-08 BLOCKED**
  - security-cases: Critical/High 37건 중 PASS 14 · FAILED 0 · 전체 50건 {"PASS":17,"PARTIAL":11,"FAILED":0,"BLOCKED":2,"NOT_TESTED":20}
- **G-09 PARTIAL**
  - 장애·복구 항목: 장애·복구 항목: PASS 5, NOT_TESTED 2, PARTIAL 2 (9항목)
- **G-10 BLOCKED**
  - 무결성 항목: 무결성 항목: PASS 7, BLOCKED 1, PARTIAL 3 (11항목)
  - ledger:G-10: 1개 증거 · Pickle(에이전트) — wrangler d1 원격 실행 · 원격 D1에 0001_initial 적용(테이블 97·트리거 26·인덱스 151). PRAGMA integrity_check는 D1이 SQLITE_AUTH로 거부해 로컬 SQLite에서만 확인.
- **G-11 PARTIAL**
  - 사용량·과금 항목: 사용량·과금 항목: NOT_TESTED 1, PARTIAL 3 (4항목)
  - ledger:G-11: 1개 증거 · Pickle(에이전트) — 테스트 실행 · 유료 AI API 미사용, 비용 0. 다만 실제 사용량 수집·선제 경보는 AI 호출 경로가 없어 미시험.
- **G-12 PARTIAL**
  - release-artifacts: 누락: Windows EXE (보고서 26.2 미충족)

이 파일은 `node scripts/verify-release.mjs`가 실제 검사 결과로 생성한다. 손으로 고치지 않는다.
