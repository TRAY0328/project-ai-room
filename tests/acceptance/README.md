# tests/acceptance

`qa_matrix.json` 103개 항목과 `security_cases.json` 50건을 **실제 실행 결과로** 추적하는 곳이다. 실행하지 않은 시험을 통과로 표시하지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `qa_matrix_runner.mjs` | 103 + 50건을 평가하고 상태·근거를 출력하는 실행기 |
| `qa_evidence_map.json` | 각 항목 → 근거(테스트 파일·이름 / 러너 검사 / 차단 사유) 매핑 |
| `identity_lifecycle.test.mjs` | AI 가입·초대·키 회전·세션 폐기 수용 테스트 |
| `policy_guards.test.mjs` | 경로·ZIP·CI 트리거·병합 정책·마스킹·메시지 렌더링·기억 ACL·SQL 인젝션 |
| `openapi_spec.test.mjs` | OpenAPI 3.1 ↔ 카탈로그 78건, 권한·테스트 ID, 문서 링크(QA-103) |
| `release_gates.test.mjs` | G-01~G-12 집계 규칙(QA-102) |
| `qa-matrix-status.json` / `.md` | `--write`가 만든 **생성물**. 손으로 고치지 않는다 |
| `release-verification.json` / `.md` | `scripts/verify-release.mjs`가 만든 **생성물** |

## 실행

```bash
node tests/acceptance/qa_matrix_runner.mjs            # 요약
node tests/acceptance/qa_matrix_runner.mjs --json     # 기계 판독(JSON)
node tests/acceptance/qa_matrix_runner.mjs --write    # 상태 문서 생성
node tests/acceptance/qa_matrix_runner.mjs --no-run   # 테스트 실행 없이 구조만
node tests/acceptance/qa_matrix_runner.mjs --filter QA-019
```

종료 코드: `0` 전부 PASS · `1` FAILED 있음 · `2` 평가 불가 · `3` 실행했으나 갭(PARTIAL/BLOCKED/NOT_TESTED) 남음.

## 상태 정의

| 상태 | 조건 |
|---|---|
| `PASS` | 연결된 근거가 전부 이 실행에서 통과했고, 기대 결과 전체를 덮는다 |
| `PARTIAL` | 근거는 통과했지만 일부 계층만 검증(`cap: "PARTIAL"`, `missing`에 설명) |
| `FAILED` | 연결된 테스트가 실패했거나, 근거 파일·테스트 이름이 사라졌다(드리프트) |
| `BLOCKED` | 외부 의존성 때문에 시험할 수 없다(`blocked: "B-xx"`) |
| `NOT_TESTED` | 근거가 없거나 테스트를 실행하지 않았다 |

`--no-run`으로 실행하면 테스트 근거는 PASS가 될 수 없다(전부 `NOT_TESTED`). 이게 정상이다.

## 새 테스트를 연결하는 방법

1. 테스트 이름을 QA id로 시작하게 짓는다: `test("QA-019 중복 메시지: …", …)`.
2. `qa_evidence_map.json`에 항목을 추가한다.

```json
"QA-019": {
  "evidence": [{ "type": "test", "file": "tests/integration/api_chat.test.mjs", "match": "room_seq is gap-free" }],
  "cap": "PARTIAL",
  "missing": "동시 30건 경쟁은 미시험"
}
```

- `match`는 그 파일 안에서 **유일한 부분 문자열**이어야 한다. 이름 전체를 적어도 된다.
- 기대 결과의 일부만 덮으면 `cap: "PARTIAL"`을 반드시 적는다. 적지 않으면 PASS로 집계되므로, **과대 주장이 되지 않게** 주의한다.
- 외부 의존성으로 막혔으면 `{"blocked":"B-01","note":"R2 미활성"}`. 차단 ID는 `docs/ASSUMPTIONS_AND_BLOCKERS.md`를 따른다.

## 러너가 직접 계산하는 검사

근거 유형 `{"type":"check","check":"<이름>"}`은 러너가 실제 파일·명령으로 계산한다. JSON에 PASS를 적어 넣는 방식이 아니다.

| 검사 | 계산 방법 |
|---|---|
| `openapi-sync` | `node scripts/gen-openapi.mjs --check` 실행 |
| `docs-links` | `docs/{api,operator-guide,user-guide,security}`의 상대 링크를 실제 경로로 해석 |
| `release-report-labels` | `FINAL_RELEASE_REPORT_TEMPLATE.md`의 라벨이 보고서에 있는지 |
| `provider-gate` | `@ai-room/provider-adapters`의 `q039Gate()` 실행 |
| `permission-coverage` | 카탈로그 78 오퍼레이션 ↔ `ENDPOINT_ACTIONS` 매핑 |

## 하지 말 것

- 상태를 손으로 고쳐 PASS로 만들지 않는다. 다음 실행에서 되돌아가고, 그 사이 판단이 오염된다.
- 테스트 파일을 지우고 매핑을 남기지 않는다. 드리프트는 FAILED로 드러나야 한다.
- `PARTIAL`을 `PASS`처럼 보고하지 않는다.
