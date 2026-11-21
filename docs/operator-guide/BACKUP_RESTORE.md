# 백업·복원·삭제 — PROJECT AI ROOM

스펙 22장(Q018·Q026·Q032)과 23.2 `backups.md`를 이 저장소의 실제 스키마에 맞춰 정리한 문서다.

- 관련 테이블: `backup_manifests`, `restore_runs`, `schema_migrations`, `search_tombstones`, `message_tombstones`, `retention_policies`
- 관련 스크립트: `scripts/db-migrate.mjs`, `scripts/verify-release.mjs`, `tests/acceptance/qa_matrix_runner.mjs`
- 현재 상태: **원격 D1·R2가 없어 실제 백업/복원 시험은 0건**이다. 이 문서는 절차와 검증 기준이며, "시험했다"는 뜻이 아니다.

---

## 1. 원칙

1. **백업은 복원 시험이 끝나야 백업이다.** 파일이 생겼다는 사실은 백업의 증거가 아니다.
2. **삭제한 데이터가 백업에서 되살아나면 삭제권이 무효**가 된다. 복원 후 tombstone을 다시 적용한다.
3. **복원은 먼저 계획(dry-run)**, 사람 승인 후 실행. 운영 DB를 바로 덮지 않는다.
4. **비밀은 백업에 넣지 않는다.** 세션 서명 키·API 토큰·GitHub App 개인키는 백업 대상이 아니라 재발급 대상이다.
5. **무료 한도 안에서 현실적인 주기**를 정한다. 매시간 전체 덤프는 무료 한도를 태워 백업을 못 하게 만든다.

---

## 2. 백업 범위

| 대상 | 내용 | 방법 | 무결성 기준 |
|---|---|---|---|
| D1 논리 백업 | 스키마 + 데이터 (`schema_migrations` 포함) | D1 내보내기(예: `wrangler d1 export`) 또는 `node:sqlite` 기반 로컬 덤프 | `PRAGMA integrity_check = ok`, `PRAGMA foreign_key_check` 0건 |
| 스키마 버전 | `schema_migrations`의 version·checksum | 덤프에 포함 | `scripts/db-migrate.mjs --check`와 일치 |
| R2 객체 매니페스트 | key, size, sha256, content_type | 목록 API 또는 매니페스트 테이블 | 객체 수·총 바이트·해시 일치 |
| Git 참조 | 리포지토리, 브랜치 head SHA, PR 번호 | API 조회 결과 저장 | SHA 40자·리포 이름 일치 |
| 시스템 설정 | 정책·한도·보존 규칙 | `quota_policies`, `usage_budgets`, `retention_policies` 덤프 | 행 수와 해시 |
| 아티팩트 | 빌드 산출물 해시·검증 행 | `artifacts`, `artifact_manifests`, `artifact_verifications` | `verification_state='VERIFIED'`만 |

각 백업은 `backup_manifests`에 1행으로 남긴다: 생성 시각, DB 체크섬, 객체 수, 스키마 버전, 암호화 여부, **복원 시험 시각(`restore_tested_at`)**.

### 2.1 D1 스냅샷과 논리 덤프를 함께 쓴다

D1에는 두 가지 복구 경로가 있고, 둘은 대체가 아니라 보완이다.

| 방식 | 얻는 것 | 잃는 것 / 주의 |
|---|---|---|
| **스냅샷(시점 복원)** | 특정 시점 상태로 빠르게 되돌리기 | 되돌릴 수 있는 기간·조건은 플랜에 따라 다르다. **배포 전 공식 문서로 확인**하고 확인 시각을 기록한다 |
| **논리 덤프(SQL)** | 스키마·데이터를 다른 DB로 옮길 수 있음 | 덤프 시점의 일관성은 덤프 방식에 의존한다. 큰 DB는 시간이 걸린다 |

- 스냅샷은 "방금 전 실수"를 되돌릴 때, 논리 덤프는 "다른 환경으로 옮기거나 검증할 때" 쓴다.
- 스냅샷이 있다는 이유로 논리 덤프를 생략하지 않는다. 스냅샷은 내보낼 수 없고, 제공자 정책이 바뀌면 사라질 수 있다.
- 논리 덤프가 있다는 이유로 스냅샷을 무시하지 않는다. 전체 복원은 덤프보다 느리고 위험하다.
- 복원 경로를 문서에 적을 때는 **어느 방식으로, 어느 시점까지** 가능한지 숫자로 적는다. "복원 가능"만으로는 부족하다.

### 2.2 주기(권장안, 실측 후 조정)

| 주기 | 대상 | 보존 |
|---|---|---|
| 매일 | D1 논리 백업 + 매니페스트 | 7일 |
| 매주 | 전체(R2 매니페스트·Git 참조 포함) | 4주 |
| 수동 | 배포 전·마이그레이션 전·대량 삭제 전 | 별도 보존 |

무료 한도가 빠듯하면 **일일 백업을 주 3회로 낮추고, 대신 변경 전 수동 백업을 의무화**한다. 주기를 줄이는 것보다 "변경 전 백업"을 빠뜨리지 않는 게 중요하다.

### 2.3 암호화·키 관리

- 백업 파일은 저장 전에 암호화한다(AES-256 등). 암호화 키는 **백업과 같은 곳에 두지 않는다**(S39).
- 키 접근 권한은 소유자 1인으로 제한하고, 키 회전 시 이전 백업의 복호화 가능 기간을 정한다.
- 백업 무결성 체크섬은 키와 분리해 보관한다(체크섬은 무결성, 키는 기밀성).

---

## 3. 백업 검증 (만들었으면 확인한다)

```bash
# 1) 마이그레이션 체크섬이 기준과 같은지
node scripts/db-migrate.mjs --memory --check

# 2) 덤프를 빈 DB에 넣고 무결성 확인
node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(process.env.DUMP, "utf8"));
console.log("integrity", db.prepare("PRAGMA integrity_check").get());
console.log("fk", db.prepare("PRAGMA foreign_key_check").all());
console.log("tables", db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get());
NODE
```

확인 항목:

- [ ] `integrity_check` = `ok`
- [ ] `foreign_key_check` 위반 0건
- [ ] `schema_migrations`의 version·checksum이 배포된 마이그레이션과 일치
- [ ] 사용자 정의 테이블 수가 기준과 일치(FTS 그림자 테이블 제외)
- [ ] `messages`/`message_versions` 행 수와 최신 `room_seq`가 원본과 일치
- [ ] `memory_fts`, `message_fts`가 재구성 가능(복원 후 재색인 절차 존재)
- [ ] 매니페스트의 객체 수·총 바이트가 실제와 일치
- [ ] `backup_manifests.restore_tested_at`이 비어 있지 않음

하나라도 실패하면 그 백업은 **사용 불가**로 표시하고 새로 뜬다. 조용히 넘어가지 않는다.

---

## 4. 복원

### 4.1 단계

1. **대상 정하기**: 백업 ID, 복원 시점, 덮어쓸 범위(`none|project|all`), 대상 프로젝트.
2. **dry-run 계획 생성** (`POST /api/v1/admin/restores/prepare`):
   - 대상 시각, 덮어쓰기 범위, 삭제 위험, 누락 파일, 버전 충돌, 참조 무결성 예상 결과
   - `requires_approval: true`면 여기서 멈춘다.
3. **사람 승인** (`/v1/admin/approvals` → `/resolve`): 승인은 계획 digest에 묶인다. 계획이 바뀌면 승인은 `INVALIDATED`.
4. **실행** (`POST /api/v1/admin/restores/commit`): 승인 ID + 확인 문구 필수.
5. **검증** (§4.2).
6. **tombstone 재적용** (§5.3): 복원 이후 삭제된 항목이 되살아나지 않게 한다.

### 4.2 복원 후 검증 체크리스트

| 검사 | 방법 | 통과 기준 |
|---|---|---|
| 참조 무결성 | `PRAGMA foreign_key_check` | 0건 |
| 메시지 순서 | 방별 `room_seq` 정렬, 중복·결번 | 중복 0, 결번은 의도된 삭제와 일치 |
| 메시지 리비전 | `message_versions` 최대 리비전 = `messages.current_revision` | 전 행 일치 |
| 검색 인덱스 | `message_fts`/`memory_fts` 재구성 후 검색 표본 | 삭제 문서 미검색, 최신 리비전만 검색 |
| Git SHA | `git_revisions`/`documents.head_sha` ↔ 원격 head | 일치 또는 명시적 차이 기록 |
| 파일 해시 | `files.sha256` ↔ R2 객체 SHA | 일치(R2 없으면 `UNSUPPORTED`로 표시) |
| ACL | `room_acl`, `project_acl` 행 수·역할 분포 | 복원 전과 동일 |
| 감사 | `audit_events` append-only 유지 | 변조·삭제 없음 |
| 승인 | `approvals` 상태와 `expires_at` | 만료 승인이 살아나지 않음 |
| 삭제 | `message_tombstones`, `search_tombstones` | 복원 후에도 유지 |

검증 결과는 `restore_runs.integrity`에 기록하고, 실패한 항목은 **복원 실패**로 다룬다. "대부분 복구됨"은 상태가 아니다.

### 4.3 복원이 실패했을 때

- 운영 DB를 덮은 뒤 실패했다면 **즉시 쓰기를 막고**, 복원 전 스냅샷으로 되돌린다(복원 전 스냅샷이 필수인 이유).
- 부분 복원만 성공한 경우 `PARTIAL`로 표시하고 어떤 테이블이 어긋났는지 기록한다.
- 원인을 모르는 채 같은 복원을 반복하지 않는다.

---

## 5. 삭제와 파생 데이터

### 5.1 삭제 작업의 범위

`POST /api/v1/admin/data-deletion/prepare`는 다음을 **모두** 계산해야 한다:

| 계층 | 예 | 확인 |
|---|---|---|
| 원본 | `messages`, `memory_records`, `files`, `artifacts` | 대상 행 |
| 버전 | `message_versions`, `file_versions`, `document_snapshots` | 파생 버전 |
| 색인 | `message_fts`, `memory_fts`, `search_tombstones` | 색인 제거 + tombstone |
| 요약·기억 | 요약 기억, 교차 공유(`memory_links`) | 파생 기억 |
| 캐시·큐 | `search_index_tasks`, `delivery_outbox` | 재색인 방지 |
| 백업 | 백업 세트 내 존재 | 보존 기간·재노출 위험 고지 |
| 외부 | GitHub 커밋·PR·이슈 | **삭제 불가** 고지 |

### 5.2 트리거가 실제로 하는 일

- `trg_message_tombstone_on_delete` → `message_tombstones` 기록 + FTS 제거
- `trg_message_restore` → 복원 시 tombstone 해제, FTS 재색인
- `trg_memory_tombstone` / `trg_memory_fts_delete` → 기억 삭제 시 색인 제거 + `search_tombstones`
- `trg_file_tombstone_on_delete`, `trg_artifact_tombstone_on_delete` → 파생 참조 정리

### 5.3 복원 후 삭제 재적용

백업은 삭제 이전 상태를 담는다. 복원하면 삭제한 데이터가 되살아날 수 있으므로:

1. 복원 시점 이후의 `search_tombstones`/`message_tombstones`를 보존해 둔다.
2. 복원 후 그 목록을 다시 적용한다(소프트 삭제 + FTS 제거).
3. 검색·다운로드·WebSocket 캐시에서 사라졌는지 확인한다(S38).
4. 백업 세트 자체의 보존 기간이 끝나기 전에는 "완전 삭제"라고 말하지 않는다.

### 5.4 외부로 나간 데이터 (한계 고지)

- GitHub에 푸시된 커밋·PR·이슈는 **불변 기록**이며 우리가 지울 수 없다. 삭제 요청 시 이 사실을 사용자에게 먼저 알린다.
- 외부 AI 제공자에게 전송된 프롬프트·응답은 그 제공자의 정책을 따른다. 우리 백업에서 지워도 제공자 쪽은 남을 수 있다.
- 이 한계를 숨기고 "모두 삭제되었습니다"라고 보고하지 않는다.

---

## 6. 백업이 없는 지금 할 수 있는 것

원격 D1·R2가 없으므로:

- 로컬 스키마·마이그레이션 무결성은 지금 검증 가능하다: `node scripts/db-migrate.mjs --check`.
- 코드·문서·계약은 git으로 보존된다. 원격 리포지토리는 아직 없다(생성은 승인 필요).
- 원격 D1이 생기는 즉시 해야 할 일:
  1. 마이그레이션 적용 직후 **첫 백업**을 뜨고 `backup_manifests`에 남긴다.
  2. 빈 DB로 복원 시험을 1회 실시하고 `restore_tested_at`을 채운다.
  3. 그 결과를 `docs/evidence/release-evidence.json`의 G-10 항목에 경로로 남긴다.

---

## 7. 복원 리허설 절차 (분기 1회)

1. 격리 환경(별도 D1 또는 로컬 SQLite)을 준비한다. **운영 DB를 쓰지 않는다.**
2. 최신 백업을 복원한다.
3. §4.2 체크리스트를 전부 실행한다.
4. 삭제 재적용(§5.3)을 실행한다.
5. 걸린 시간과 실패 항목을 기록한다.
6. 실패 항목은 이 문서의 체크리스트에 추가한다(문서가 학습하게 만든다).

리허설을 하지 않은 백업은 "복원 가능"이라고 주장할 수 없다.
