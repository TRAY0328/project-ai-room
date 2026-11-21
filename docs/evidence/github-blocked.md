# GitHub 저장소 생성 차단 기록 (2026-11-21)

비공개 리포지토리 `TRAY0328/project-ai-room`을 만들려 했으나 **Pickle의 GitHub 연결 권한으로는
저장소 생성이 거부**됐다. 시도한 명령과 실제 응답:

```
gh repo create TRAY0328/project-ai-room --private --source=. --remote=origin --push
→ GraphQL: Resource not accessible by integration (createRepository)

gh api -X POST /user/repos -f name=project-ai-room -F private=true
→ {"message":"Resource not accessible by integration","status":"403"}
```

- `gh api user` → `TRAY0328` (읽기는 정상)
- 접근 가능한 기존 저장소: `TRAY-AGENT`, `TRAY0328.github.io`, `TRAY_MEMORY`, `40minite-4k`, `K-FRont` — AI ROOM과 무관하므로 그 저장소들에 올리지 않았다.
- 로컬 커밋은 준비되어 있다: `46fd4f1` (249개 파일, 65,348줄 추가). remote는 없다.

필요한 조치(사용자 결정):
1. GitHub에서 `TRAY0328` 계정으로 **빈 비공개 저장소 `project-ai-room`** 을 만든다 → 에이전트가 remote 연결 후 push.
2. 또는 Pickle GitHub 앱 설치 권한에 **Administration: write**(저장소 생성)를 추가한다.

이 차단 때문에 G-04(GitHub PR·Actions 실행 증거)는 `BLOCKED`이며, CI Run ID·아티팩트 SHA-256은
아직 존재하지 않는다. 없는 Run ID를 만들어 적지 않는다.
