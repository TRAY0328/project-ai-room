# @ai-room/search

**역할:** 검색 인덱싱

search_index_tasks 큐와 search_tombstones 전파를 소비한다. 권한 필터는 반드시 contracts.evaluate()를 통과한 결과에만 적용.

> 이 디렉터리는 이번 단계(3단계 기반 구축)에서 자리표시자다. 공통 계약은 `packages/contracts`에 있고, 계약과 충돌하는 별도 정의를 만들지 않는다.
