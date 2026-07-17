---
name: grill-checklist
description: Runs the external grill-with-docs interview (a /grilling session with /domain-modeling that also produces SQLite ADR and glossary records) unchanged, then converts the resolved specification and its records into a machine-readable verification checklist for automated implementation review.
---

<objective>
외부 `grill-with-docs` 스킬의 인터뷰 절차를 그대로 수행한 뒤, 합의된 명세와 그 과정에서 생성된 SQLite 문서 record(ADR·용어집)를 독립 에이전트가 검증할 수 있는 목표 결과 체크리스트로 변환한다.
</objective>

<process>

## 1단계: grill-with-docs 원본 절차 수행

`~/.pi/agent/skills/grill-with-docs/SKILL.md`를 읽는다. 이 스킬은 `/domain-modeling` 스킬을 함께 사용하는 `/grilling` 세션으로 위임되며, 인터뷰를 진행하는 동안 SQLite ADR과 용어집(glossary) record를 함께 생성한다. 위임 대상인 `/grilling`과 `/domain-modeling`의 질문 순서, 추천 방식, 종료 조건, record 생성 규칙을 변경하지 말고 그대로 따른다. 질문은 반드시 한 번에 하나씩 한다.

위임 대상 스킬의 절차를 임의로 요약하거나 대체하지 않는다. `grill-with-docs`가 위임하는 규칙에 없는 질문 순서나 종료 조건을 지어내지 않는다.

## 2단계: 확정 명세 작성

`grill-with-docs`의 의사결정 트리가 닫히면 대화에서 합의한 내용만 사용해 다음 항목을 정리한다.

- 작업 범위와 목표 동작
- 제약 조건과 명시적인 비목표
- 실패 처리 방식
- 각 결과를 확인할 검증 방법
- 인터뷰 중 생성된 ADR과 용어집 항목(SQLite 문서 key 또는 위치, 각 결정·용어의 요지)

불확실하거나 미결정된 내용을 임의로 확정하지 않는다. ADR과 용어집은 실제로 생성된 것만 기록하며, 생성되지 않은 문서를 지어내지 않는다.

## 3단계: 구현 계획 작성

확정 명세를 실제로 구현할 순서와 검증 순서로 변환한다. 계획에는 변경할 구성 요소, 각 단계의 의존 관계, 테스트 방법을 포함한다. 코드 수준에서 확인하지 않은 파일명이나 API를 지어내지 않는다.

## 4단계: 목표 결과 체크리스트 생성

확정 명세를 코드, 테스트, 명령 결과 또는 화면 동작으로 독립 검증할 수 있는 항목으로 변환한다. "정상 동작한다"처럼 측정할 수 없는 표현은 금지한다. 각 항목에는 무엇을 확인해야 하는지와 통과 조건이 드러나야 한다.

grill-with-docs가 인터뷰 중 ADR·용어집을 생성했다면, 다음도 검증 가능한 항목으로 포함한다. 예: "결정 X의 근거를 담은 SQLite 문서 record가 <key>에 존재하고 선택지·근거가 기록됐다", "용어집에 도메인 용어 Y가 정의됐다". 생성되지 않은 문서에 대한 항목은 만들지 않는다.

확장이 결과를 인식할 수 있도록 반드시 다음 경계를 정확히 사용한다.

```markdown
<!-- grill-checklist:start -->

## 목표 결과 체크리스트

- [ ] <검증 가능한 결과와 통과 조건 1>
- [ ] <검증 가능한 결과와 통과 조건 2>

<!-- grill-checklist:end -->
```

일반 실행에서는 체크리스트를 출력한 뒤 구현을 시작할지 묻는다. 구현 전에는 어떤 항목도 완료로 표시하지 않는다.

입력에 `<loop-agent-auto>` 블록이 있으면 반자동 실행 모드다. 이 모드에서도 1단계 인터뷰(`/grilling`·`/domain-modeling`)는 **평소와 똑같이 사람과 질문/답변을 한 번에 하나씩 주고받으며** 진행한다. 인터뷰를 건너뛰거나 답을 스스로 지어내 진행하지 않는다. 아직 물어야 할 질문이 남았으면 질문만 하고 그 턴을 끝낸다(체크리스트를 출력하지 않는다). 확장은 체크리스트가 없는 턴을 인터뷰 진행 중으로 보고 기다린다.

인터뷰가 완전히 끝나(의사결정 트리가 닫혀) 더 물을 것이 없을 때, 그 마지막 턴에서만 구현 계획과 목표 체크리스트를 출력한다. 이때는 구현 승인 여부를 다시 묻지 말고 응답을 체크리스트 출력으로 끝낸다. 즉 자동화되는 것은 **인터뷰가 끝난 이후의 구현·검증 실행**이며, 인터뷰 자체는 반자동으로 사람과 진행한다. 인터뷰 종료 이후 구현 실행은 확장이 담당한다.

자동 실행 블록에 워크플로 ID와 `<!-- loop-agent-workflow:... -->` 주석 출력 지시가 있으면 해당 주석을 목표 체크리스트 시작 경계 바로 앞에 정확히 한 번 출력한다. 이 ID는 취소되거나 교체된 목표의 늦은 응답을 확장이 거부하는 데 사용하므로 생략하거나 변경하지 않는다.

</process>

<success_criteria>

- [ ] `grill-with-docs`(및 위임 대상 `/grilling`·`/domain-modeling`) 원본 인터뷰 절차가 생략되거나 변경되지 않았다.
- [ ] 인터뷰 중 생성된 ADR과 용어집이 확정 명세에 반영됐고, 이를 검증하는 체크리스트 항목이 포함됐다.
- [ ] 모든 체크리스트 항목이 확정 명세에서 직접 파생됐다.
- [ ] 확정 명세를 실행 가능한 구현 및 검증 순서로 변환한 계획이 포함됐다.
- [ ] 각 항목을 독립 에이전트가 객관적인 근거로 판정할 수 있다.
- [ ] 체크리스트가 정확한 기계 판독 경계 안에 출력됐다.

</success_criteria>
