import type { GoalComplexity } from "./loop-agent-planning.ts";

export const COMPLEXITY_ROUTER_TIMEOUT_MS = 30 * 1000;

const COMPLEXITY_LEVELS = new Set<GoalComplexity>(["L0", "L1", "L2", "L3"]);

export function buildComplexityRouterPrompt(objective: string): string {
  return [
    '<loop-agent-persona role="complexity-router">',
    "당신은 소프트웨어 작업 복잡도 라우터다.",
    "사용자 요청의 의미와 잠재적 영향 범위를 판단해 필요한 컨텍스트 등급만 결정하라.",
    "키워드의 존재만 세지 말고, 생략된 영향 범위와 변경 위험을 추론하라.",
    "",
    "등급 기준:",
    "- L0: 한 화면·컴포넌트 안의 문구, 메뉴, 스타일 또는 고립된 국소 삭제/수정. 데이터·API·상태·플랫폼 경계를 건드리지 않는다.",
    "- L1: 한 기능 모듈 안에서 여러 파일·호출자·테스트를 조정하지만 저장소·API·인증·플랫폼 경계를 건드리지 않는다.",
    "- L2: 모듈 간 동작, 상태 관리, 저장소, API, 공통 계약 또는 아키텍처 책임 경계를 바꾼다.",
    "- L3: 마이그레이션, 스키마, 보안, 인증, 결제, 배포 또는 대규모 신규 기능처럼 실패 비용이 큰 작업이다.",
    "불확실하거나 요청이 모호하면 더 높은 등급을 선택하라. 작업을 구현하거나 파일을 조사하지 말라.",
    "반드시 다음 JSON 하나만 반환하라: {\"complexity\":\"L0|L1|L2|L3\",\"reason\":\"짧은 한국어 근거\"}",
    "</loop-agent-persona>",
    "",
    "사용자 요청:",
    objective,
  ].join("\n");
}

export function parseComplexityRouterResult(
  output: string,
): GoalComplexity | null {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as { complexity?: unknown };
      if (
        typeof value.complexity === "string" &&
        COMPLEXITY_LEVELS.has(value.complexity as GoalComplexity)
      ) {
        return value.complexity as GoalComplexity;
      }
    } catch {
      // 진행 로그가 섞여도 마지막 JSON 판정만 사용한다.
    }
  }
  return null;
}
