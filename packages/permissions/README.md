# @ai-room/permissions

**역할:** 정책 엔진 래퍼

권한 판정 자체는 `packages/contracts/src/permissions.ts`의 evaluate()로 단일화했다. 이 패키지는 D1 ACL 조회와 판정 결과 캐시를 담당할 예정이며 현재는 계약을 재노출하지 않는다(중복 정의 금지).

> 이 디렉터리는 이번 단계(3단계 기반 구축)에서 자리표시자다. 공통 계약은 `packages/contracts`에 있고, 계약과 충돌하는 별도 정의를 만들지 않는다.
