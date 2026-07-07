import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// loop-agent: 새 세션의 첫 메시지 또는 /goal을 자동 계획 파이프라인으로 감싸
// 하나의 턴에서 grill-with-docs → to-prd → to-issues → grill-checklist
// 순서로 수행한다. 마지막 grill-checklist가 기계 판독 경계 안에 목표
// 체크리스트를 출력하면, 그 뒤 확장이 implement→test→review 루프를 이어간다.
//
// 동작 원리: pi는 입력 텍스트가 "/skill:이름"으로 시작하면 해당 스킬 파일
// 전체 내용을 <skill> 블록으로 확장해 프롬프트에 끼워 넣는다
// (agent-session.js의 _expandSkillCommand). input 이벤트의 transform 결과가
// 이 확장 단계보다 먼저 적용되므로, 여기서 텍스트 앞에 "/skill:grill-checklist "를
// 붙이기만 하면 실제 스킬 확장은 pi 코어가 대신 처리해준다.
//
// 스킬 파일이 없거나 이름이 다르면 _expandSkillCommand가 원본 텍스트를 그대로
// 통과시키므로 최악의 경우에도 요청 자체가 깨지진 않는다(다만 리터럴
// "/skill:grill-checklist ..." 문자열이 그대로 모델에 전달될 수 있다).
const SKILL_NAME = "grill-checklist";
// 자동 계획 턴은 grill-checklist 단독이 아니라 다음 순서로 여러 스킬을
// 하나의 턴에서 수행한다:
//   grill-with-docs → to-prd → to-issues → grill-checklist
// grill-checklist가 마지막에 목표 체크리스트를 출력하므로, agent_end가
// 그 체크리스트를 감지해 implement→test→review 루프로 이어간다.
const PLANNING_PIPELINE_SKILLS = [
  "grill-with-docs",
  "to-prd",
  "to-issues",
  SKILL_NAME,
] as const;
const CHECKLIST_START = "<!-- grill-checklist:start -->";
const CHECKLIST_END = "<!-- grill-checklist:end -->";
const WORKFLOW_MARKER_PREFIX = "<!-- loop-agent-workflow:";
const REVIEW_START = "<!-- grill-review:start -->";
const REVIEW_END = "<!-- grill-review:end -->";
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const CODING_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_FORMAT_RETRIES = 2;
const CONFIG_PATH = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "settings.json",
);
const CHECKLIST_SKILL_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "skills",
  SKILL_NAME,
  "SKILL.md",
);

function skillPath(skillName: string): string {
  return path.join(path.dirname(CONFIG_PATH), "skills", skillName, "SKILL.md");
}

// to-prd/to-issues are the issue tracker's implementation is delegated to this doc.
// docs/agents/issue-tracker.md at the project root defines where/how issues are
// published. CONFIG_PATH is settings.json, so its directory is the project root.
const ISSUE_TRACKER_DOC_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "docs",
  "agents",
  "issue-tracker.md",
);

// 로컬 이슈 트래커 파일 트리(issue-tracker.md 규약과 일치). 코딩 에이전트가
// 이 경로들을 직접 수정해 태스크 상태를 이동시킨다.
const TASKS_BACKLOG_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "docs",
  "tasks",
  "backlog.md",
);
const TASKS_CURRENT_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "docs",
  "tasks",
  "current.md",
);
const TASKS_ARCHIVE_DIR = path.join(
  path.dirname(CONFIG_PATH),
  "docs",
  "tasks",
  "archive",
);
const CHANGES_DIR = path.join(path.dirname(CONFIG_PATH), "docs", "changes");

// 현재 연-월(YYYY-MM). archive/changes의 월별 파일명과 changes 날짜에 쓴다.
// 자식 코딩 프로세스가 아니라 부모 확장이 프롬프트를 구성할 때 계산한다.
function currentYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// 코딩 에이전트(초기 실행·개선 라운드)에게 태스크 상태 파일 이동을
// 강제하는 공통 지침. 파일 이동은 edit/write 도구를 가진 에이전트가
// 수행해야 신뢰할 수 있으므로 확장이 직접 파싱하지 않고 지침을 주입한다.
function buildTaskTrackingInstructions(): string {
  const month = currentYearMonth();
  return [
    "<task-tracking>",
    `이 프로젝트의 이슈 트래커는 로컬 파일 트리다. 규약은 ${ISSUE_TRACKER_DOC_PATH} 참조.`,
    "작업 시작·진행·완료에 따라 아래 파일을 반드시 직접 수정하라(edit/write). 외부 트래커를 찾지 말라.",
    "",
    `1) 착수: 이번에 구현할 큰 태스크(T-###) 블록을 ${TASKS_BACKLOG_PATH}의 ## Backlog에서 잘라내`,
    `   ${TASKS_CURRENT_PATH}의 ## In progress로 옮기고 **Status:**를 in-progress로 바꿔라. 해당 태스크가`,
    "   backlog에 아직 없다면(즉석 목표) current.md에 새 T-### 블록을 만들어 추가하라.",
    `2) 완료: 모든 수용 기준을 만족하면 current.md의 해당 T-### 블록을 잘라내`,
    `   ${path.join(TASKS_ARCHIVE_DIR, `${month}.md`)}의 ## Done으로 옮기고 **Status:**를 done으로 바꿔라.`,
    "   블록 내용을 지우지 말고 이동만 하라(감사 추적). 아카이브 파일이 없으면 새로 생성하라.",
    `3) 사소한 변경: 큰 태스크가 아닌 부수 변경(오타·문구·리팩터·설정 등)은`,
    `   ${path.join(CHANGES_DIR, `${month}.md`)}에 "- ${month}-DD: 요약 (관련 T-### 있으면 참조)" 형태로 append하라.`,
    "</task-tracking>",
  ].join("\n");
}

// 구현 단계에서 따를 스킬: implement(구현 절차) + tdd(red-green-refactor 규율).
// 코딩 자식 프로세스는 --no-skills로 도다부로 /skill 확장이 안 먹으므로,
// 계획 파이프라인처럼 스킬 본문을 <skill> 블록으로 직접 주입한다.
const IMPLEMENT_PIPELINE_SKILLS = ["implement", "tdd"] as const;

// implement/tdd 스킬 본문을 그대로 넣되, 이 파이프라인과 충돌하는 지시(/tdd·
// /code-review 슬래시 호출, 자체 커밋)를 어댑터 문구로 덮어쓴다. code-review는
// 확장이 독립 검수(runValidatedReview)로 수행하므로 자식이 중복 수행하지 않게 한다.
function buildImplementSkillGuidance(): string {
  const skillBlocks = IMPLEMENT_PIPELINE_SKILLS.map((skillName) =>
    buildSkillBlock(skillName, skillPath(skillName)),
  ).join("\n\n");

  return [
    skillBlocks,
    "",
    "<implement-adapter>",
    "위 implement·tdd 스킬의 구현 절차와 테스트 규율(red-green-refactor, vertical slice,",
    "내부 mocking 금지, 공개 인터페이스 기준 테스트)을 그대로 따르되, 이 자동 파이프라인에",
    "맞게 아래를 적용한다:",
    "- 스킬 본문의 `/tdd`, `/code-review` 같은 슬래시 호출은 무시하라. 이 프로세스는 --no-skills라",
    "  슬래시 확장이 동작하지 않는다. tdd 규율은 위 tdd 스킬 본문을 그대로 적용하면 된다.",
    "- 코드 검수(code-review)는 네가 하지 마라. 별도 독립 검수 에이전트가 이후에 체크리스트를 검증한다.",
    "- 직접 git 커밋/푸시하지 마라. 변경만 남기고 보고하면 확장이 검수·후속을 처리한다.",
    "- 스킬이 언급하는 gsd_*, .gsd/*, S##/T## 등 GSD 전용 도구·경로는 이 프로젝트에 없으니",
    "  무시하고, 태스크 상태는 위 <task-tracking> 지침(docs/tasks/*)으로만 관리하라.",
    "- 테스트 실행 자체는 해도 되지만, 최종 판정은 별도 테스트·검수 에이전트가 다시 확인한다.",
    "</implement-adapter>",
  ].join("\n");
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as string[]).includes(value)
  );
}

type WorkflowConfig = {
  planningModel: string | null;
  codingModel: string | null;
  // 검수(review) 전용 모델. 설정하지 않으면 planningModel을 이어받는다.
  verifyingModel: string | null;
  // 테스트 전용 모델. 설정하지 않으면 codingModel을 이어받는다.
  testModel: string | null;
  planningThinkingLevel: ThinkingLevel | null;
  codingThinkingLevel: ThinkingLevel | null;
  verifyingThinkingLevel: ThinkingLevel | null;
  testThinkingLevel: ThinkingLevel | null;
  maxImprovementRounds: number;
};

type SettingsFile = {
  loopAgent?: Partial<WorkflowConfig>;
  [key: string]: unknown;
};

type FailedItem = {
  item: string;
  reason: string;
  evidence: string;
};

type ReviewResult = {
  overall: "PASS" | "FAIL";
  failedItems: FailedItem[];
};

type ReviewStage =
  | "idle"
  | "awaiting-execution"
  | "testing"
  | "reviewing"
  | "reviewed"
  | "failed";

type GateState = {
  enabled: boolean;
  // 다음 사용자 입력을 grill-checklist로 감쌀지 여부. 새 세션이 시작될 때만 켜지고,
  // 첫 입력을 소비하는 순간(성공 여부와 무관하게) 다시 꺼진다.
  armed: boolean;
  // grill-checklist가 만든 최종 체크리스트와 후속 검수 상태를 한곳에서 관리한다.
  // 체크리스트가 생성된 턴 자체를 구현 완료로 오인하지 않도록 awaiting-execution
  // 단계를 별도로 둔다.
  reviewStage: ReviewStage;
  checklist: string | null;
  improvementRound: number;
  // /goal로 시작한 작업만 체크리스트 생성 직후 구현까지 자동 진행한다.
  // 일반 대화는 기존처럼 사용자의 구현 승인을 기다린다.
  autoMode: boolean;
  // 비동기 코드 실행과 검수 결과가 다른 목표의 상태를 덮어쓰지 않도록 각
  // 워크플로에 고유 ID를 부여한다. processingWorkflowId는 중복 agent_end 진입을 막는다.
  workflowId: string | null;
  processingWorkflowId: string | null;
};

type PersistedWorkflowState = Pick<
  GateState,
  "reviewStage" | "checklist" | "improvementRound" | "autoMode" | "workflowId"
>;

const state: GateState = {
  enabled: true,
  armed: false,
  reviewStage: "idle",
  checklist: null,
  improvementRound: 0,
  autoMode: false,
  workflowId: null,
  processingWorkflowId: null,
};

const DEFAULT_CONFIG: WorkflowConfig = {
  planningModel: null,
  codingModel: null,
  verifyingModel: null,
  testModel: null,
  planningThinkingLevel: null,
  codingThinkingLevel: null,
  verifyingThinkingLevel: null,
  testThinkingLevel: null,
  maxImprovementRounds: 3,
};

/** 잘못된 설정 파일 하나 때문에 확장 전체가 로드 실패하지 않도록 기본값으로 복구한다. */
function loadConfig(): WorkflowConfig {
  try {
    const settings = JSON.parse(
      fs.readFileSync(CONFIG_PATH, "utf8"),
    ) as SettingsFile;
    const parsed = settings.loopAgent ?? {};
    return {
      planningModel:
        typeof parsed.planningModel === "string" ? parsed.planningModel : null,
      codingModel:
        typeof parsed.codingModel === "string" ? parsed.codingModel : null,
      verifyingModel:
        typeof parsed.verifyingModel === "string"
          ? parsed.verifyingModel
          : null,
      testModel:
        typeof parsed.testModel === "string" ? parsed.testModel : null,
      planningThinkingLevel: isThinkingLevel(parsed.planningThinkingLevel)
        ? parsed.planningThinkingLevel
        : null,
      codingThinkingLevel: isThinkingLevel(parsed.codingThinkingLevel)
        ? parsed.codingThinkingLevel
        : null,
      verifyingThinkingLevel: isThinkingLevel(parsed.verifyingThinkingLevel)
        ? parsed.verifyingThinkingLevel
        : null,
      testThinkingLevel: isThinkingLevel(parsed.testThinkingLevel)
        ? parsed.testThinkingLevel
        : null,
      maxImprovementRounds:
        Number.isInteger(parsed.maxImprovementRounds) &&
        Number(parsed.maxImprovementRounds) >= 0 &&
        Number(parsed.maxImprovementRounds) <= 20
          ? Number(parsed.maxImprovementRounds)
          : DEFAULT_CONFIG.maxImprovementRounds,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let config = loadConfig();

/** 검수 단개에 쓸 유효 모델을 계획(planning) 설정으로 폴백해 계산한다. */
function resolveVerifyingModel(): string | null {
  return config.verifyingModel ?? config.planningModel;
}

function resolveVerifyingThinkingLevel(): ThinkingLevel | null {
  return config.verifyingThinkingLevel ?? config.planningThinkingLevel;
}

/** 테스트 단개에 쓸 유효 모델을 코드(coding) 설정, 최종적으로 현재 세션 모델까지 폴백해 계산한다. */
function resolveTestModel(ctx: ExtensionContext): string | null {
  return (
    config.testModel ??
    config.codingModel ??
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null)
  );
}

function resolveTestThinkingLevel(): ThinkingLevel | null {
  return config.testThinkingLevel ?? config.codingThinkingLevel;
}

/**
 * pi.sendUserMessage()는 의도적으로 /skill 명령 확장을 건너뛴다. /goal처럼
 * 확장이 직접 시작하는 턴에서는 Pi 코어와 동일한 형태의 skill 블록을 만들어
 * 전달해야 실제 스킬 지침이 모델 문맥에 포함된다.
 */
function buildSkillBlock(skillName: string, skillFilePath: string): string {
  const source = fs.readFileSync(skillFilePath, "utf8");
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  return [
    `<skill name="${skillName}" location="${skillFilePath}">`,
    `References are relative to ${path.dirname(skillFilePath)}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
}

/**
 * 자동 계획 턴에 필요한 스킬 지침을 모두 주입한다. 파이프라인은
 * grill-with-docs → to-prd → to-issues → grill-checklist 순서로 하나의 턴에서
 * 진행되며, 마지막에 grill-checklist가 기계 판독 경계 안에 목표 체크리스트를
 * 출력해야 한다. 스킬 파일이나 issue-tracker.md가 하나라도 없으면 파이프라인이
 * 성립하지 않으므로 readFileSync 실패를 그대로 상위(/goal 핸들러)로 전파한다.
 */
function buildPlanningPipelinePrompt(
  objective: string,
  workflowId: string,
): string {
  const skillBlocks = PLANNING_PIPELINE_SKILLS.map((skillName) =>
    buildSkillBlock(skillName, skillPath(skillName)),
  ).join("\n\n");

  // to-prd/to-issues는 "이슈 트래커가 제공되었다"는 전제로 동작하므로,
  // 발행 규약(issue-tracker.md)을 반드시 프롬프트에 함께 주입한다. 문서가
  // 없으면 발행 대상을 알 수 없으므로 명시적으로 실패시켜 /goal을 멈춘다.
  const issueTrackerDoc = fs.readFileSync(ISSUE_TRACKER_DOC_PATH, "utf8").trim();
  const issueTrackerBlock = [
    `<issue-tracker location="${ISSUE_TRACKER_DOC_PATH}">`,
    "to-prd와 to-issues가 이슈를 발행·조회할 때 따라야 하는 유일한 규약이다.",
    "외부 트래커 CLI나 MCP를 가정하지 말고 이 문서의 로컬 작업 목록 파일 규약만 사용하라.",
    "",
    issueTrackerDoc,
    "</issue-tracker>",
  ].join("\n");

  return [
    skillBlocks,
    "",
    issueTrackerBlock,
    "",
    "<loop-agent-pipeline>",
    "이 목표는 아래 스킬을 정확히 이 순서대로 수행하는 반자동 워크플로다.",
    "1) grill-with-docs: 인터뷰는 반드시 한 번에 하나씩, 사람과 질문/답변을 주고받으며 진행해 의사결정 트리를 닫고, 진행 중 ADR·용어집을 생성한다.",
    "   아직 물을 질문이 남았으면 그 턴은 질문으로 끝내고 사람의 답변을 기다린다. 답을 스스로 지어내거나 인터뷰를 건너뛰지 말라.",
    "2) to-prd: 인터뷰가 완전히 끝난 뒤, 합의한 내용만으로 PRD를 작성해 docs/tasks/backlog.md에 발행한다. 추가 인터뷰는 하지 않는다.",
    "3) to-issues: PRD를 tracer-bullet vertical slice 태스크로 쪼개 docs/tasks/backlog.md에 발행한다.",
    "발행은 반드시 <issue-tracker> 문서가 지정한 docs/tasks/backlog.md에 append-only로 한다. 외부 트래커를 찾지 말라.",
    "4) grill-checklist: 위 결과를 확정 명세·구현 계획·목표 결과 체크리스트로 변환한다.",
    "암묵적으로 단계를 건너뛰거나 순서를 바꾸지 말고, 각 스킬 본문의 절차를 그대로 따른다.",
    "인터뷰가 끝나 to-prd~grill-checklist까지 마치는 턴에서만 grill-checklist의 기계 판독 경계 안에 최종 목표 체크리스트를 한 번만 출력한다.",
    "</loop-agent-pipeline>",
    "",
    objective,
    "",
    "<loop-agent-auto>",
    "이 작업은 반자동 실행 모드다. 1단계 인터뷰는 사람과 질문/답변을 주고받아 진행하고, 그 이후의 구현·검증만 확장이 자동으로 실행한다.",
    `워크플로 ID는 ${workflowId}다. 최종 체크리스트 바로 앞에 ${WORKFLOW_MARKER_PREFIX}${workflowId} --> 주석을 정확히 출력하라.`,
    "아직 물을 질문이 남았으면 이번 턴은 질문으로 끝내라(체크리스트를 출력하지 말라). 인터뷰가 완전히 끝난 뒤에만 구현 계획과 목표 체크리스트를 작성하라.",
    "체크리스트를 출력하는 마지막 턴에서는 구현 승인 여부를 다시 묻지 말라. 확장이 코드 에이전트를 자동 실행한다.",
    "</loop-agent-auto>",
  ].join("\n");
}

function extractWorkflowId(text: string): string | null {
  const pattern = /<!-- loop-agent-workflow:([0-9a-f-]{36}) -->/i;
  return text.match(pattern)?.[1] ?? null;
}

/** 세션 브랜치에 상태 스냅샷을 남겨 reload/resume 시 동일한 루프를 복구한다. */
function persistWorkflowState(pi: ExtensionAPI, reason: string): void {
  const snapshot: PersistedWorkflowState = {
    reviewStage: state.reviewStage,
    checklist: state.checklist,
    improvementRound: state.improvementRound,
    autoMode: state.autoMode,
    workflowId: state.workflowId,
  };
  pi.appendEntry("loop-agent-state", { reason, snapshot });
}

/** 현재 브랜치의 마지막 유효 스냅샷만 복구하며 실행 중 잠금은 새로 시작한다. */
function restoreWorkflowState(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: string;
      customType?: string;
      data?: { snapshot?: Partial<PersistedWorkflowState> };
    };
    if (entry.type !== "custom" || entry.customType !== "loop-agent-state")
      continue;

    const snapshot = entry.data?.snapshot;
    if (!snapshot) return false;
    state.reviewStage = snapshot.reviewStage ?? "idle";
    state.checklist =
      typeof snapshot.checklist === "string" ? snapshot.checklist : null;
    state.improvementRound = Number.isInteger(snapshot.improvementRound)
      ? Number(snapshot.improvementRound)
      : 0;
    state.autoMode = snapshot.autoMode === true;
    state.workflowId =
      typeof snapshot.workflowId === "string" ? snapshot.workflowId : null;
    state.processingWorkflowId = null;
    return true;
  }
  return false;
}

/**
 * settings.json의 다른 Pi 설정은 그대로 보존하고 loopAgent 영역만 갱신한다.
 * Pi 설정 관리자는 알 수 없는 키도 보존하므로 /settings에서 다른 값을 바꿔도
 * 이 확장의 모델 설정이 사라지지 않는다.
 */
function saveConfig(): void {
  const settings = JSON.parse(
    fs.readFileSync(CONFIG_PATH, "utf8"),
  ) as SettingsFile;
  settings.loopAgent = { ...config };
  fs.writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

function parseModelName(
  modelName: string,
): { provider: string; modelId: string } | null {
  const separator = modelName.indexOf("/");
  if (separator <= 0 || separator === modelName.length - 1) return null;
  return {
    provider: modelName.slice(0, separator),
    modelId: modelName.slice(separator + 1),
  };
}

/**
 * 설정된 provider/model을 실제 레지스트리에서 확인한 뒤 현재 세션에 적용하고,
 * thinkingLevel이 설정돼 있으면 모델 선택 성공 여부와 무관하게 함께 적용한다.
 * modelName이 null(현재 모델 유지)이어도 thinkingLevel만 바꿀 수 있어야 하므로
 * 두 설정은 서로 독립적으로 처리한다.
 */
async function selectModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelName: string | null,
  thinkingLevel: ThinkingLevel | null,
  role: "계획" | "코드",
): Promise<boolean> {
  let ok = true;

  if (modelName) {
    const parsed = parseModelName(modelName);
    const model = parsed
      ? ctx.modelRegistry.find(parsed.provider, parsed.modelId)
      : undefined;
    if (!model) {
      ctx.ui.notify(
        `loop-agent: ${role} 모델을 찾을 수 없습니다: ${modelName}`,
        "error",
      );
      ok = false;
    } else {
      const selected = await pi.setModel(model);
      if (!selected) {
        ctx.ui.notify(
          `loop-agent: ${role} 모델 인증을 사용할 수 없습니다: ${modelName}`,
          "error",
        );
      }
      ok = selected;
    }
  }

  if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);

  return ok;
}

/**
 * 다양한 AgentMessage 중 마지막 어시스턴트 메시지의 텍스트만 합친다.
 * agent_end.messages에는 이전 대화도 들어 있으므로 마지막 응답만 확인해야
 * 과거 체크리스트를 매 턴 새 체크리스트로 잘못 인식하지 않는다.
 */
function getLastAssistantText(event: AgentEndEvent): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };

    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";

    return message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }

  return "";
}

/** grill-checklist가 약속한 주석 경계 사이의 체크리스트를 원문 그대로 꺼낸다. */
function extractChecklist(text: string): string | null {
  const start = text.indexOf(CHECKLIST_START);
  if (start < 0) return null;

  const contentStart = start + CHECKLIST_START.length;
  const end = text.indexOf(CHECKLIST_END, contentStart);
  if (end < 0) return null;

  const checklist = text.slice(contentStart, end).trim();
  return checklist.length > 0 ? checklist : null;
}

/** 검수 에이전트의 기계 판독 JSON을 엄격히 검사해 재귀 개선 입력으로 사용한다. */
function extractReviewResult(report: string): ReviewResult {
  const start = report.indexOf(REVIEW_START);
  const end = report.indexOf(REVIEW_END, start + REVIEW_START.length);
  if (start < 0 || end < 0)
    throw new Error("검수 보고서에 구조화된 판정 블록이 없습니다.");

  const parsed = JSON.parse(
    report.slice(start + REVIEW_START.length, end).trim(),
  ) as Partial<ReviewResult>;
  if (parsed.overall !== "PASS" && parsed.overall !== "FAIL") {
    throw new Error("검수 보고서의 overall 판정이 올바르지 않습니다.");
  }

  const failedItems = Array.isArray(parsed.failedItems)
    ? parsed.failedItems.filter(
        (item): item is FailedItem =>
          typeof item?.item === "string" &&
          typeof item?.reason === "string" &&
          typeof item?.evidence === "string",
      )
    : [];

  if (parsed.overall === "FAIL" && failedItems.length === 0) {
    throw new Error("FAIL 판정에 실패 항목이 포함되지 않았습니다.");
  }
  return { overall: parsed.overall, failedItems };
}

/**
 * 구현 에이전트와 문맥이 분리된 Pi 프로세스에 검수를 맡긴다.
 * --no-extensions는 이 확장이 자식 프로세스에서도 다시 실행되는 재귀를 막고,
 * 쓰기 가능한 bash/edit/write를 제공하지 않아 검수 과정의 결과 수정을 기술적으로 막는다.
 */
async function runIndependentReview(
  pi: ExtensionAPI,
  cwd: string,
  checklist: string,
  modelName: string | null,
  thinkingLevel: ThinkingLevel | null,
  testReport: string | null,
): Promise<string> {
  const prompt = [
    "당신은 구현 에이전트와 독립된 결과 검수 에이전트다.",
    "현재 작업 디렉터리의 실제 파일과 기존 테스트 코드를 직접 확인하라.",
    "아래 체크리스트의 각 항목을 PASS, FAIL, UNKNOWN 중 하나로 판정하라.",
    "추측으로 PASS 처리하지 말고 파일 경로, 코드 위치, 기존 검증 기록 등 근거를 항목마다 적어라.",
    "FAIL 또는 UNKNOWN이 하나라도 있으면 전체 판정은 미통과다.",
    testReport
      ? "아래 별도 테스트 에이전트의 실행 보고서를 근거 중 하나로 활용하라. 보고서 내용을 무비판적으로 신뢰하지 말고 실제 파일과 대조하라."
      : "실행 도구가 없어 새 테스트를 실행할 수 없으면 기존 근거만으로 판단하고 필요 시 UNKNOWN으로 판정하라.",
    "검수 보고서만 한국어로 출력하라.",
    'FAIL JSON 형식: {"overall":"FAIL","failedItems":[{"item":"체크리스트 원문","reason":"실패 이유","evidence":"확인 근거"}]}',
    'PASS JSON 형식: {"overall":"PASS","failedItems":[]}',
    `보고서 마지막 줄들에서 먼저 ${REVIEW_START}를 출력하라.`,
    "그 다음 줄에 실제 판정 JSON 객체 하나만 출력하라.",
    `마지막으로 ${REVIEW_END}를 출력하라.`,
    "두 경계 사이에는 설명, 접두어, 마크다운 코드 펜스를 넣지 말라.",
    "",
    ...(testReport ? ["테스트 에이전트 실행 보고서:", testReport, ""] : []),
    "검수 체크리스트:",
    checklist,
  ].join("\n");

  const args = [
    "--mode",
    "text",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    "read,grep,find,ls",
  ];
  if (modelName) args.push("--model", modelName);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  args.push(prompt);

  const result = await pi.exec("pi", args, { cwd, timeout: REVIEW_TIMEOUT_MS });

  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`독립 검수 에이전트 실행 실패: ${reason}`);
  }

  const report = result.stdout.trim();
  if (!report)
    throw new Error("독립 검수 에이전트가 빈 보고서를 반환했습니다.");
  return report;
}

/** 형식 오류만 제한적으로 재시도하고, 실행 실패는 즉시 상위 루프로 전달한다. */
async function runValidatedReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
  testReport: string | null,
): Promise<{ report: string; result: ReviewResult }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= REVIEW_FORMAT_RETRIES; attempt += 1) {
    const report = await runIndependentReview(
      pi,
      ctx.cwd,
      checklist,
      resolveVerifyingModel(),
      resolveVerifyingThinkingLevel(),
      testReport,
    );
    try {
      return { report, result: extractReviewResult(report) };
    } catch (error) {
      lastError = error;
      if (attempt < REVIEW_FORMAT_RETRIES) {
        ctx.ui.notify(
          `loop-agent: 검수 판정 형식이 잘못되어 재검수합니다 (${attempt + 1}/${REVIEW_FORMAT_RETRIES}).`,
          "warning",
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("검수 판정 형식을 확인할 수 없습니다.");
}

function isCurrentWorkflow(workflowId: string): boolean {
  return state.workflowId === workflowId;
}

/** 코드 모델을 별도 Pi 프로세스로 실행하고 성공 여부를 종료 코드로 확인한다. */
async function runCodingAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): Promise<string> {
  const args = [
    "--mode",
    "text",
    "--print",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
  ];
  const modelName =
    config.codingModel ??
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
  if (modelName) args.push("--model", modelName);
  if (config.codingThinkingLevel)
    args.push("--thinking", config.codingThinkingLevel);
  args.push(prompt);

  // loop-agent만 환경 플래그로 비활성화하고 MCP 어댑터 등 나머지 확장은
  // 그대로 로드한다. --tools allowlist도 쓰지 않아 확장 도구를 제한하지 않는다.
  const result = await pi.exec("env", ["LOOP_AGENT_CHILD=1", "pi", ...args], {
    cwd: ctx.cwd,
    timeout: CODING_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`코드 에이전트 실행 실패: ${reason}`);
  }

  const output = result.stdout.trim();
  if (!output) throw new Error("코드 에이전트가 빈 결과를 반환했습니다.");
  return output;
}

/**
 * 별도 Pi 프로세스에서 실제 테스트만 실행한다. bash로 테스트 스위트를 돌릴 수 있지만
 * edit/write가 없으니 검증 대상 자신이 상태를 바꿀 수 없다. 구현 변경 없이 순수하게
 * "실행해 사실을 보고하는" 단계로 독립 검수 에이전트가 추측이 아니라 실제 결과로 판단하게 해준다.
 */
async function runTestAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
): Promise<string> {
  const prompt = [
    "당신은 테스트 전용 에이전트다. 코드나 파일을 수정하지 말고 관련 테스트만 실행하라.",
    "현재 작업 디렉토리에서 이 변경과 관련된 테스트 및 린트/타입체크 등 실행 가능한 모든 명령을 실행하라.",
    "실행 명령, 실제 시도/통과 개수, 실패한 테스트의 이름 및 실패 이유를 있는 그대로 상세하게 보고하라.",
    "테스트를 직접 수정하거나 새 테스트를 작성하지 말고, 실패를 통과로 위장하지 말라.",
    "보고서는 한국어로 작성하라.",
    "",
    "목표 결과 체크리스트(참조용, 직접 판정하지 말 것):",
    checklist,
  ].join("\n");

  const args = [
    "--mode",
    "text",
    "--print",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    "read,bash,grep,find,ls",
  ];
  const modelName = resolveTestModel(ctx);
  if (modelName) args.push("--model", modelName);
  const thinkingLevel = resolveTestThinkingLevel();
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  args.push(prompt);

  // 검수와 같은 이유로 --no-extensions를 쓰지 않는다: bash 도구를 테스트 스위트에서만 쓰는
  // 것은 테스트 에이전트의 책임이고, LOOP_AGENT_CHILD 가드가 이 확장의 재가동을 구조적으로 막는다.
  const result = await pi.exec("env", ["LOOP_AGENT_CHILD=1", "pi", ...args], {
    cwd: ctx.cwd,
    timeout: TEST_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`테스트 에이전트 실행 실패: ${reason}`);
  }

  const output = result.stdout.trim();
  if (!output) throw new Error("테스트 에이전트가 빈 결과를 반환했습니다.");
  return output;
}

function buildImprovementPrompt(
  result: ReviewResult,
  checklist: string,
  round: number,
): string {
  const failedItems = result.failedItems
    .map(
      (item, index) =>
        `${index + 1}. 항목: ${item.item}\n   실패 이유: ${item.reason}\n   근거: ${item.evidence}`,
    )
    .join("\n");

  return [
    `독립 검수 ${round}차에서 아래 항목이 통과하지 못했습니다.`,
    "실제 코드와 검증 결과를 확인해 실패 항목만 개선하고 관련 테스트를 실행하세요.",
    "기존에 통과한 항목을 회귀시키지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
    "",
    buildImplementSkillGuidance(),
    "",
    buildTaskTrackingInstructions(),
    "이 태스크는 이미 current.md에 있을 수 있으니, 수용 기준을 모두 만족한 뒤에만 archive로 이동하세요.",
    "",
    failedItems,
    "",
    "전체 목표 체크리스트:",
    checklist,
  ].join("\n");
}

/** 코드 실행과 독립 검수를 종료 코드까지 확인하며 순차 반복하는 워크플로 본체다. */
async function runExecutionReviewLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  initialCodingPrompt?: string,
): Promise<void> {
  if (!state.checklist || !isCurrentWorkflow(workflowId)) return;
  if (state.processingWorkflowId) {
    ctx.ui.notify(
      "loop-agent: 이미 코드 실행 또는 검수가 진행 중입니다.",
      "warning",
    );
    return;
  }

  state.processingWorkflowId = workflowId;
  let codingPrompt = initialCodingPrompt;

  try {
    while (isCurrentWorkflow(workflowId) && state.checklist) {
      if (codingPrompt) {
        state.reviewStage = "awaiting-execution";
        persistWorkflowState(pi, "coding-started");
        ctx.ui.notify("loop-agent: 코드 에이전트를 실행합니다.", "info");
        const codingOutput = await runCodingAgent(pi, ctx, codingPrompt);
        if (!isCurrentWorkflow(workflowId)) return;

        pi.appendEntry("loop-agent-coding-result", {
          workflowId,
          round: state.improvementRound,
          output: codingOutput,
        });
        pi.sendMessage(
          {
            customType: "loop-agent-coding-result",
            content: `## 코드 에이전트 실행 결과\n\n${codingOutput}`,
            display: true,
            details: { workflowId, round: state.improvementRound },
          },
          { triggerTurn: false },
        );
        persistWorkflowState(pi, "coding-completed");
      }

      state.reviewStage = "testing";
      persistWorkflowState(pi, "testing-started");
      ctx.ui.notify("loop-agent: 테스트 전용 에이전트를 실행합니다.", "info");
      let testReport: string | null = null;
      try {
        testReport = await runTestAgent(pi, ctx, state.checklist);
        if (!isCurrentWorkflow(workflowId)) return;
        pi.appendEntry("loop-agent-test-result", {
          workflowId,
          round: state.improvementRound,
          output: testReport,
        });
        pi.sendMessage(
          {
            customType: "loop-agent-test-result",
            content: `## 테스트 에이전트 실행 결과\n\n${testReport}`,
            display: true,
            details: { workflowId, round: state.improvementRound },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        if (!isCurrentWorkflow(workflowId)) return;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `loop-agent: 테스트 에이전트 실행을 건너뜁니다 (${message}). 기존 근거만으로 검수를 진행합니다.`,
          "warning",
        );
      }
      persistWorkflowState(pi, "testing-completed");

      state.reviewStage = "reviewing";
      persistWorkflowState(pi, "review-started");
      ctx.ui.notify(
        "loop-agent: 읽기 전용 독립 에이전트가 체크리스트를 검수합니다.",
        "info",
      );
      const { report, result } = await runValidatedReview(
        pi,
        ctx,
        state.checklist,
        testReport,
      );
      if (!isCurrentWorkflow(workflowId)) return;
      pi.appendEntry("loop-agent-review", {
        workflowId,
        checklist: state.checklist,
        report,
        round: state.improvementRound,
        result,
      });
      pi.sendMessage(
        {
          customType: "loop-agent-review",
          content: `## 독립 에이전트 검수 결과\n\n${report}`,
          display: true,
          details: { workflowId, checklist: state.checklist },
        },
        { triggerTurn: false },
      );

      if (result.overall === "PASS") {
        state.reviewStage = "reviewed";
        state.autoMode = false;
        state.workflowId = null;
        persistWorkflowState(pi, "completed");
        ctx.ui.notify(
          "loop-agent: 모든 체크리스트 항목이 통과했습니다.",
          "info",
        );
        return;
      }

      if (state.improvementRound >= config.maxImprovementRounds) {
        state.reviewStage = "failed";
        state.autoMode = false;
        state.workflowId = null;
        persistWorkflowState(pi, "max-rounds-reached");
        ctx.ui.notify(
          `loop-agent: 최대 개선 횟수(${config.maxImprovementRounds})에 도달했습니다.`,
          "error",
        );
        return;
      }

      state.improvementRound += 1;
      persistWorkflowState(pi, "improvement-scheduled");
      codingPrompt = buildImprovementPrompt(
        result,
        state.checklist,
        state.improvementRound,
      );
      ctx.ui.notify(
        `loop-agent: 실패 항목 개선 ${state.improvementRound}/${config.maxImprovementRounds}차를 준비합니다.`,
        "warning",
      );
    }
  } catch (error) {
    if (!isCurrentWorkflow(workflowId)) return;
    state.reviewStage = "failed";
    state.autoMode = false;
    state.workflowId = null;
    persistWorkflowState(pi, "execution-failed");
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`loop-agent: ${message}`, "error");
  } finally {
    if (state.processingWorkflowId === workflowId) {
      state.processingWorkflowId = null;
    }
  }
}

function normalizeArgs(args: unknown): string {
  if (Array.isArray(args)) return args.join(" ").trim();
  if (typeof args === "string") return args.trim();
  if (args == null) return "";
  return String(args).trim();
}

// "startup"은 이전 세션을 이어서 열 수도 있으므로 previousSessionFile이 없을
// 때만 진짜 새 대화로 간주한다. "resume"/"fork"/"reload"는 이미 대화 맥락이
// 있으므로 첫 입력 그릴링 대상에서 제외한다.
function isFreshSessionStart(event: SessionStartEvent): boolean {
  if (event.reason === "new") return true;
  if (event.reason === "startup" && event.previousSessionFile === undefined)
    return true;
  return false;
}

function renderGateStatus(): string {
  return [
    "loop-agent status",
    `- enabled: ${state.enabled}`,
    `- armed: ${state.armed}`,
    `- reviewStage: ${state.reviewStage}`,
    `- checklistReady: ${state.checklist !== null}`,
    `- improvementRound: ${state.improvementRound}/${config.maxImprovementRounds}`,
    `- autoMode: ${state.autoMode}`,
    `- workflowId: ${state.workflowId ?? "none"}`,
    `- processingWorkflowId: ${state.processingWorkflowId ?? "none"}`,
    `- planningModel: ${config.planningModel ?? "current"}`,
    `- codingModel: ${config.codingModel ?? "current"}`,
    `- verifyingModel: ${config.verifyingModel ?? "planningModel"}`,
    `- testModel: ${config.testModel ?? "codingModel"}`,
    `- planningThinkingLevel: ${config.planningThinkingLevel ?? "current"}`,
    `- codingThinkingLevel: ${config.codingThinkingLevel ?? "current"}`,
    `- verifyingThinkingLevel: ${config.verifyingThinkingLevel ?? "planningThinkingLevel"}`,
    `- testThinkingLevel: ${config.testThinkingLevel ?? "codingThinkingLevel"}`,
  ].join("\n");
}

function applyGateCommand(command: string, pi: ExtensionAPI): boolean {
  switch (command) {
    case "":
    case "status":
      return true;
    case "on":
      state.enabled = true;
      return true;
    case "off":
      state.enabled = false;
      return true;
    case "rearm":
      // 세션 중간에도 다음 입력 한 번을 다시 그릴링 대상으로 만든다.
      state.armed = true;
      return true;
    case "clear":
      state.reviewStage = "idle";
      state.checklist = null;
      state.improvementRound = 0;
      state.autoMode = false;
      state.workflowId = null;
      persistWorkflowState(pi, "cleared");
      return true;
    default:
      return false;
  }
}

export default function loopAgentExtension(pi: ExtensionAPI) {
  // 코드 자식 프로세스는 다른 확장과 MCP를 사용하되 이 확장만 등록하지 않는다.
  // 이 가드가 없으면 자식의 agent_end가 다시 코드 자식을 만드는 재귀가 발생한다.
  if (process.env.LOOP_AGENT_CHILD === "1") return;

  pi.on("session_start", async (event, ctx) => {
    const freshSession = isFreshSessionStart(event);
    state.armed = state.enabled && freshSession;

    if (freshSession) {
      // 확장 모듈은 프로세스 동안 유지될 수 있으므로 새 세션에서 이전 작업의
      // 체크리스트와 검수 상태가 유출되지 않게 명시적으로 초기화한다.
      state.reviewStage = "idle";
      state.checklist = null;
      state.improvementRound = 0;
      state.autoMode = false;
      state.workflowId = null;
      state.processingWorkflowId = null;
      await selectModel(
        pi,
        ctx,
        config.planningModel,
        config.planningThinkingLevel,
        "계획",
      );
    } else if (restoreWorkflowState(ctx)) {
      ctx.ui.notify("loop-agent: 저장된 워크플로 상태를 복구했습니다.", "info");

      if (
        state.autoMode &&
        state.checklist &&
        state.workflowId &&
        (state.reviewStage === "awaiting-execution" ||
          state.reviewStage === "reviewing")
      ) {
        // 중단 지점에서 코드를 무조건 재실행하면 이미 반영된 변경을 중복 적용할
        // 수 있으므로 먼저 현재 파일 상태를 검수하고 부족한 항목만 개선한다.
        await runExecutionReviewLoop(pi, ctx, state.workflowId);
      }
    }

    if (state.armed) {
      ctx.ui.notify(
        "loop-agent: 다음 첫 메시지를 grill-checklist로 확장합니다.",
        "info",
      );
    }
  });

  // 컴팩션(수동 /compact, 임계치 초과, 컨텍스트 오버플로 복구)은 부모 대화를
  // 요약으로 대체한다. runExecutionReviewLoop 자체는 자식 프로세스와 state로만
  // 구동되어 부모 문맥에 의존하지 않지만, 컴팩션 시점에 워크플로가 아직 살아 있는데
  // 루프가 돌고 있지 않다면(단계 사이의 틈, agent_end 뒤 후속 트리거 유실 등)
  // 그대로 잠들어버릴 수 있다. 이 핸들러가 그 틈을 메워 작업을 이어서 진행한다.
  pi.on("session_compact", async (_event: SessionCompactEvent, ctx) => {
    // 이미 코드/테스트/검수 루프가 돌고 있으면 중복 진입을 막는다. 자식
    // 프로세스는 컴팩션과 무관하게 계속 실행되므로 건드릴 필요가 없다.
    if (state.processingWorkflowId) return;

    if (
      state.autoMode &&
      state.checklist &&
      state.workflowId &&
      (state.reviewStage === "awaiting-execution" ||
        state.reviewStage === "reviewing")
    ) {
      ctx.ui.notify(
        "loop-agent: 컴팩션 이후 진행 중이던 워크플로를 이어서 실행합니다.",
        "info",
      );
      await runExecutionReviewLoop(pi, ctx, state.workflowId);
    }
  });

  // /goal 명령과 첫 세션 메시지(input 핸들러)가 공유하는 반자동 파이프라인 진입점.
  // 워크플로 상태를 원자적으로 초기화하고 계획 모델을 고른 뒤 계획 프롬프트를
  // 구성해 반환한다. 준비가 실패하면 null을 반환하고 상태를 되돌린다.
  // 실제 입력 주입(sendUserMessage vs input transform)은 호출측이 맡는다.
  async function prepareGoalPipeline(
    ctx: ExtensionContext,
    objective: string,
  ): Promise<string | null> {
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        "loop-agent: 현재 에이전트 실행이 끝난 뒤 다시 시도하세요.",
        "warning",
      );
      return null;
    }
    if (state.workflowId || state.processingWorkflowId) {
      ctx.ui.notify(
        "loop-agent: 이미 진행 중인 목표가 있습니다. 중단하려면 /loop-agent clear를 먼저 실행하세요.",
        "warning",
      );
      return null;
    }

    // 새 목표가 이전 작업의 체크리스트나 반복 횟수를 이어받지 않도록
    // 워크플로 상태를 원자적으로 초기화한다.
    state.armed = false;
    state.autoMode = true;
    state.reviewStage = "idle";
    state.checklist = null;
    state.improvementRound = 0;
    const workflowId = randomUUID();
    state.workflowId = workflowId;
    persistWorkflowState(pi, "goal-started");

    const modelSelected = await selectModel(
      pi,
      ctx,
      config.planningModel,
      config.planningThinkingLevel,
      "계획",
    );
    if (!modelSelected) {
      state.autoMode = false;
      state.workflowId = null;
      persistWorkflowState(pi, "planning-model-failed");
      return null;
    }

    ctx.ui.notify(
      "loop-agent: 반자동 목표 파이프라인(인터뷰 → to-prd → to-issues → checklist → 자동 구현·검증)을 시작합니다. 1단계 인터뷰는 질문/답변을 주고받습니다.",
      "info",
    );
    try {
      return buildPlanningPipelinePrompt(objective, workflowId);
    } catch (error) {
      state.autoMode = false;
      state.workflowId = null;
      persistWorkflowState(pi, "goal-start-failed");
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `loop-agent: 파이프라인 스킬 또는 issue-tracker 문서를 읽지 못했습니다: ${message}`,
        "error",
      );
      return null;
    }
  }

  // /goal 명령용: 개별 메시지로 계획 프롬프트를 주입한다.
  async function startGoalWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    objective: string,
  ): Promise<void> {
    const prompt = await prepareGoalPipeline(ctx, objective);
    if (prompt) piApi.sendUserMessage(prompt);
  }

  pi.on("input", async (event, ctx) => {
    // 확장이 스스로 주입한 입력, RPC 등 사람이 직접 타이핑하지 않은 입력은
    // "첫 질문"으로 세지 않는다.
    if (event.source !== "interactive") {
      return { action: "continue" };
    }

    if (!state.enabled || !state.armed) {
      return { action: "continue" };
    }

    // 성공 여부와 무관하게 이번 세션의 "첫 입력" 자격은 여기서 소비한다.
    // 그래야 슬래시 명령이나 빈 입력으로 첫 턴을 흘려보내도 두 번째 실제
    // 메시지까지 그릴링이 미뤄지지 않는다.
    state.armed = false;

    const text = event.text.trim();
    if (!text) {
      return { action: "continue" };
    }

    // 슬래시 명령(/model, /skill:xxx 등)은 이미 명시적인 지시이므로 그대로 둔다.
    if (text.startsWith("/")) {
      return { action: "continue" };
    }

    // 첫 세션 메시지도 /goal과 완전히 동일한 반자동 파이프라인을 탄다.
    // 계획 프롬프트로 원본 입력을 치환해 주입하면 그릴링 인터뷰 → to-prd →
    // to-issues → checklist → (agent_end가 감지) 구현·검증 루프로 이어진다.
    // 준비 실패(바쁘/이미 진행 중/스킬 읽기 실패) 시에는 원본을 그대로 통과시킨다.
    const prompt = await prepareGoalPipeline(ctx, text);
    if (!prompt) {
      return { action: "continue" };
    }
    return { action: "transform", text: prompt };
  });

  pi.on("agent_end", async (event, ctx) => {
    const planningResponse = getLastAssistantText(event);
    const latestChecklist = extractChecklist(planningResponse);

    if (latestChecklist) {
      const responseWorkflowId = extractWorkflowId(planningResponse);
      if (responseWorkflowId && responseWorkflowId !== state.workflowId) {
        ctx.ui.notify(
          "loop-agent: 취소되거나 교체된 목표의 체크리스트를 무시했습니다.",
          "warning",
        );
        return;
      }
      if (state.autoMode && !responseWorkflowId) {
        ctx.ui.notify(
          "loop-agent: 자동 목표 체크리스트에 워크플로 ID가 없어 실행을 중단합니다.",
          "error",
        );
        state.reviewStage = "failed";
        persistWorkflowState(pi, "workflow-marker-missing");
        return;
      }

      // 이 agent_end는 명세, 구현 계획, 체크리스트를 만든 그릴링 종료 턴이다.
      // 자동 모드는 즉시 별도 코드 프로세스를 실행하고 일반 모드는 승인을 기다린다.
      state.checklist = latestChecklist;
      state.reviewStage = "awaiting-execution";
      state.improvementRound = 0;
      state.workflowId ??= randomUUID();
      const workflowId = state.workflowId;
      pi.appendEntry("loop-agent-checklist", {
        workflowId,
        checklist: latestChecklist,
      });
      persistWorkflowState(pi, "checklist-captured");
      await selectModel(
        pi,
        ctx,
        config.codingModel,
        config.codingThinkingLevel,
        "코드",
      );

      if (state.autoMode) {
        // /goal 작업은 사용자 승인을 다시 기다리지 않는다. 확장이 별도 코드
        // 프로세스의 종료 코드를 직접 기다리므로 실행 실패도 상태에 반영된다.
        const codingPrompt = [
          "자동 실행 모드입니다. 아래 확정 명세와 구현 계획을 즉시 실행하세요.",
          "목표 체크리스트를 모두 만족하도록 코드를 수정하고 필요한 테스트를 실행하세요.",
          "작업을 중간에 멈추거나 사용자 승인을 다시 요청하지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
          "",
          buildImplementSkillGuidance(),
          "",
          buildTaskTrackingInstructions(),
          "",
          planningResponse,
        ].join("\n");
        ctx.ui.notify(
          "loop-agent: 계획과 체크리스트가 확정되어 코드 에이전트를 자동 실행합니다.",
          "info",
        );
        await runExecutionReviewLoop(pi, ctx, workflowId, codingPrompt);
        return;
      }

      ctx.ui.notify(
        "loop-agent: 목표 체크리스트를 저장했습니다. 다음 실행 완료 후 독립 검수를 시작합니다.",
        "info",
      );
      return;
    }

    if (state.reviewStage !== "awaiting-execution" || !state.checklist) return;
    if (ctx.hasPendingMessages()) return;

    const workflowId = state.workflowId;
    if (!workflowId) return;
    await runExecutionReviewLoop(pi, ctx, workflowId);
  });

  pi.registerCommand("goal", {
    description:
      "Start a semi-automated loop-agent workflow (interview with a human, then auto implement/verify). Usage: /goal <objective>",
    handler: async (args, ctx) => {
      const objective = normalizeArgs(args);
      if (!objective) {
        ctx.ui.notify("Usage: /goal <objective>", "warning");
        return;
      }
      await startGoalWorkflow(pi, ctx, objective);
    },
  });

  pi.registerCommand("loop-agent", {
    description:
      "Control workflow. Usage: /loop-agent status|on|off|rearm|review|clear|plan-model|code-model|verify-model|test-model|plan-thinking|code-thinking|verify-thinking|test-thinking|max-rounds",
    handler: async (args, ctx) => {
      const normalized = normalizeArgs(args);
      const [rawCommand = "", ...valueParts] = normalized.split(/\s+/);
      const command = rawCommand.toLowerCase();
      const value = valueParts.join(" ").trim();

      const MODEL_COMMANDS = {
        "plan-model": { key: "planningModel", role: "계획", fallback: null },
        "code-model": { key: "codingModel", role: "코드", fallback: null },
        "verify-model": { key: "verifyingModel", role: "검수", fallback: "planningModel" },
        "test-model": { key: "testModel", role: "테스트", fallback: "codingModel" },
      } as const;

      if (command in MODEL_COMMANDS) {
        const { key: configKey, role, fallback } =
          MODEL_COMMANDS[command as keyof typeof MODEL_COMMANDS];

        if (!value) {
          const fallbackLabel = fallback ? ` (fallback: ${fallback})` : "";
          ctx.ui.notify(
            `loop-agent: ${role} 모델: ${config[configKey] ?? "current"}${fallbackLabel}`,
            "info",
          );
          return;
        }

        if (value.toLowerCase() === "current") {
          config[configKey] = null;
        } else {
          const parsed = parseModelName(value);
          if (
            !parsed ||
            !ctx.modelRegistry.find(parsed.provider, parsed.modelId)
          ) {
            ctx.ui.notify(
              `loop-agent: 모델을 찾을 수 없습니다: ${value}`,
              "error",
            );
            return;
          }
          config[configKey] = value;
        }
        saveConfig();
        config = loadConfig();
        if (command === "plan-model") {
          await selectModel(
            pi,
            ctx,
            config.planningModel,
            config.planningThinkingLevel,
            "계획",
          );
        }
        ctx.ui.notify(renderGateStatus(), "info");
        return;
      }

      const THINKING_COMMANDS = {
        "plan-thinking": { key: "planningThinkingLevel", role: "계획", fallback: null },
        "code-thinking": { key: "codingThinkingLevel", role: "코드", fallback: null },
        "verify-thinking": { key: "verifyingThinkingLevel", role: "검수", fallback: "planningThinkingLevel" },
        "test-thinking": { key: "testThinkingLevel", role: "테스트", fallback: "codingThinkingLevel" },
      } as const;

      if (command in THINKING_COMMANDS) {
        const { key: configKey, role, fallback } =
          THINKING_COMMANDS[command as keyof typeof THINKING_COMMANDS];

        if (!value) {
          const fallbackLabel = fallback ? ` (fallback: ${fallback})` : "";
          ctx.ui.notify(
            `loop-agent: ${role} thinking level: ${config[configKey] ?? "current"}${fallbackLabel}`,
            "info",
          );
          return;
        }

        const normalizedValue = value.toLowerCase();
        if (normalizedValue === "current") {
          config[configKey] = null;
        } else if (isThinkingLevel(normalizedValue)) {
          config[configKey] = normalizedValue;
        } else {
          ctx.ui.notify(
            `loop-agent: thinking level은 ${THINKING_LEVELS.join(", ")}, current 중 하나여야 합니다.`,
            "error",
          );
          return;
        }
        saveConfig();
        config = loadConfig();
        if (command === "plan-thinking" && config.planningThinkingLevel) {
          pi.setThinkingLevel(config.planningThinkingLevel);
        }
        ctx.ui.notify(renderGateStatus(), "info");
        return;
      }

      if (command === "max-rounds") {
        const rounds = Number(value);
        if (!Number.isInteger(rounds) || rounds < 0 || rounds > 20) {
          ctx.ui.notify(
            "loop-agent: max-rounds는 0~20 사이의 정수여야 합니다.",
            "error",
          );
          return;
        }
        config.maxImprovementRounds = rounds;
        saveConfig();
        config = loadConfig();
        ctx.ui.notify(renderGateStatus(), "info");
        return;
      }

      // 수동 검수는 agent_end를 기다리지 않고 즉시 실행한다. 자동 검수 실패나
      // 구현 보완 후 같은 체크리스트로 재검증할 때 사용한다.
      if (command === "review") {
        if (!state.checklist) {
          ctx.ui.notify("loop-agent: 검수할 체크리스트가 없습니다.", "warning");
          return;
        }
        state.workflowId ??= randomUUID();
        await runExecutionReviewLoop(pi, ctx, state.workflowId);
        return;
      }

      const handled = applyGateCommand(command, pi);

      if (!handled) {
        ctx.ui.notify(
          [
            `Unknown loop-agent command: ${command || "(empty)"}`,
            "",
            "Usage: /loop-agent status|on|off|rearm|review|clear|plan-model <provider/model>|code-model <provider/model>|verify-model <provider/model|current>|test-model <provider/model|current>|plan-thinking <level>|code-thinking <level>|verify-thinking <level|current>|test-thinking <level|current>|max-rounds <0-20>",
            "",
            renderGateStatus(),
          ].join("\n"),
          "warning",
        );
        return;
      }

      ctx.ui.notify(renderGateStatus(), "info");
    },
  });
}
