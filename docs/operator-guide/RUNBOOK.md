# 운영 런북 — PROJECT AI ROOM

이 문서는 **장애가 났을 때 읽는 문서**다. 배포 절차는 [`DEPLOYMENT.md`](DEPLOYMENT.md), 백업·복원은 [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md), 보안 통제표는 [`../security/SECURITY_CONTROLS.md`](../security/SECURITY_CONTROLS.md)에 있다.

- 대상 독자: 소유자(천예준) 1인과 그를 돕는 운영자
- 기준 스펙: `PROJECT_AI_ROOM_ULTIMATE_DEEP_SPEC_Q001-Q041.md` 21·22·23장, 25장 G-11
- 이 문서의 숫자와 상태는 2026-11-21 실측값이다. 바뀌면 바뀐 날짜와 근거를 함께 적는다.

---

## 0. 스펙 23.2 필수 런북 파일과의 대응

스펙은 런북을 7개 파일로 나누라고 적었고, 이 저장소는 3개 문서로 같은 내용을 담는다. 파일 이름이 다르므로 어느 항목이 어디 있는지 먼저 표로 고정한다.

| 스펙 23.2 파일 | 이 저장소의 위치 |
|---|---|
| `deploy.md` | [`DEPLOYMENT.md`](DEPLOYMENT.md) 전체 |
| `rollback.md` | 이 문서 §9 (코드·마이그레이션·PR·R2) |
| `incident.md` | 이 문서 §2~§4, §10 |
| `quotas.md` | 이 문서 §5 (무료 한도·하드캡·대기) |
| `ai-connections.md` | 이 문서 §7 + [`../evidence/provider-capabilities.md`](../evidence/provider-capabilities.md) |
| `backups.md` | [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) |
| `emergency-stop.md` | 이 문서 §4.3 |

---

## 1. 지금 실제 상태 (2026-11-21)

| 항목 | 상태 | 근거 |
|---|---|---|
| Cloudflare 배포 | **없음** | D1·Worker·DO 배포 기록 없음. `wrangler` 미설치(`toolchain.lock.json`) |
| Cloudflare 계정 | `Playtray0328@gmail.com's Account` (`e2b6a799ae8fbaa94a08b703a079be92`) | `GET /client/v4/accounts` success |
| Workers | 계정에 11개 스크립트(기존 프로젝트) | `GET /accounts/{id}/workers/scripts` |
| D1 | 계정에 5개 DB(기존 프로젝트). **AI ROOM 전용 DB 없음** | `GET /accounts/{id}/d1/database` |
| R2 | **사용 불가** — `10042 Please enable R2 through the Cloudflare Dashboard` | `GET /accounts/{id}/r2/buckets` |
| workers.dev 서브도메인 | `playtray0328` | `GET /accounts/{id}/workers/subdomain` |
| GitHub 리포지토리 | **미생성** (로컬 git만 존재) | `docs/evidence/FINAL_RELEASE_REPORT.md` |
| 로컬 검증 | typecheck·계약검증·테스트 통과 | `npm run verify` 계열, `docs/evidence/phase-3-verification.md` |

> 이 표에서 "없음/불가"는 고장이 아니라 **아직 하지 않은 것**이다. 운영 중 장애와 구분해서 읽는다.

### 1.1 로컬에서 지금 바로 쓸 수 있는 진단 명령

```bash
cd project-ai-room
node --version                                   # v22.20.0
npm run verify                                   # 타입체크 + 계약검증 + 단위·통합 테스트
node scripts/gen-openapi.mjs --check             # OpenAPI가 생성기 출력과 같은지
node tests/acceptance/qa_matrix_runner.mjs       # QA 103 + 보안 50 상태
node scripts/verify-release.mjs                  # G-01..G-12 판정
```

`node`가 PATH에 없으면 이 워크스페이스에서는 `/workspace/node/bin/node`를 쓴다.

---

## 2. 장애 심각도와 에스컬레이션

스펙 23.1의 네 단계를 그대로 쓰되, 1인 운영이므로 "누구에게"는 사용자와 외부 제공자로 한정한다.

| 심각도 | 정의(스펙 23.1) | 이 시스템에서의 예 | 첫 행동 | 통보 |
|---|---|---|---|---|
| **SEV-1** | 비밀 노출·권한 우회·대규모 데이터 손상 가능성 | AI 키/초대 비밀 유출, `platform_admin` 상승 흔적, 감사 로그 변조 시도, 다른 프로젝트 데이터 열람 | **즉시 비상 정지**(§4.3) → 키 회전(§4.1) → 증거 보전(§3.2) | 소유자 즉시. 외부 노출이면 해당 제공자(GitHub/Cloudflare)에도 즉시 |
| **SEV-2** | 메시지 유실·PR 오병합·아티팩트 변조 | `room_seq` 결번·중복 저장, 승인 없는 병합, SHA 불일치 아티팩트 배포 | 쓰기 중지(§4.4) → 원본 보전 → 복원 계획(§9.3) | 소유자 30분 내 |
| **SEV-3** | 특정 AI·외부 제공자·Actions 일시 장애 | provider 5xx, GitHub 429, Actions 큐 지연, D1 일시 오류 | 기능 제한 표시·재시도 백오프(§7) | 소유자 당일 요약 |
| **SEV-4** | UI 표시 오류·지연 | 대시보드 숫자 불일치, 느린 목록 | 수정 + 회귀 테스트 | 다음 보고에 포함 |

### 2.1 에스컬레이션 규칙

1. **판단이 서지 않으면 높은 심각도로 시작한다.** SEV-3로 보였던 것이 권한 우회인 경우가 더 비싸다.
2. SEV-1은 "확인 후 조치"가 아니라 **조치와 동시에 확인**한다. 비상 정지는 되돌릴 수 있지만 유출된 키는 되돌릴 수 없다.
3. 외부 제공자 장애는 우리가 고칠 수 없다. 이때 상태는 `BLOCKED_EXTERNAL_DEPENDENCY`로 표시하고 **성공으로 위장하지 않는다**(스펙 19.4).
4. 사용자에게 알리는 문장은 사실만 쓴다: 무엇이, 언제부터, 지금 무엇이 멈췄고, 무엇이 안전한지.

### 2.2 심각도 판정에 쓰는 신호

| 신호 | 위치 | 읽는 법 |
|---|---|---|
| 보안 이벤트 | `security_events` (severity, created_at) | `high`/`critical`이 반복되면 SEV-1 후보 |
| 감사 | `audit_events` (append-only, `trg_audit_no_update`) | `allow_or_deny='deny'`의 reason_code 분포 |
| 승인 | `approvals` (state, expires_at, action_digest) | `INVALIDATED`/`EXPIRED` 뒤 실행 시도 |
| 사용량 | `usage_budgets` (observed_value, observation_state) | `unknown`인데 호출이 나가면 과금 사고 |
| 작업 | `jobs`, `ci_runs`, `test_runs` | `RUNNING`에 오래 머문 작업, `unknown` 결론 |
| 검색·삭제 | `message_tombstones`, `search_tombstones` | 삭제 후 검색에 남는 문서 |

---

## 3. 탐지 → 격리 → 증거 → 복구

### 3.1 1차 트리아지 (5분)

1. **무엇이 멈췄나**: 읽기인가 쓰기인가. 읽기만 되면 권한·외부 의존성 문제일 가능성이 크다.
2. **언제부터인가**: 마지막 정상 시각을 `audit_events`/`jobs.updated_at`에서 찾는다.
3. **누구의 데이터인가**: 방/프로젝트 단위로 범위를 좁힌다.
4. **비밀은 안전한가**: `security_events`에 인증 실패·초대 남용이 몰려 있는지 본다.
5. **지금도 진행 중인가**: 반복되는지, 한 번인지.

### 3.2 증거 보전 (지우기 전에)

- `audit_events`, `security_events`는 **삭제하지 않는다**(트리거가 막는다). 내보내기만 한다.
- 관련 `jobs`/`ci_runs`/`webhook` 수신 기록(`github_webhooks`)과 요청 `request_id`를 모은다.
- 스크린샷·로그를 `docs/evidence/`가 아닌 **사고 기록 전용 위치**에 날짜로 남긴다. 증거 원장(§8)에는 경로만 적는다.
- 비밀값은 증거로 복사하지 않는다. 키 이름과 회전 시각만 기록한다.

---

## 4. 비밀·키 사고와 긴급 정지

### 4.1 무엇이 새면 무엇을 회전하나

| 유출 의심 대상 | 즉시 할 일 | 확인 |
|---|---|---|
| AI 키(`airo_sk_…`) | 해당 AI 세션 전부 폐기 + 키 회전 | 기존 키 로그인 `AUTH_REVOKED`, 새 키만 성공 |
| 초대 비밀(`AGENT_INVITE_SECRET`) | Worker 비밀 교체 + 미사용 초대 전부 폐기 | 신규 등록이 `INVITE_INVALID` |
| 소유자 세션 서명 키(`SESSION_SIGNING_KEY`) | 교체 → 모든 세션 무효화 | 모든 토큰 `AUTH_REVOKED`, 재로그인 필요 |
| GitHub App 개인키 | GitHub에서 키 폐기 → 새 키 발급 → 설치 토큰 재발급 | 웹훅 서명 검증·PR 조회 성공 |
| Cloudflare API 토큰 | 대시보드에서 폐기 → 최소 권한으로 재발급 | `GET /accounts` 성공, R2/D1 권한 확인 |
| `OWNER_BOOTSTRAP_SECRET` | 교체하고 **부트스트랩이 이미 끝났는지 확인** | `owners` 행 1개 → 재부트스트랩 `PERMISSION_DENIED` |

회전 순서는 항상 **폐기 → 발급 → 배포 → 검증**이다. 발급을 먼저 하면 유출된 키가 계속 살아 있는 시간이 길어진다.

- AI 키 회전은 `POST /api/v1/agents/rekey`(권한: 본인 범위)로 하고, 회전 시 기존 세션이 함께 폐기되는지 확인한다(`AuthService.rekeyAgent` → `revokeSessionsFor`).
- 초대 비밀은 `agent_invites`에서 `used_at`/`revoked_at`을 채워 폐기한다. 추측 비용은 `verifyInvite`의 시도 예산(등록 6회/10분)이 담당한다.

### 4.2 유출됐는지 판단하는 기준

- 키 원문이 로그·아티팩트·브라우저 번들에 **한 번이라도** 보이면 유출로 본다. 마스킹(`packages/git`의 `redactSecrets`)은 사후 안전망이지 면죄부가 아니다.
- 저장 형태는 해시뿐이어야 한다: `agent_credentials.verifier_hash`(SHA-256), 비밀번호는 PBKDF2-SHA256(100,000회). 평문이 보이면 그 자체가 사고다.

### 4.3 비상 정지 (emergency stop)

목적: **새 작업이 나가지 않게** 하고, 진행 중 작업은 상태를 확인해 취소를 요청한다. "취소 요청"과 "취소됨"은 다르다.

절차:

1. `POST /api/v1/admin/emergency-stop` (owner 세션, `owner.admin.emergency_stop`) — `scope=all|project`, `reason` 필수.
2. 결과에서 `dispatch_blocked=true`와 `cancel_requested_jobs` 목록을 확인한다.
3. 진행 중 작업은 `jobs` 상태가 `CANCEL_REQUESTED`로 남는다. **`CANCELLED`가 되기 전에는 끝난 것으로 보고하지 않는다**(GitHub 쪽 결론을 다시 조회해야 한다).
4. 원인 조치(키 회전·설정 수정·배포 롤백)를 끝낸다.
5. 재개 전 확인:
   - 비밀 회전 완료, 유출 경로 차단
   - `usage_budgets`가 `measured` 또는 안전한 `unknown`(차단) 상태
   - CI·D1·R2 의존성 상태가 `ready`
   - 감사 로그에 정지~재개 사이 공백이 없음
6. 재개: `POST /api/v1/admin/emergency-resume` (구현된 확장 경로. 스펙 19.2의 `/v1/admin/resume`과 이름이 다르고 카탈로그에는 아직 없다) — 재개도 감사에 남는다.
7. 재개 후 **첫 작업 1건을 지켜본다.** 자동 재개 후 방치하지 않는다.

### 4.4 쓰기 중지가 정지보다 나은 경우

- 데이터 손상이 의심되면 전체 정지보다 **쓰기만 막고 읽기를 남긴다**. 사용자는 기록을 확인할 수 있어야 한다.
- 한도 초과 위험은 과금 사고로 이어지므로 즉시 차단, 대신 화면에 "한도 도달, 대기 중"을 정확히 표시한다(스펙 21.1).

---

## 5. 무료 한도 모니터링과 자동 차단

### 5.1 원칙

1. **숫자를 코드에 하드코딩하지 않는다.** 2026년 이후 바뀔 수 있다. 배포 직전 공식 문서와 계정 화면으로 확인하고, 확인 시각을 `usage_budgets`에 남긴다.
2. **"무료 제공량"과 "자동 과금 불가"는 다른 조건**이다. 결제 수단이 등록돼 있으면 무료 한도 초과가 곧 청구다.
3. **측정되지 않은 사용량을 0으로 읽지 않는다.** `observation_state='unknown'` + `observed_value=null`은 "차단"으로 취급한다(`canDispatch()`).
4. 한도에 닿으면 **429/읽기 전용/대기**로 저하되고, 데이터는 손상되지 않아야 한다.

### 5.2 자원별 확인 지점

| 자원 | 확인 | 한도 접근 시 행동 |
|---|---|---|
| Workers 요청 | Cloudflare 대시보드 + 요청 로그 | 비핵심 경로(검색 인덱싱·메트릭 재계산) 주기 축소, 쓰기는 유지 |
| D1 읽기/쓰기 | `usage_budgets`, 쿼리 카운트 | 검색·대시보드 쿼리 캐시, 페이지 크기 축소(최대 100) |
| Durable Objects | DO 요청·저장 | 소켓 heartbeat 주기 상향, presence 갱신 최소화 |
| R2 | 현재 **불가**(10042) | 파일 기능 `BLOCKED_EXTERNAL_DEPENDENCY` 표시, 업로드 인텐트 발급 중지 |
| GitHub Actions | 리포지토리 무료 분·동시성 | `dispatch` 차단, 기존 실행만 관찰. 재시도 금지 |
| AI 제공자 | 제공자 콘솔 + `provider_usage` | 호출 차단, 작업 `QUEUED` 유지, 사용자에게 대기 사유 표시 |

### 5.3 자동 차단 규칙 (구현 계약)

- `hard_limit_value`가 있는 예산에서 `observed_value + 예상 사용량 > hard_limit_value` → **새 작업 dispatch 거부**(`QUOTA_EXHAUSTED`, retryable=false).
- `observation_state='unknown'` → **보수적으로 차단**. "모르니 일단 보낸다"는 금지.
- 차단은 **감사에 남기고**, 화면에는 남은 한도와 다음 확인 시각을 표시한다. 조용히 실패하지 않는다.
- 자동 유료 업그레이드·자동 결제는 어떤 경로로도 만들지 않는다(스펙 20.2).

### 5.4 한도 사고의 전형과 예방

| 전형 | 예방 |
|---|---|
| 재시도 폭주로 Actions 분 소진 | 지수 백오프 + 시도 상한 + fingerprint 캐시 |
| 검색 인덱싱 반복 | 변경된 리비전만 인덱싱, `search_index_tasks` 큐 |
| 대시보드 폴링 | 화면 단위 캐시, 50개 지표 계산은 이벤트 기반 |
| 웹훅 중복 처리 | `github_webhooks` delivery id 멱등 |

---

## 6. R2가 없을 때 (현재 상태)

R2는 **켜지지 않았다**(`10042`). 토큰 권한 문제가 아니므로 재시도로 해결되지 않는다.

- 파일 본문·스냅샷·아티팩트 바이트를 저장하는 기능은 **BLOCKED**로 표시한다. "나중에 업로드됨"처럼 보이게 만들지 않는다.
- 업로드 인텐트를 발급하지 않는다. 발급하면 사용자는 업로드했다고 믿는다.
- 텍스트 기능(채팅·작업·기억·검색)은 R2 없이 동작해야 한다. 파일 참조만 명시적으로 비활성화한다.
- 복구 조건: 소유자가 Cloudflare 대시보드에서 R2를 활성화하고, 버킷·수명주기 규칙을 만든 뒤 `docs/ASSUMPTIONS_AND_BLOCKERS.md` B-01을 갱신한다.

---

## 7. AI 제공자 연결 장애

- 필수 AI 8종 중 공식 무료 무인 경로가 문서로 확인된 것은 Gemini뿐이고, **키가 없어 실제 연결은 0건**이다(`../../docs/evidence/provider-capabilities.md`).
- 연결이 없을 때 상태는 `NOT_CONFIGURED`/`BLOCKED_EXTERNAL_DEPENDENCY`이며, **"연결됨"으로 표시하지 않는다**. 작업은 `QUEUED`로 두고 사유를 보여준다.
- 토큰 만료: 작업을 보류하고 재인증을 요구한다. 만료 토큰으로 재시도 루프를 돌리지 않는다.
- 제공자 429/5xx: 백오프(상한 있음) 후 실패를 그대로 기록한다. 200으로 감추지 않는다.
- 약관·무료 정책은 배포 전에 다시 확인한다(S50). 확인 시각과 문서 URL을 남긴다.

---

## 8. 증거 원장 (release-evidence.json)

`node scripts/verify-release.mjs`는 실행 증거가 필요한 게이트(G-03~G-07, G-10, G-11)를 **원장**에서 읽는다. 원장이 없거나, 원장이 가리키는 파일이 없으면 그 게이트는 `NOT_TESTED`/`FAILED`다.

- 기본 경로: `docs/evidence/release-evidence.json` (환경변수 `AI_ROOM_RELEASE_EVIDENCE`로 변경 가능)
- PASS 기록에는 **증거 배열과 `verified_by`가 반드시 있어야** 한다. 없으면 검증기가 PASS를 거부한다.
- 로컬 파일 경로는 실제로 존재해야 한다. `https:`, `github:`, `ci:`, `pr:`, `commit:`, `run:` 접두 참조는 형식만 본다(원격 조회는 하지 않는다).

형식:

```json
{
  "schema_version": 1,
  "gates": {
    "G-03": {
      "status": "PASS",
      "verified_at": "2026-11-22T01:00:00.000Z",
      "verified_by": "천예준",
      "evidence": ["docs/evidence/e2e/multi-ai-2026-11-22.md", "run:1234567890"],
      "note": "AI 2종이 실제 코드 변경·상호 리뷰 후 병합"
    },
    "G-06": {
      "status": "FAILED",
      "verified_at": "2026-11-22T01:00:00.000Z",
      "verified_by": "천예준",
      "evidence": ["apps/desktop/target/release/ai-room-setup.exe"],
      "note": "설치 파일 해시 불일치"
    }
  }
}
```

원장은 **주장이 아니라 색인**이다. 증거 파일을 지우면 자동으로 FAILED가 된다.

---

## 9. 롤백

### 9.1 코드

- 배포 단위는 Worker 스크립트와 DO 클래스다. 이전 버전으로 되돌릴 때는 **이전 배포 ID를 지정**하고, 되돌린 버전이 현재 D1 스키마와 호환되는지 먼저 확인한다.
- 롤백 금지 조건: 새 마이그레이션이 이미 적용됐고 이전 코드가 새 컬럼을 모르는 경우(아래 §9.2 참조).

### 9.2 D1 마이그레이션

- 마이그레이션은 **앞으로만** 간다. 되돌리기 스크립트를 즉석에서 쓰지 않는다(데이터 손실 위험).
- 배포 전 `node scripts/db-migrate.mjs --check`로 체크섬 일치를 확인한다. 이미 적용된 파일을 고치면 체크섬이 달라져 배포가 거부돼야 한다.
- 스키마 변경은 **확장 → 이중 쓰기/이중 읽기 → 정리** 순서(3단계)로만 한다.
- 롤백이 필요하면 코드를 되돌리지 말고 **호환 레이어를 먼저 배포**한 뒤 데이터를 옮긴다.

### 9.3 PR·Git

- 잘못 병합된 PR은 `revert` PR로 되돌리고, **Actions가 다시 통과하는지 확인**한다. 강제 push로 history를 지우지 않는다.
- 승인 후 head SHA가 바뀐 병합은 승인 무효 대상이다(`approvals.action_digest`, `INVALIDATED`).

### 9.4 복원

데이터 복원은 [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md)의 dry-run → 승인 → 실행 순서를 따른다. **백업을 읽어 운영 DB를 바로 덮지 않는다.**

---

## 10. 사후 기록 (회고)

사고마다 남길 최소 항목:

1. 사고 ID, 시작·탐지·복구 시각(UTC)
2. 심각도와 판정 근거
3. 영향 범위(방·프로젝트·사용자·AI)
4. 탐지 경로(어떤 신호가 먼저 울렸나)
5. 조치와 되돌림 여부
6. 데이터 손실 여부와 검증 방법
7. 재발 방지(코드·테스트·문서) — **테스트로 닫지 않은 항목은 미완료로 남긴다**
8. 이 런북에서 고칠 점

---

## 11. 정기 점검

| 주기 | 확인 |
|---|---|
| 매일 | `security_events` high/critical, `usage_budgets` unknown, 실패한 jobs |
| 매주 | 백업 성공 여부·무결성 체크섬, 승인 만료 잔여, 초대 비밀 만료 |
| 매월 | 키 회전(가능한 범위), 무료 한도 공식 문서 재확인, 복원 리허설 1회 |
| 분기 | `security_cases.json` 50건 상태 재평가, 침투·부하 시험 계획 |

---

## 12. 하지 말아야 할 것

- 확인하지 않은 run ID·SHA·스크린샷을 보고서에 넣지 않는다(스펙 26.3).
- 외부 의존성 때문에 막힌 기능을 "완료"로 표시하지 않는다.
- 권한 검사를 UI 숨김으로 대체하지 않는다.
- 429/503을 200으로 바꾸지 않는다.
- 백업을 검증 없이 복원하지 않는다.
