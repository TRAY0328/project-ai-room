# db/seeds — 개발용 가상 데이터 정책

- 시드 데이터는 **개발·테스트 DB에만** 넣는다. 운영 D1에는 절대 적용하지 않는다.
- 실제 AI 제공자 응답, 실제 사용자 메시지, 실제 자격 증명을 시드로 복제하지 않는다.
- 시드에서 만드는 AI 에이전트는 `verification_state='self_declared'`, `platform_admin=0`이어야 하며, `required_agents.verification_state='verified'`를 넣지 않는다(가짜 검증 금지).
- 아직 시드 SQL은 없다. 첫 시드는 웹 UI가 붙는 단계에서 "빈 상태·부분 상태·권한 거부 상태"를 화면 검증하기 위해 추가한다.
