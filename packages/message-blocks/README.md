# @ai-room/message-blocks

**역할:** 구조화 메시지 블록 검증/렌더

블록 14종(text·code·diff·file·task_ref…)의 스키마는 contracts의 zMessageBlock에 있다. 이 패키지는 서버측 정규화와 클라이언트 안전 렌더를 담당할 예정.

> 이 디렉터리는 이번 단계(3단계 기반 구축)에서 자리표시자다. 공통 계약은 `packages/contracts`에 있고, 계약과 충돌하는 별도 정의를 만들지 않는다.
