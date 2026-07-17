import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ReviewStage,
  ThinkingLevel,
  WorkflowConfig,
} from "./loop-agent-state.ts";

export const ARCHITECTURE_CHECKLIST_ITEM =
  "- [ ] SQLite에서 검색한 아키텍처 문서의 책임 경계·source of truth·불변조건을 지킨다.";
export const WORKFLOW_MARKER_PREFIX = "<!-- loop-agent-workflow:";
export const PARALLEL_TASKS_START = "<!-- loop-agent-parallel-tasks:start -->";
export const PARALLEL_TASKS_END = "<!-- loop-agent-parallel-tasks:end -->";

const REQUIRED_SEMANTIC_SEARCH_LIMIT = 8;
const SEMANTIC_RESULT_BODY_LIMIT = 2400;

export type IssueStoreRecord = {
  issue_id?: unknown;
  triage_label?: unknown;
  label?: unknown;
  title?: unknown;
  status?: unknown;
  parent?: unknown;
  parent_issue_id?: unknown;
  blockedBy?: unknown;
  blocked_by?: unknown;
  body?: unknown;
  [key: string]: unknown;
};

export type ArchitectureDocumentRecord = {
  source_path?: unknown;
  section_index?: unknown;
  heading?: unknown;
  doc_type?: unknown;
  body?: unknown;
  distance?: unknown;
  [key: string]: unknown;
};

export type SemanticSearchContext = {
  query: string;
  results: IssueStoreRecord[];
  architectureResults: ArchitectureDocumentRecord[];
};

export type GoalPipelinePreparation =
  | { prompt: string }
  | { blocked: true }
  | null;

export type PlanningPromptDependencies = {
  skillPath: (skillName: string) => string;
  buildArchitectureReadGuidance: (root: string) => string;
  buildImplementSkillGuidance: (root: string) => string;
  buildTaskTrackingInstructions: (root: string) => string;
  shortenStatusLine: (text: string, maxLength?: number) => string;
};

export type PlanningSearchDependencies = {
  ensureIssueStore: (ctx: ExtensionContext) => Promise<boolean>;
  runIssueStoreCliAsync: (
    root: string,
    args: string[],
    onProgress?: (line: string) => void,
  ) => Promise<Record<string, unknown> | undefined>;
};

export type PlanningControllerDependencies = {
  ensureWorkflowWorkspace: (
    ctx: ExtensionContext,
    explicit: boolean,
  ) => boolean;
  findMissingPipelinePrerequisite: (root: string) => string | null;
  reserveWorkflow: (
    autoReview: boolean,
    reviewStage: ReviewStage,
    checklist: string | null,
  ) => string;
  runRequiredSemanticSearch: (
    ctx: ExtensionContext,
    objective: string,
  ) => Promise<SemanticSearchContext | null>;
  isCurrentWorkflow: (workflowId: string) => boolean;
  persistWorkflowState: (pi: ExtensionAPI, reason: string) => void;
  releaseWorkflowIfCurrent: (
    pi: ExtensionAPI,
    workflowId: string,
    reason: string,
  ) => void;
  selectModel: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    modelName: string | null,
    thinkingLevel: ThinkingLevel | null,
    label: string,
  ) => Promise<boolean>;
  workflowConfig: Pick<
    WorkflowConfig,
    "planningModel" | "planningThinkingLevel"
  >;
  buildPlanningPipelinePrompt: (
    objective: string,
    workflowId: string,
    root: string,
    semanticContext: SemanticSearchContext,
  ) => string;
};

export function buildQuickChecklist(
  objective: string,
  shortenStatusLine: (text: string, maxLength?: number) => string,
): string {
  const summary = shortenStatusLine(objective, 120);
  return [
    "## 목표 결과 체크리스트",
    `- [ ] 요청 \"${summary}\" 를 최소 변경으로 구현했다.`,
    "- [ ] 관련 검증(테스트, 빌드, 정적 검사) 중 필요한 것을 실행했다.",
    "- [ ] 기존의 직접 연관된 동작을 불필요하게 바꾸지 않았다.",
    ARCHITECTURE_CHECKLIST_ITEM,
  ].join("\n");
}

export function buildDirectCodingPrompt(
  objective: string,
  root: string,
  dependencies: PlanningPromptDependencies,
  semanticContext: SemanticSearchContext = {
    query: objective,
    results: [],
    architectureResults: [],
  },
): { checklist: string; prompt: string } {
  const checklist = buildQuickChecklist(
    objective,
    dependencies.shortenStatusLine,
  );
  const prompt = [
    "작은 단일 작업이다. 인터뷰, PRD, 이슈 분해 없이 바로 구현하라.",
    "최소 변경으로 요청을 충족하고, 끝나면 변경 내용과 검증 근거를 간단히 보고하라.",
    "",
    "다음 체크리스트를 만족하도록 작업하라:",
    checklist,
    "",
    dependencies.buildImplementSkillGuidance(root),
    "",
    dependencies.buildTaskTrackingInstructions(root),
    "",
    formatSemanticSearchContext(semanticContext),
    "",
    "작업 요청:",
    objective,
  ].join("\n");

  return { checklist, prompt };
}

export function buildPlanningPipelinePrompt(
  objective: string,
  workflowId: string,
  root: string,
  semanticContext: SemanticSearchContext,
  dependencies: Pick<
    PlanningPromptDependencies,
    "skillPath" | "buildArchitectureReadGuidance"
  >,
): string {
  return [
    "<loop-agent-pipeline>",
    "아래 스킬과 SQLite issue-store 규약을 source of truth로 사용하고, 아키텍처 근거도 SQLite 검색 결과를 사용하라.",
    `- ${dependencies.skillPath("grill-checklist")}`,
    `- ${dependencies.skillPath("grill-with-docs")}`,
    `- ${dependencies.skillPath("grilling")}`,
    `- ${dependencies.skillPath("domain-modeling")}`,
    `- ${dependencies.skillPath("to-prd")}`,
    `- ${dependencies.skillPath("to-issues")}`,
    dependencies.buildArchitectureReadGuidance(root),
    "필요할 때는 `read` 도구로 설치 스킬만 읽어라. 이슈·문서·변경 이력은 위 SQLite CLI와 검색 결과를 기준으로 참고하라.",
    `grill-checklist의 최종 목표 체크리스트에는 반드시 다음 아키텍처 준수 검증 항목을 포함하라: ${ARCHITECTURE_CHECKLIST_ITEM}`,
    "한 번에 하나의 질문만 하고, 아직 물을 질문이 남았으면 그 턴은 질문으로 끝내라.",
    "이전 세션의 요약이나 추측을 섞지 말고, 위 스킬·SQLite 검색 결과·현재 대화에서만 근거를 가져와라.",
    "</loop-agent-pipeline>",
    "",
    formatSemanticSearchContext(semanticContext),
    "",
    objective,
    "",
    "<loop-agent-auto>",
    "이 작업은 반자동 실행 모드다. 1단계 인터뷰는 사람과 질문/답변을 주고받아 진행하고, 그 이후의 구현·검증만 확장이 자동으로 실행한다.",
    `워크플로 ID는 ${workflowId}다. 최종 체크리스트 바로 앞에 ${WORKFLOW_MARKER_PREFIX}${workflowId} --> 주석을 정확히 출력하라.`,
    "아직 물을 질문이 남았으면 이번 턴은 질문으로 끝내라(체크리스트를 출력하지 말라). 인터뷰가 완전히 끝난 뒤에만 구현 계획과 목표 체크리스트를 작성하라.",
    "체크리스트를 출력하는 마지막 턴에서는 구현 승인 여부를 다시 묻지 말라. 확장이 코드 에이전트를 자동 실행한다.",
    `to-issues가 만든 T-### 중 병렬 코딩 후보가 있으면 ${PARALLEL_TASKS_START}와 ${PARALLEL_TASKS_END} 사이에`,
    "서로 독립적이고 ready-for-agent이며 바로 시작 가능한 태스크 ID만 한 줄에 하나씩 출력하라. 없으면 이 블록은 생략하라.",
    "</loop-agent-auto>",
  ].join("\n");
}

export function findMissingPipelinePrerequisite(
  skillPath: (skillName: string) => string,
  pipelineSkillNames: readonly string[],
  accessSync: (path: string, mode: number) => void = fs.accessSync,
): string | null {
  const required = [
    skillPath("grilling"),
    skillPath("domain-modeling"),
    ...pipelineSkillNames.map((skillName) => skillPath(skillName)),
  ];
  for (const filePath of required) {
    try {
      accessSync(filePath, fs.constants.R_OK);
    } catch {
      return filePath;
    }
  }
  return null;
}

export async function runRequiredArchitectureSearch(
  ctx: ExtensionContext,
  objective: string,
  dependencies: PlanningSearchDependencies,
): Promise<ArchitectureDocumentRecord[] | null> {
  const response = await dependencies.runIssueStoreCliAsync(
    ctx.cwd,
    [
      "search-architecture",
      objective,
      "--limit",
      String(REQUIRED_SEMANTIC_SEARCH_LIMIT),
    ],
    (line) => ctx.ui.notify(`loop-agent: semantic search - ${line}`, "info"),
  );
  if (response?.ok !== true || !Array.isArray(response.results)) {
    ctx.ui.notify(
      "loop-agent: 필수 ADR/CONTEXT semantic search에 실패해 업무를 시작하지 않습니다.",
      "error",
    );
    return null;
  }

  const results = (response.results as ArchitectureDocumentRecord[]).slice(
    0,
    REQUIRED_SEMANTIC_SEARCH_LIMIT,
  );
  ctx.ui.notify(
    `loop-agent: ADR/CONTEXT semantic search 완료 (${results.length}개 결과).`,
    "info",
  );
  return results;
}

export async function runRequiredSemanticSearch(
  ctx: ExtensionContext,
  objective: string,
  dependencies: PlanningSearchDependencies,
): Promise<SemanticSearchContext | null> {
  if (!(await dependencies.ensureIssueStore(ctx))) return null;

  const response = await dependencies.runIssueStoreCliAsync(
    ctx.cwd,
    ["search", objective, "--limit", String(REQUIRED_SEMANTIC_SEARCH_LIMIT)],
    (line) => ctx.ui.notify(`loop-agent: semantic search - ${line}`, "info"),
  );
  if (response?.ok !== true) {
    ctx.ui.notify(
      "loop-agent: 필수 semantic search에 실패해 자동 파이프라인을 중단합니다. 임베딩 환경(ISSUE_EMBEDDING_COMMAND/Python)을 확인하세요.",
      "error",
    );
    return null;
  }

  if (!Array.isArray(response.results)) {
    ctx.ui.notify(
      "loop-agent: semantic search 결과 형식이 올바르지 않아 자동 파이프라인을 중단합니다.",
      "error",
    );
    return null;
  }

  const results = (response.results as IssueStoreRecord[]).slice(
    0,
    REQUIRED_SEMANTIC_SEARCH_LIMIT,
  );
  ctx.ui.notify(
    `loop-agent: semantic search 완료 (${results.length}개 결과).`,
    "info",
  );

  const architectureResults = await runRequiredArchitectureSearch(
    ctx,
    objective,
    dependencies,
  );
  if (!architectureResults) return null;
  return { query: objective, results, architectureResults };
}

function formatArchitectureSearchContext(
  query: string,
  architectureResults: ArchitectureDocumentRecord[],
): string {
  const entries = architectureResults.map((record, index) => {
    const sourcePath = String(
      record.source_path ?? `architecture-result-${index + 1}`,
    );
    const heading = String(record.heading ?? "문서 section");
    const distance =
      typeof record.distance === "number"
        ? `, distance=${record.distance.toFixed(4)}`
        : "";
    const body =
      typeof record.body === "string"
        ? record.body.trim().slice(0, SEMANTIC_RESULT_BODY_LIMIT)
        : "";
    return [
      `### ${sourcePath}#${heading}`,
      `- 문서 종류: ${String(record.doc_type ?? "unknown")}${distance}`,
      body ? body : "- 본문 없음",
    ].join("\n");
  });

  return [
    "<loop-agent-architecture-context>",
    `검색어: ${query}`,
    entries.length > 0
      ? "아래는 SQLite ADR/CONTEXT vector search가 찾은 관련 문서 section이다. 이 검색 결과를 계획과 구현의 아키텍처 근거로 사용하라."
      : "SQLite 검색은 성공했지만 관련 ADR/CONTEXT 문서 section이 없다. 존재하지 않는 아키텍처 규칙을 추측하지 말고 이 사실을 계획에 명시하라.",
    "",
    entries.join("\n\n"),
    "</loop-agent-architecture-context>",
  ].join("\n");
}

export function formatSemanticSearchContext(
  context: SemanticSearchContext,
): string {
  const issueEntries = context.results.map((record, index) => {
    const issueId = String(record.issue_id ?? `result-${index + 1}`);
    const title = String(record.title ?? "제목 없음");
    const status = String(record.status ?? "unknown");
    const label = String(record.triage_label ?? record.label ?? "unknown");
    const distance =
      typeof record.distance === "number"
        ? `, distance=${record.distance.toFixed(4)}`
        : "";
    const body =
      typeof record.body === "string"
        ? record.body.trim().slice(0, SEMANTIC_RESULT_BODY_LIMIT)
        : "";
    return [
      `### ${issueId}: ${title}`,
      `- 상태: ${status}, 라벨: ${label}${distance}`,
      body ? body : "- 본문 없음",
    ].join("\n");
  });

  return [
    "<loop-agent-semantic-context>",
    `검색어: ${context.query}`,
    issueEntries.length > 0
      ? "아래는 자동 계획 시작 전에 issue-store semantic search로 찾은 기존 이슈 후보다."
      : "검색은 성공했지만 관련 기존 이슈가 없습니다. 새 요구사항으로 판단하라.",
    "현재 사용자 요구와 실제 코드가 우선이며, 이슈 결과는 검증해야 하는 참고 문맥으로만 사용하라.",
    "",
    issueEntries.join("\n\n"),
    "</loop-agent-semantic-context>",
    "",
    formatArchitectureSearchContext(context.query, context.architectureResults),
  ].join("\n");
}

export async function preparePlanningPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  objective: string,
  options: { explicit?: boolean; autoReview?: boolean },
  dependencies: PlanningControllerDependencies,
  promptDependencies: Pick<
    PlanningPromptDependencies,
    "skillPath" | "buildArchitectureReadGuidance"
  >,
): Promise<GoalPipelinePreparation> {
  const { explicit = true, autoReview = true } = options;
  if (!dependencies.ensureWorkflowWorkspace(ctx, explicit)) return null;

  const missing = dependencies.findMissingPipelinePrerequisite(ctx.cwd);
  if (missing) {
    if (explicit) {
      ctx.ui.notify(
        `loop-agent: 파이프라인 전제 파일이 없어 목표를 시작할 수 없습니다: ${missing}`,
        "error",
      );
    }
    return null;
  }

  const workflowId = dependencies.reserveWorkflow(
    autoReview,
    "idle",
    null,
  );
  const semanticContext = await dependencies.runRequiredSemanticSearch(
    ctx,
    objective,
  );
  if (!semanticContext) {
    dependencies.releaseWorkflowIfCurrent(pi, workflowId, "goal-search-failed");
    return { blocked: true };
  }
  if (!dependencies.isCurrentWorkflow(workflowId)) return null;

  dependencies.persistWorkflowState(pi, "goal-started");
  const modelSelected = await dependencies.selectModel(
    pi,
    ctx,
    dependencies.workflowConfig.planningModel,
    dependencies.workflowConfig.planningThinkingLevel,
    "계획",
  );
  if (!modelSelected) {
    dependencies.releaseWorkflowIfCurrent(pi, workflowId, "planning-model-failed");
    return null;
  }
  if (!dependencies.isCurrentWorkflow(workflowId)) return null;

  ctx.ui.notify(
    "loop-agent: 반자동 목표 파이프라인(인터뷰 → to-prd → to-issues → checklist → 자동 구현·검증)을 시작합니다. 1단계 인터뷰는 질문/답변을 주고받습니다.",
    "info",
  );
  try {
    return {
      prompt: dependencies.buildPlanningPipelinePrompt(
        objective,
        workflowId,
        ctx.cwd,
        semanticContext,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (dependencies.isCurrentWorkflow(workflowId)) {
      ctx.ui.notify(
        `loop-agent: 파이프라인 스킬 또는 SQLite 저장소를 준비하지 못했습니다: ${message}`,
        "error",
      );
    }
    dependencies.releaseWorkflowIfCurrent(pi, workflowId, "goal-start-failed");
    return null;
  }
}
