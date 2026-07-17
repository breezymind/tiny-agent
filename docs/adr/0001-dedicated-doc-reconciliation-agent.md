# 검수 PASS 이후 문서 정합화를 전용 자식 에이전트로 분리한다

loop-agent 파이프라인은 그릴 인터뷰 시점에 SQLite ADR·용어집 record를 만들지만 구현이 진행되며 이 record가 낡아도 갱신할 장치가 없었다. 검수(read-only) PASS 직후 issue-store CLI를 사용하는 **전용 문서 정합화 자식 에이전트**를 한 번 실행해 인터뷰 시점 결정과 최종 코드의 차이를 반영하기로 한다. 대안으로 (1) 코드 에이전트가 정합화를 겸함, (3) 검수 에이전트가 겸함을 검토했으나, (1)은 문서 갱신이 코드 턴에 묻혀 누락되기 쉽고 (3)은 검수가 의도적으로 읽기 전용이라 부적합했다. 전용 자식으로 두면 검수와 대칭이고 독립 문맥에서 편향 없이 차이를 잡아내며 seam이 정확히 하나만 늘어난다.

## Status

accepted

## Consequences

- 정합화는 **종료(마무리) 단계**다. 문서가 낡았다는 사실이 워크플로를 FAIL로 되돌리지 않으며, 정합화 자체 실패(타임아웃·프로세스 오류)도 경고만 남기고 최종 상태는 성공(reviewed)으로 귀결한다.
- 용어집은 `put-context`로 전체 SQLite record를 최신화한다. ADR은 "결정의 역사"이므로 append-only supersede만 허용하며, 기존 record를 수정하지 않고 `put-adr`로 새 record를 추가한다. supersede는 PRD/ADR 결정과 코드가 명백히 모순될 때만 하고, 모호하면 보고만 한다.
- 정합화 자식은 프로젝트 Markdown 파일에 `read,edit,write`를 사용하지 않고 issue-store CLI만 사용한다. 소스 코드는 건드리지 않으며, PRD·ADR·용어집·관련 문서는 모두 SQLite record를 갱신한다.
