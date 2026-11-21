# ADR 0001 — 모노레포와 로컬 검증 도구 선택

- 상태: 채택 (2026-11-21)
- 관련: 스펙 04.1, 04.2, 32.1, 32.2, 24

## 맥락

Q040은 모든 트랙(A~H)을 병렬 개발하되, 계약을 먼저 고정하라고 요구한다. 이 환경의 Node는 22.20.0이고 `pnpm`은 설치되어 있지 않으며 corepack의 네트워크 설치도 보장되지 않는다. 또한 D1 원격 생성은 사용자 승인 전 금지다.

## 결정

1. **npm workspaces를 1차 도구로** 사용하고 `pnpm-workspace.yaml`은 호환용으로 함께 둔다. lockfile은 `package-lock.json` 하나만 커밋한다.
2. TypeScript 프로젝트 레퍼런스(`tsconfig.build.json`)로 contracts → services 순서를 강제한다.
3. 로컬 DB 검증은 **node:sqlite**(SQLite 3.50.4 내장)로 한다. 네이티브 모듈(better-sqlite3) 빌드 없이 실제 SQLite 의미론(FK, CHECK, 트리거, FTS5)를 그대로 시험할 수 있다.
4. 스펙 팩은 리포지토리에 복사하지 않고 `../work/ai_room_pack/PROJECT_AI_ROOM`에서 읽어 검증 스크립트만 사용한다. 생성된 카탈로그(`api-catalog.generated.ts`)는 커밋해 빌드가 팩에 의존하지 않게 한다.

## 결과

- 장점: 설치 마찰 없음, 결정적 재현, D1 승인 전에도 16개 무결성 테스트 확보.
- 단점: `node:sqlite`는 실험 기능 경고가 뜨고 D1과 SQLite 버전이 다르다 → 원격 D1에서 같은 테스트를 다시 돌려야 G-10이 확정된다(B-05).
- pnpm 전환 시: `pnpm import`로 lockfile을 변환하고 CI 캐시·`npm ci` 단계를 교체한다. 혼용 금지.
