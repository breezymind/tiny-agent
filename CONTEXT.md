# loop-agent

pi 코딩 에이전트의 반자동 계획→구현→검증 파이프라인 확장. 그릴 인터뷰로 계획을 확정하고, 자식 pi 프로세스로 구현·테스트·검수·문서 정합화를 실행한다.

## Language

**문서 정합화 (Doc Reconciliation)**:
검수 PASS 직후 한 번 실행되는 종료 단계로, 인터뷰 시점에 기록한 결정(PRD·ADR·용어집)을 최종 구현에 맞춰 최신화하는 작업.
_Avoid_: 문서 동기화, 문서 업데이트

**정합화 에이전트 (Reconciliation Agent)**:
문서 정합화를 수행하는 전용 자식 pi 프로세스. `edit/write`는 있으나 `bash`는 없으며 문서 파일만 수정한다.
_Avoid_: 문서 에이전트

**종료 단계 (Terminal Stage)**:
결과가 개선 루프를 재진입시키지 않고 워크플로를 끝내는 단계. 실패해도 워크플로를 FAIL로 되돌리지 않는다.
_Avoid_: 마무리 단계, 최종 단계

**Supersede**:
기존 ADR을 직접 수정하지 않고, 그 결정을 대체하는 새 ADR을 추가하며 원본에는 "superseded by ####" 한 줄만 붙이는 방식.
_Avoid_: ADR 덮어쓰기, ADR 수정
