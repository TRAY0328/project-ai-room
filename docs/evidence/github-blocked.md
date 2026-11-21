# GitHub 반영 상태 (2026-11-21)

## 반영된 것

- 저장소: `https://github.com/TRAY0328/project-ai-room` — **PUBLIC**. 사용자가 "일부러 Public으로 했어요 — 이대로 푸시 진행해 줘"로 명시 승인했다(브리프의 비공개 요구를 사용자가 변경).
- `main` 최신 커밋 `76692d2` — 300개 파일(모노레포 전체 + 증거 문서). 원격 `pushed_at 2026-11-21T05:06:48Z`.

## 막힌 것 — 워크플로 파일 업로드 권한

Pickle의 GitHub 연결(설치 토큰)에 **`workflows` 쓰기 권한이 없다.** 그래서 `.github/workflows/*` 를 포함한 푸시는 거부된다:

```
! [remote rejected] main -> main
  (refusing to allow a GitHub App to create or update workflow `.github/workflows/_policy_check.mjs`
   without `workflows` permission)
```

- Contents API로 직접 만들려 해도 같은 이유로 403(`Resource not accessible by integration`).
- 일반 파일 쓰기는 성공한다(probe.txt 생성·삭제로 확인) → 워크플로 파일에만 걸린 제한이다.
- 그래서 현재 원격 `main`에는 CI 워크플로가 **없고**, GitHub Actions 실행 기록도 **0건**이다. Run ID·아티팩트 SHA-256은 존재하지 않는다.

## 조치 후 예정

1. Pickle GitHub 앱 설치 권한에서 **Workflows: Read and write** 를 켠다.
2. 로컬 `main`에 이미 준비된 커밋 `cbcd3a8`(워크플로 5종 + `_policy_check.mjs`)을 푸시한다.
3. `verify`·`build-web`·`build-windows`·`build-android`·`security` 5종 실행을 추적하고 Run ID·아티팩트 SHA-256을 이 문서와 `release-evidence.json`에 기록한다.

## 참고 — 공개 저장소에 포함된 개인 정보

사용자 승인으로 공개했으므로 아래는 **의도된 공개**로 본다. 다만 되돌리려면 알려야 한다.

- `LICENSE`: `Copyright (c) 2026 천예준 (TRAY0328)` (저장소 소유자 본인 이름)
- `apps/web/src/demo/fixtures.ts`: 데모 데이터의 소유자 표시 이름 `천예준`, 프로젝트 이름 `대덕소마고 준비`
- 토큰·전화번호·이메일·주소·비밀키: **없음** (`cfat_`/`ghp_`/`sk-`/PRIVATE KEY 패턴 스캔 결과 테스트용 가짜 값만 존재)
