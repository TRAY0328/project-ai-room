# 공급자 연결 능력 실측 보고서 (Provider Capability Evidence)

- 측정일: **2026-11-21 (KST)**, 측정 시각 12:42~13:05
- 측정자: 천예준 님의 피클 (백그라운드 개발 서브에이전트)
- 측정 대상: Cloudflare(Workers/D1/R2/DO), GitHub(@TRAY0328), Q039 필수 AI 8종(ChatGPT, Claude, Gemini, PICKLE, Keyring, vooy, MUSE, CUE)
- 측정 원칙: 공식 문서와 실제 API 응답만 기록한다. 확인하지 못한 것은 `UNKNOWN`/`NO_OFFICIAL_EVIDENCE`로 남기고, 추정을 사실로 쓰지 않는다. 새 유료 추론 API 결제·가입은 하지 않았다.
- 관련 계약: `packages/contracts/src/provider.ts` (`ProviderState`, `evaluateRequiredRoster`), `services/provider-adapters/src/index.ts` (레지스트리 8종)

---

## 1. Cloudflare (플랫폼 기반)

| 항목 | 결과 | 근거 |
|---|---|---|
| 계정 | `Playtray0328@gmail.com's Account` (`e2b6a799ae8fbaa94a08b703a079be92`) | `GET /client/v4/accounts` → success:true |
| API 토큰 | 계정 범위 조회는 정상 동작. 단 `GET /user/tokens/verify`는 `code 1000 Invalid API Token`을 반환 | 아래 비고 참조 |
| Workers | **11개** 스크립트 조회 성공 | `GET /accounts/{id}/workers/scripts` |
| D1 | **5개** 데이터베이스 조회 성공 | `GET /accounts/{id}/d1/database` |
| R2 | **사용 불가 — R2 미활성** (`code 10042 "Please enable R2 through the Cloudflare Dashboard."`) | `GET /accounts/{id}/r2/buckets` |
| Durable Objects | 이번 단계에서 바인딩/배포를 하지 않아 실행 증거 없음 | — |
| workers.dev 서브도메인 | `playtray0328` | `GET /accounts/{id}/workers/subdomain` |

측정 명령(그대로 실행):

```bash
T=$(cat work/.cf_token); A=e2b6a799ae8fbaa94a08b703a079be92
curl -s -H "Authorization: Bearer $T" https://api.cloudflare.com/client/v4/accounts
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/d1/database"
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/r2/buckets"
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/workers/scripts"
```

조회된 D1 5개: `pickle-eyes`, `shoot_schedule_db`, `pickle_phone_agent_db`, `pickle-kakao-v2`, `tray-phone-control` (모두 기존 프로젝트용이며 AI ROOM용 DB는 아직 생성하지 않았다).

**비고 1 — 토큰 검증 엔드포인트:** `/user/tokens/verify`가 1000을 반환하는데도 계정 하위 리소스 조회가 성공한다. 즉 토큰이 "무효"라는 뜻이 아니라 이 토큰이 User API Token 검증 권한을 갖지 않은 형태(계정 스코프 토큰)로 발급된 것으로 보인다. 배포 단계에서 `wrangler whoami`로 재확인이 필요하다.

**비고 2 — R2:** 이전 보고에서는 "403 Forbidden"으로 기록되었으나, 오늘 실제 응답은 **R2 서비스 자체가 활성화되지 않았다**는 `10042` 오류다. 원인과 조치가 다르므로(토큰 권한 문제가 아니라 대시보드에서 R2 활성화 필요) 이번 측정값을 정본으로 둔다. R2가 필요한 기능(파일 본문, 스냅샷, 아티팩트)은 이 상태에서 **BLOCKED**이며, D1/R2 분리 원칙상 파일 기능은 R2 활성화 전까지 완료로 표시할 수 없다.

---

## 2. GitHub

| 항목 | 결과 | 근거 |
|---|---|---|
| 인증 계정 | `TRAY0328` | `gh api user --jq .login` → `TRAY0328` |
| 접근 가능 리포지토리 | 5개 (`TRAY-AGENT` private, `TRAY0328.github.io` public, `TRAY_MEMORY` private, `40minite-4k` private, `K-FRont` private) | `gh repo list --limit 20 --json name,visibility,updatedAt` |
| AI ROOM 리포지토리 | **아직 생성하지 않음** (비공개 생성·푸시 전 로컬 구축·검증 우선 조건) | 로컬 `project-ai-room/`만 존재 |
| GitHub App 설치 | 확인되지 않음 (설치 ID 없음) | 웹훅/App 토큰 미보유 |
| Actions 실행 | 이번 단계에서 실행하지 않음 → run ID·conclusion 증거 없음 | — |

`packages/contracts`와 `services/github-integration`은 웹훅 HMAC 검증, delivery 멱등성, `workflow_run` 결론 매핑(완료되지 않은 실행은 `UNKNOWN`)을 구현했지만, 실제 GitHub 호출·CI 실행은 이번 범위가 아니다. **CI 성공을 주장할 수 있는 근거는 현재 0건**이다.

---

## 3. Q039 필수 AI 8종 — 공식 연결 가능성 실측

요약: **8종 모두 `VERIFIED` 아님 → Q039 게이트 `BLOCKED_EXTERNAL_DEPENDENCY` (blocker 8/8)**.

| AI | 공식 인증 수단 | 무인 자동 실행 | Cloudflare에서 호출 | 무료 사용 | 판정 | 공식 문서 |
|---|---|---|---|---|---|---|
| ChatGPT | API 키 | 가능(API) | 가능 | 미확인(유료 과금표·지역 제한 'Free' 사용 등급) | `NOT_CONFIGURED` | platform.openai.com/docs/pricing, developers.openai.com/api/docs/guides/rate-limits |
| Claude | API 키 | 가능(API) | 가능 | 신규 계정 1회성 테스트 크레딧만 | `PAID_API_REQUIRED` | platform.claude.com/docs/en/about-claude/pricing |
| Gemini | API 키 | 가능(API) | 가능 | **무료 등급 존재**(모델별 RPM/TPM/RPD 제한, 무료 등급은 학습 활용 가능) | `NOT_CONFIGURED` | ai.google.dev/gemini-api/docs/rate-limits, aistudio.google.com/docs/billing |
| PICKLE | 공식 서버 API 문서 없음 | 불가 | 불가 | 해당 없음 | `NO_OFFICIAL_EVIDENCE` | (자체 어댑터 필요 — 스펙 07.5) |
| Keyring | 없음(로컬 데스크톱 앱) | 불가 | 불가 | 유료 라이선스 + 사용자 own API 키 | `NO_OFFICIAL_EVIDENCE` | keyringlabs.com/docs, keyringlabs.com/docs/api-settings |
| vooy | 없음(소비자 메신저 에이전트) | 불가 | 불가 | 소비자 Free 요금제(개발자 API 아님) | `NO_OFFICIAL_EVIDENCE` | vooy.com/en, vooy.com/en/docs/terms/2026-10-30 |
| MUSE (Meta Model API) | API 키 | 가능(API) | 가능 | 없음 — 종량 과금(Contributor 모드는 할인) | `PAID_API_REQUIRED` | dev.meta.ai/docs/overview, dev.meta.ai/docs/pricing-rate-limits |
| CUE (Cue AI) | API 키 | 불가 | 가능(분석 API) | 미확인 | `CAPABILITY_MISSING` | docs.trycue.ai, docs.trycue.ai/customer-analytics/getting-started |

### 3.1 ChatGPT (OpenAI)

- 공식 문서: <https://platform.openai.com/docs/pricing>, <https://developers.openai.com/api/docs/guides/rate-limits>
- 확인한 내용:
  - 가격표에 모든 현행 모델의 입력/출력 토큰 단가가 명시되어 있다(무료 모델은 moderation 1종).
  - Rate limit 문서의 사용 등급 표: `Free — User must be in an allowed geography — $100 / month`, `Build — $5 in total credit purchases` 등. 즉 "Free"는 **사용 등급(rate-limit tier)** 이름이고, 그 $100/월이 무료 추론 한도인지 지출 상한인지는 그 문서만으로 확정되지 않는다.
  - ChatGPT 구독(Pro/Business)은 별도로 API 크레딧을 제공하지만 유료 구독이 전제다.
- 이 환경의 상태: OpenAI 계정/키/잔액이 없다. 따라서 무료로 무인 호출이 가능한지 **검증되지 않았다**.
- 판정 `NOT_CONFIGURED` — 차단 사유는 "유료"가 아니라 "미검증·미설정"이다. 무료 등급 실체가 확인되면 Gemini와 같은 방식으로 연결 검증을 시도할 수 있다.

### 3.2 Claude (Anthropic)

- 공식 문서: <https://platform.claude.com/docs/en/about-claude/pricing>, <https://platform.claude.com/docs/en/api/overview>
- 확인한 내용:
  - 본문: "New users receive free credits to test the API." 즉 **1회성 테스트 크레딧**이며 지속 무인 운영 근거가 아니다.
  - 과금은 선불 크레딧 구매 기반(Claude Console). Max/Ultra/Team 유료 플랜은 월 API 크레딧을 포함하지만 구독이 전제.
- 판정 `PAID_API_REQUIRED` — "신규 유료 AI 추론 API 금지" 조건과 충돌하므로 연결하지 않았다.

### 3.3 Gemini (Google)

- 공식 문서: <https://ai.google.dev/gemini-api/docs/rate-limits>, <https://aistudio.google.com/docs/billing>
- 확인한 내용:
  - Free 등급이 공식적으로 존재하고, 모델별 RPM/TPM/RPD 한도가 적용된다. 무료 등급은 "prompts and responses may be used to improve Google products" 고지가 붙는다.
  - 유료 Tier 1은 결제 계정 연결이 필요하며 $250 상한 등이 정의되어 있다.
- 이 환경의 상태: `PROVIDER_GEMINI_API_KEY` 미설정 → 실제 호출 0건. 무료 등급의 실측 한도(RPM/RPD)는 키 발급 후에만 측정 가능.
- 판정 `NOT_CONFIGURED` — **8종 중 유일하게 "공식 무료 + 서버 무인 호출" 경로가 문서로 확인된 후보**다. 키를 제공하면 T-AI-01~08 중 01·02·04·06·08을 실제로 시험할 수 있다. 단 무료 등급의 학습 활용 조항은 사용자 동의가 필요한 사안이므로 임의로 켜지 않는다.

### 3.4 PICKLE

- 공식 문서: 없음(공개 개발자 API 문서 부재). 스펙 07.5는 "사용자가 직접 운영하는 AI는 서버 간 HTTPS/WebSocket 인증 어댑터를 구현할 수 있다. 단, 현재 대화 중인 PICKLE AI의 모델 실행을 자동으로 서버에 위탁할 수 있다고 가정하지 말라"고 명시한다.
- 이 환경의 상태: 앱 내 피클과 대화는 가능하지만, Cloudflare Worker가 호출할 수 있는 **인증된 피클 추론 엔드포인트가 없다**. 폰 앱(PICKLE PHONE AGENT)·카톡 에이전트는 로컬 기기 기반이며 CLOUD-ONLY 조건 위반이므로 연결 근거로 쓸 수 없다.
- 판정 `NO_OFFICIAL_EVIDENCE` — 자체 어댑터(예: 사용자가 운영하는 HTTPS 게이트웨이)를 별도로 만들고 그 실체를 검증해야 한다.

### 3.5 Keyring (KeyRing AI)

- 공식 문서: <https://www.keyringlabs.com/docs>, <https://www.keyringlabs.com/docs/api-settings>
- 확인한 내용:
  - Windows 로컬 데스크톱 앱. 문서에 "Local-first runtime / No shared relay — KeyRing does not proxy your prompts through a central app server"라고 명시.
  - 11개 공급자의 API 키를 OS 자격 증명 보관소에 저장하고 **사용자 PC에서 직접** 호출한다.
- 판정 `NO_OFFICIAL_EVIDENCE` (사실상 `CLOUD_ONLY` 위반) — 서버가 원격으로 호출할 API가 없고, 로컬 앱 자동화는 CLOUD-ONLY·무인 자동화 금지 조건 위반이다.

### 3.6 vooy (Vooy Korea)

- 공식 문서: <https://vooy.com/en>, 이용약관 <https://vooy.com/en/docs/terms/2026-10-30>, 개인정보 전송 고지 <https://vooy.com/en/docs/ai-transfer/2026-10-15>
- 확인한 내용:
  - 소비자용 메신저 AI 에이전트(앱/웹). 요금제는 "기본 AI 모델(Free)" + "프론티어 모델(토큰 충전)".
  - 공개된 **개발자용 API·서버 인증 절차가 없다**. 약관 제8조는 "자동화된 수단을 이용하여 서비스에 과도한 부하를 주는 행위"를 금지한다.
- 판정 `NO_OFFICIAL_EVIDENCE` — AI ROOM의 참여자로 연결할 공식 경로가 확인되지 않았다.

### 3.7 MUSE (Meta Model API)

- 공식 문서: <https://dev.meta.ai/docs/overview>, <https://dev.meta.ai/docs/pricing-rate-limits>, <https://dev.meta.ai/docs/models>
- 확인한 내용:
  - Base URL `https://api.meta.ai/v1`, Bearer `MODEL_API_KEY`, OpenAI/Anthropic 호환. Muse Wonder/Spark/Ember 등.
  - 과금: 종량(pay-as-you-go). Contributor 모드는 "heavily discounted token prices"이며 무료가 아니다.
  - Muse Spark Open·Muse Glimmer는 오픈 웨이트(자체 GPU 필요) — CLOUD-ONLY 무료 경로가 아니다.
- 판정 `PAID_API_REQUIRED`.

### 3.8 CUE (Cue AI, trycue.ai)

- 공식 문서: <https://docs.trycue.ai/>, <https://docs.trycue.ai/customer-analytics/getting-started>
- 확인한 내용: 제품 임베디드 분석(데이터 소스/모델/대시보드, Analytics REST API, JS SDK). **LLM 대화·작업 실행·코드 변경 기능이 없다.**
- 판정 `CAPABILITY_MISSING` — API 키가 있어도 AI ROOM의 AI 참여자 역할(채팅 수신/발신, 작업 수행, 코드 제출)을 수행할 수 없다.

---

## 4. Q039 게이트 판정

`services/provider-adapters`의 `q039Gate()` 실행 결과:

```
gate: BLOCKED_EXTERNAL_DEPENDENCY
blockers: 8 / 8
 - chatgpt: NOT_CONFIGURED
 - claude: PAID_API_REQUIRED
 - gemini: NOT_CONFIGURED
 - pickle: NO_OFFICIAL_EVIDENCE
 - keyring: NO_OFFICIAL_EVIDENCE
 - vooy: NO_OFFICIAL_EVIDENCE
 - muse: PAID_API_REQUIRED
 - cue: CAPABILITY_MISSING
```

이 판정은 "구현 실패"가 아니라 **외부 의존성에 의한 출시 차단**이다(스펙 34.6). 스펙 31.4에 따라 이 게이트는 전체 구현을 멈추는 조건이 아니며, 나머지 기능은 계속 개발한다.

### 게이트를 여는 데 필요한 것 (사용자 결정 사항)

1. **Gemini**: 무료 등급 API 키 1개 제공 → 무료 한도 내에서 T-AI-01/02/04/06/08 시험 가능. (무료 등급의 프롬프트 학습 활용 조항 동의 여부를 사용자가 결정해야 한다.)
2. **ChatGPT/Claude/MUSE**: "추가 유료 추론 API 금지" 조건을 해제하거나, 각 사의 무료 크레딧/구독 포함 크레딧을 쓰기로 결정해야 한다. 금액·한도는 연결 전에 별도 고지한다.
3. **PICKLE**: Cloudflare Worker가 호출할 수 있는 인증된 HTTPS 게이트웨이(사용자 운영)를 만들지 결정. 폰 앱·로컬 브리지는 CLOUD-ONLY 조건상 사용할 수 없다.
4. **Keyring/vooy**: 공식 서버 API가 없으므로 대안 AI로 교체하거나 필수 목록에서 제외하는 사용자 결정이 필요하다.
5. **CUE**: AI 참여자 역할이 불가능하므로 분석 도구로만 별도 연동하거나 목록에서 제외.

---

## 5. 이번 측정에서 하지 않은 것

- 유료 API 가입·결제·키 발급 (금지 조건)
- 브라우저 쿠키 재사용·UI 자동 조작으로 소비자 구독을 우회하는 연결 (스펙 07.2에서 금지)
- R2 활성화, D1 생성, Worker 배포 (사용자 승인 전 운영 변경 금지)
- GitHub 리포지토리 생성·푸시 (승인 전 금지)

## 6. 재검증 주기

공급자 약관·무료 한도는 언제든 바뀔 수 있으므로, 위 표는 **2026-11-21 측정값**이며 다음 단계(연결 검증 착수 시)마다 재측정한다. 재측정 시 이 문서의 표와 `services/provider-adapters/src/index.ts`의 `CHECKED_AT`를 함께 갱신한다.
