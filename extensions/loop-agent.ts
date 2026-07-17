import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  chooseParallelCodingTasksFromIssues as selectParallelCodingTasksFromIssues,
} from "./lib/issue-task-selection.js";
import {
  shouldWaitForPlanningInterview,
} from "./lib/loop-agent-planning.js";
import {
  ARCHITECTURE_CHECKLIST_ITEM,
  PARALLEL_TASKS_END,
  PARALLEL_TASKS_START,
  WORKFLOW_MARKER_PREFIX,
  buildDirectCodingPrompt as buildPlanningDirectCodingPrompt,
  buildPlanningPipelinePrompt as buildPlanningPrompt,
  buildQuickChecklist as buildPlanningQuickChecklist,
  findMissingPipelinePrerequisite as findPlanningPrerequisite,
  preparePlanningPipeline,
  runRequiredSemanticSearch as runPlanningSemanticSearch,
  type GoalPipelinePreparation,
  type IssueStoreRecord,
  type PlanningSearchDependencies,
} from "./lib/loop-agent-planning.ts";
import {
  completeWorkflow,
  createInitialGateState,
  failWorkflow,
  isCurrentWorkflow as isCurrentWorkflowTransition,
  markAwaitingExecution,
  markDiagnosing,
  markReviewing,
  markTesting,
  releaseWorkflow as releaseWorkflowTransition,
  reserveWorkflow as reserveWorkflowTransition,
  resetForFreshSession,
  scheduleImprovement,
  type GateState,
  type PersistedWorkflowState,
  type ReviewStage,
  type ThinkingLevel,
  type WorkflowConfig,
} from "./lib/loop-agent-state.ts";
import {
  runVerification,
  type VerificationCommandSpec,
  type VerificationResult,
} from "./lib/verification-runner.ts";
import {
  createPiProcessRuntime,
  type PiProcessRuntime,
} from "./lib/loop-agent-process.ts";
import {
  isThinkingLevel,
  loadWorkflowConfig,
  saveWorkflowConfig,
  THINKING_LEVELS,
} from "./lib/loop-agent-config.ts";

// loop-agent: 새 세션의 첫 메시지 또는 /hard-goal을 자동 계획 파이프라인으로 감싸
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
const CHECKLIST_START = "<!-- grill-checklist:start -->";
const CHECKLIST_END = "<!-- grill-checklist:end -->";
const REVIEW_START = "<!-- grill-review:start -->";
const REVIEW_END = "<!-- grill-review:end -->";
const TEST_RESULT_START = "<!-- loop-agent-test-result:start -->";
const TEST_RESULT_END = "<!-- loop-agent-test-result:end -->";
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_FORMAT_RETRIES = 2;
const MAX_PARALLEL_CODING_TASKS = 4;
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGE_SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
const PACKAGE_ISSUE_STORE_CLI_PATH = path.join(
  PACKAGE_ROOT,
  "scripts",
  "issue-store.js",
);
const AGENT_SKILLS_DIR = path.join(AGENT_DIR, "skills");
// 설치된 Pi 패키지에서는 패키지 내부 스킬을 우선 사용하고, 단일 확장으로
// 로드하는 개발/호환 경로에서는 기존 전역 agent 홈을 fallback으로 사용한다.
const SKILLS_DIR = fs.existsSync(PACKAGE_SKILLS_DIR)
  ? PACKAGE_SKILLS_DIR
  : AGENT_SKILLS_DIR;
const CONFIG_PATH = path.join(
  AGENT_DIR,
  "settings.json",
);
const CHECKLIST_SKILL_PATH = path.join(
  SKILLS_DIR,
  SKILL_NAME,
  "SKILL.md",
);
const processRuntime = createPiProcessRuntime();

export type LoopAgentExecutionRuntime = {
  state: GateState;
  process: PiProcessRuntime;
  getConfig: () => WorkflowConfig;
};

function skillPath(skillName: string): string {
  return path.join(SKILLS_DIR, skillName, "SKILL.md");
}

function buildArchitectureReadGuidance(root: string): string {
  return [
    "<architecture-search-gate>",
    "구현 계획을 확정하거나 코드를 수정하기 전에 SQLite의 `search-architecture` 결과를 반드시 참고하라.",
    "아키텍처 문서의 원문은 SQLite가 보유한 section 본문이며, 검색 결과와 `get-architecture`로 읽는다.",
    `- 아키텍처 검색 저장소: ${issueStoreDatabasePath(root)}`,
    "- 이슈·문서·변경 이력은 issue-store CLI를 통해서만 생성·조회·수정한다.",
    "검색 결과에서 현재 작업에 적용되는 source of truth, 변경하지 않을 책임 경계, 관련 ADR을 작업 계획에 명시하라.",
    "최종 목표 체크리스트에는 변경된 코드가 위 아키텍처의 책임 경계, source of truth, 불변조건을 지키는지 확인하는 항목을 작업 크기와 무관하게 항상 포함하라.",
    "검색 결과가 없으면 SQLite에 관련 근거가 없음을 명시하고, 존재하지 않는 아키텍처 규칙을 추측하지 마라.",
    "</architecture-search-gate>",
  ].join("\n");
}

function issueStoreDatabasePath(root: string): string {
  return path.join(root, "docs", "issues.sqlite");
}

function issueStoreCliShellCommand(root: string, args: string): string {
  return `AGENT_DIR="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; node "$AGENT_DIR/scripts/issue-store.js" ${args} --root ${JSON.stringify(root)}`;
}

// 코딩 에이전트(초기 실행·개선 라운드)에게 SQLite 이슈 상태 전이를
// 강제하는 공통 지침. 확장은 상태를 직접 바꾸지 않고 CLI 경계를 주입한다.
function buildTaskTrackingInstructions(root: string): string {
  const startCommand = issueStoreCliShellCommand(root, "update-status T-### current");
  const doneCommand = issueStoreCliShellCommand(root, "update-status T-### done");
  const changeCommand = issueStoreCliShellCommand(root, 'record-change --summary "요약" --issue T-###');
  return [
    "<task-tracking>",
    `이 프로젝트의 이슈·문서·변경 이력 저장소는 ${issueStoreDatabasePath(root)}다. agent 설치 위치의 issue-store CLI만 사용하라.`,
    "",
    `1) 착수: 담당 T-###를 \`${startCommand}\`로 전이하라.`,
    `2) 완료: 모든 수용 기준을 만족하면 \`${doneCommand}\`로 전이하라.`,
    `3) 사소한 변경: 큰 태스크가 아닌 부수 변경(오타·문구·리팩터·설정 등)은 \`${changeCommand}\`로 SQLite change_log에 기록하라.`,
    "</task-tracking>",
  ].join("\n");
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 진행 로그가 섞여도 JSON 객체 라인만 사용한다.
    }
  }
  return undefined;
}

function resolveBundledEmbeddingPython(): string {
  const configured = process.env.ISSUE_EMBEDDING_PYTHON?.trim();
  if (configured) return configured;

  const agentRoot = path.dirname(CONFIG_PATH);
  const candidates =
    process.platform === "win32"
      ? [path.join(agentRoot, ".venv", "Scripts", "python.exe")]
      : [path.join(agentRoot, ".venv", "bin", "python")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "python3";
}

type IssueStoreCliInvocation = {
  cliPath: string;
  cliArgs: string[];
};

function resolveIssueStoreCliInvocation(
  root: string,
  args: string[],
): IssueStoreCliInvocation | undefined {
  const projectCliPath = path.join(root, "scripts", "issue-store.js");
  const bundledCliPath = PACKAGE_ISSUE_STORE_CLI_PATH;
  const cliPath = fs.existsSync(projectCliPath)
    ? projectCliPath
    : fs.existsSync(bundledCliPath)
      ? bundledCliPath
      : undefined;
  if (!cliPath) return undefined;

  const cliArgs = [...args];
  if (!cliArgs.includes("--root")) cliArgs.push("--root", root);
  if (!process.env.ISSUE_EMBEDDING_COMMAND && !cliArgs.includes("--embedding-command")) {
    const bundledEmbeddingPath = path.join(
      PACKAGE_ROOT,
      "scripts",
      "issue-embedding.py",
    );
    if (fs.existsSync(bundledEmbeddingPath)) {
      cliArgs.push(
        "--embedding-command",
        `${JSON.stringify(resolveBundledEmbeddingPython())} ${JSON.stringify(bundledEmbeddingPath)}`,
      );
    }
  }

  return { cliPath, cliArgs };
}

function runIssueStoreCli(
  root: string,
  args: string[],
  onProgress?: (line: string) => void,
): Record<string, unknown> | undefined {
  const invocation = resolveIssueStoreCliInvocation(root, args);
  if (!invocation) return undefined;

  const result = spawnSync(process.execPath, [invocation.cliPath, ...invocation.cliArgs], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (onProgress && typeof result.stderr === "string") {
    for (const line of result.stderr.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      onProgress(line);
    }
  }
  if (result.status !== 0) return undefined;
  return parseLastJsonObject(result.stdout);
}

function runIssueStoreCliAsync(
  root: string,
  args: string[],
  onProgress?: (line: string) => void,
): Promise<Record<string, unknown> | undefined> {
  const invocation = resolveIssueStoreCliInvocation(root, args);
  if (!invocation) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [invocation.cliPath, ...invocation.cliArgs], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBuffer = "";
    let settled = false;

    const consumeProgress = (chunk: unknown, flush = false): void => {
      stderrBuffer += String(chunk ?? "");
      const parts = stderrBuffer.split(/[\r\n]+/);
      stderrBuffer = parts.pop() ?? "";
      if (flush && stderrBuffer) {
        parts.push(stderrBuffer);
        stderrBuffer = "";
      }
      if (onProgress) {
        for (const line of parts.map((value) => value.trim()).filter(Boolean)) {
          onProgress(line);
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      consumeProgress(chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      consumeProgress("", true);
      resolve(code === 0 ? parseLastJsonObject(stdout) : undefined);
    });
  });
}

export {
  buildDeterministicTestReport,
  resolveVerificationCommands,
  reserveWorkflow,
  runExecutionReviewLoop,
  runValidatedTestAgent,
};

function loadIssueStoreRecords(
  root: string,
  onProgress?: (line: string) => void,
): IssueStoreRecord[] {
  if (!fs.existsSync(issueStoreDatabasePath(root))) return [];
  const response = runIssueStoreCli(root, ["list"], onProgress);
  return Array.isArray(response?.issues)
    ? (response.issues as IssueStoreRecord[])
    : [];
}

async function ensureIssueStore(ctx: ExtensionContext): Promise<boolean> {
  const root = ctx.cwd;
  if (fs.existsSync(issueStoreDatabasePath(root))) return true;

  const result = await runIssueStoreCliAsync(root, ["init"], (line) => {
    if (ctx.hasUI) ctx.ui.notify(`loop-agent: ${line}`, "info");
  });
  if (result?.ok === true) return true;
  if (ctx.hasUI) {
    ctx.ui.notify(
      "loop-agent: SQLite 저장소를 초기화하지 못해 자동 파이프라인을 시작할 수 없습니다.",
      "error",
    );
  }
  return false;
}

const planningSearchDependencies: PlanningSearchDependencies = {
  ensureIssueStore,
  runIssueStoreCliAsync,
};

export function chooseParallelCodingTasksFromIssues(
  records: IssueStoreRecord[],
  planningResponse: string,
): TaskBlock[] {
  return selectParallelCodingTasksFromIssues(
    records,
    planningResponse,
    MAX_PARALLEL_CODING_TASKS,
  ) as TaskBlock[];
}

function chooseParallelCodingTasks(
  root: string,
  planningResponse: string,
  onProgress?: (line: string) => void,
): TaskBlock[] {
  return chooseParallelCodingTasksFromIssues(
    loadIssueStoreRecords(root, onProgress),
    planningResponse,
  );
}

function buildParallelTaskCodingPrompt(
  task: TaskBlock,
  checklist: string,
  root: string,
): string {
  return [
    "당신은 병렬 코딩 단계의 서브태스크 전용 구현 에이전트다.",
    "아래 T-### 블록 하나만 책임지고 구현하라. 다른 서브태스크까지 확장하지 말라.",
    "다른 병렬 에이전트와 충돌을 줄이기 위해 프로젝트 문서 파일과 SQLite DB를 직접 수정하지 말라. 이슈·문서·변경 이력은 issue-store CLI를 사용하라.",
    "현재 작업 디렉터리는 임시 분기용 스냅샷이다. 이 스냅샷 안에서 필요한 코드만 수정하라.",
    `실제 수정 대상 루트: ${root}`,
    "가능하면 이 서브태스크와 직접 관련된 파일만 건드리고, 완료 후 변경 내용과 실행한 검증만 간단히 보고하라.",
    "",
    buildImplementSkillGuidance(root),
    "",
    "<parallel-task>",
    `담당 태스크: ${task.id} ${task.title}`,
    task.raw,
    "</parallel-task>",
    "",
    "전체 목표 체크리스트(회귀 방지용):",
    checklist,
  ].join("\n");
}

function buildParallelIntegrationPrompt(
  checklist: string,
  taskRuns: ParallelTaskRun[],
  root: string,
): string {
  const summaries = taskRuns
    .map(
      (run, index) =>
        `${index + 1}. ${run.task.id} ${run.task.title}\n변경 파일 수: ${run.changes.length}\n요약:\n${run.output}`,
    )
    .join("\n\n");

  return [
    "병렬 서브태스크 코딩 결과가 현재 워크트리에 이미 병합되어 있다.",
    "이제 남은 일만 처리하라: 교차 서브태스크 seam 정리, 누락된 최소 통합 수정, 그리고 SQLite change_log 갱신.",
    "이미 병합된 큰 구현을 다시 처음부터 뒤엎지 말고, 현재 워크트리를 직접 읽어 최소 보완만 하라.",
    "",
    buildImplementSkillGuidance(root),
    "",
    buildTaskTrackingInstructions(root),
    "",
    "병렬 서브태스크 요약:",
    summaries,
    "",
    "전체 목표 체크리스트:",
    checklist,
  ].join("\n");
}

function shouldSkipSnapshotPath(relativePath: string): boolean {
  const top = relativePath.split(path.sep)[0] ?? relativePath;
  return [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".dart_tool",
    "Pods",
    "DerivedData",
    ".gradle",
    "coverage",
  ].includes(top);
}

function copyWorkspaceSnapshot(sourceRoot: string, snapshotRoot: string): void {
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.cpSync(sourceRoot, snapshotRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(sourceRoot, source);
      if (!relativePath) return true;
      return !shouldSkipSnapshotPath(relativePath);
    },
  });
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function listWorkspaceFiles(root: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (shouldSkipSnapshotPath(relativePath)) continue;
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      results.push(relativePath);
    }
  }

  walk(root);
  return results.sort();
}

function captureWorkspaceHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const relativePath of listWorkspaceFiles(root)) {
    hashes.set(relativePath, hashFile(path.join(root, relativePath)));
  }
  return hashes;
}

function detectSnapshotChanges(
  snapshotRoot: string,
  baseHashes: Map<string, string>,
): SnapshotChange[] {
  const snapshotHashes = captureWorkspaceHashes(snapshotRoot);
  const allPaths = new Set([
    ...Array.from(baseHashes.keys()),
    ...Array.from(snapshotHashes.keys()),
  ]);
  const changes: SnapshotChange[] = [];

  for (const relativePath of allPaths) {
    const before = baseHashes.get(relativePath);
    const after = snapshotHashes.get(relativePath);
    if (before === after) continue;
    if (before == null && after != null) {
      changes.push({ relativePath, kind: "add" });
      continue;
    }
    if (before != null && after == null) {
      changes.push({ relativePath, kind: "delete" });
      continue;
    }
    changes.push({ relativePath, kind: "modify" });
  }

  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function applySnapshotChanges(
  sourceRoot: string,
  taskRuns: ParallelTaskRun[],
  baseHashes: Map<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const claimedPaths = new Map<string, string>();

  for (const run of taskRuns) {
    for (const change of run.changes) {
      const existing = claimedPaths.get(change.relativePath);
      if (existing) {
        return {
          ok: false,
          reason: `병렬 태스크가 같은 파일을 수정했습니다: ${change.relativePath} (${existing}, ${run.task.id})`,
        };
      }
      claimedPaths.set(change.relativePath, run.task.id);
    }
  }

  for (const run of taskRuns) {
    for (const change of run.changes) {
      const destinationPath = path.join(sourceRoot, change.relativePath);
      const currentHash = fs.existsSync(destinationPath)
        ? hashFile(destinationPath)
        : null;
      const expectedHash = baseHashes.get(change.relativePath) ?? null;
      if (currentHash !== expectedHash) {
        return {
          ok: false,
          reason: `병합 직전 원본 파일이 바뀌어 자동 병합을 중단합니다: ${change.relativePath}`,
        };
      }
    }
  }

  const backups: FileBackup[] = [];
  for (const run of taskRuns) {
    for (const change of run.changes) {
      const destinationPath = path.join(sourceRoot, change.relativePath);
      backups.push({
        relativePath: change.relativePath,
        content: fs.existsSync(destinationPath)
          ? fs.readFileSync(destinationPath)
          : null,
      });
    }
  }

  try {
    for (const run of taskRuns) {
      for (const change of run.changes) {
        const destinationPath = path.join(sourceRoot, change.relativePath);
        const sourcePath = path.join(run.snapshotDir, change.relativePath);
        if (change.kind === "delete") {
          if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath);
          continue;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
      }
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      const destinationPath = path.join(sourceRoot, backup.relativePath);
      if (backup.content == null) {
        if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath);
        continue;
      }
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, backup.content);
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `병합 중 롤백이 발생했습니다: ${message}` };
  }

  return { ok: true };
}

function isLikelyQuickTask(objective: string): boolean {
  const normalized = objective.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 120) return false;
  if (/\n|;|&&|\|\|/.test(normalized)) return false;

  const actionMarkers = [
    "fix",
    "remove",
    "rename",
    "update",
    "add",
    "change",
    "adjust",
    "reduce",
    "simplify",
    "shorten",
    "cleanup",
    "patch",
    "replace",
    "restore",
    "allow",
    "block",
    "sort",
    "normalize",
    "trim",
    "repair",
    "enable",
    "disable",
    "강화",
    "완화",
    "수정",
    "추가",
    "삭제",
    "변경",
    "정리",
    "줄여",
    "줄이",
    "짧게",
    "정규화",
    "복구",
    "차단",
    "허용",
    "개선",
    "패치",
    "교체",
    "조정",
    "해결",
    "고쳐",
    "고치",
    "바꿔",
    "바꾸",
    "아껴",
    "아끼",
    "만들",
    "수리",
  ];
  if (!actionMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  const complexityMarkers = [
    "plan",
    "prd",
    "design",
    "architecture",
    "analysis",
    "review",
    "test",
    "migration",
    "refactor",
    "document",
    "spec",
    "prototype",
    "investigate",
    "analyze",
    "multiple",
    "all of",
    "여러",
    "복수",
    "전체",
    "모두",
    "계획",
    "설계",
    "분석",
    "검토",
    "테스트",
    "마이그레이션",
    "리팩터",
    "문서",
    "사양",
    "아키텍처",
  ];
  if (complexityMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  const words = normalized.split(/\s+/).length;
  return words <= 12;
}

function parseGoalMode(
  objective: string,
): { mode: "plan" | "direct"; objective: string } | null {
  const match = objective.trim().match(/^(plan|direct)\s+(.+)$/i);
  if (!match) return null;
  return {
    mode: match[1].toLowerCase() as "plan" | "direct",
    objective: match[2].trim(),
  };
}

function ensureWorkflowWorkspace(
  ctx: ExtensionContext,
  _explicit: boolean,
): boolean {
  if (!ctx.isIdle()) {
    ctx.ui.notify(
      "loop-agent: 현재 에이전트 실행이 끝난 뒤 다시 시도하세요.",
      "warning",
    );
    return false;
  }
  if (state.workflowId || state.processingWorkflowId) {
    ctx.ui.notify(
      "loop-agent: 이미 진행 중인 목표가 있습니다. 중단하려면 /loop-agent clear를 먼저 실행하세요.",
      "warning",
    );
    return false;
  }

  return true;
}

/**
 * 비동기 전처리보다 먼저 워크플로를 예약한다.
 *
 * ensureWorkflowWorkspace()만 통과시키고 await하면 두 목표가 모두
 * workflowId가 없는 상태를 관찰할 수 있다. 예약은 동기적으로 수행되므로
 * 두 번째 진입은 이후 ensureWorkflowWorkspace()에서 차단된다.
 */
function reserveWorkflow(
  autoReview: boolean,
  reviewStage: ReviewStage,
  checklist: string | null,
): string {
  return reserveWorkflowTransition(state, autoReview, reviewStage, checklist);
}

/** 예약 이후 clear 또는 새 세대가 시작됐으면 오래된 실패 처리를 버린다. */
function releaseWorkflowIfCurrent(
  pi: ExtensionAPI,
  workflowId: string,
  reason: string,
): void {
  if (!isCurrentWorkflowTransition(state, workflowId)) return;
  releaseWorkflowTransition(state);
  persistWorkflowState(pi, reason);
}

/**
 * 취소된 뒤 늦게 도착한 계획 응답을 다시 연결할 때 원래 목표의 모드를
 * 복구한다. clear가 마지막 스냅샷을 null로 만들기 때문에 같은 workflow ID의
 * 이전 스냅샷을 찾아 easy-goal의 autoReview=false 설정도 보존한다.
 */
function findPersistedAutoReview(
  ctx: ExtensionContext,
  workflowId: string,
): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: string;
      customType?: string;
      data?: { snapshot?: Partial<PersistedWorkflowState> };
    };
    if (entry.type !== "custom" || entry.customType !== "loop-agent-state") {
      continue;
    }
    const snapshot = entry.data?.snapshot;
    if (snapshot?.workflowId === workflowId) {
      return snapshot.autoReview !== false;
    }
  }
  return true;
}

/**
 * 현재 workflow가 없는 동안 최종 계획 응답이 늦게 도착한 경우, 계획을
 * 버리고 끝내지 않고 새 세대로 재연결한다. 새 ID를 발급해 stale 응답이
 * 이후의 다른 목표와 다시 충돌하지 않게 한다.
 */
function recoverStalePlanningWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  responseWorkflowId: string,
  checklist: string | null,
): string {
  const workflowId = reserveWorkflowTransition(
    state,
    findPersistedAutoReview(ctx, responseWorkflowId),
    checklist ? "awaiting-execution" : "idle",
    checklist,
  );
  pi.appendEntry("loop-agent-workflow-recovered", {
    previousWorkflowId: responseWorkflowId,
    workflowId,
    hasChecklist: Boolean(checklist),
  });
  persistWorkflowState(pi, "stale-workflow-recovered");
  return workflowId;
}

// 구현 단계에서 따를 스킬: implement(구현 절차) + tdd(red-green-refactor 규율).
// 자식 프로세스는 --no-skills로 실행되므로, 본문을 직접 붙이지 말고 파일 경로만
// 알려준 뒤 read 도구로 읽게 한다.
const IMPLEMENT_PIPELINE_SKILLS = ["implement", "tdd"] as const;

function buildImplementSkillGuidance(root: string): string {
  const skillFiles = IMPLEMENT_PIPELINE_SKILLS.map((skillName) =>
    skillPath(skillName),
  );

  return [
    "<implement-adapter>",
    buildArchitectureReadGuidance(root),
    "",
    "아래 스킬 파일을 먼저 직접 읽고 절차를 따르라. 본문을 프롬프트에 재인용하지 말라:",
    ...skillFiles.map((filePath) => `- ${filePath}`),
    "이 자동 파이프라인에서는 `/tdd`, `/code-review` 슬래시 호출을 스스로 하지 말라.",
    "직접 git 커밋/푸시는 하지 말고, 태스크 상태는 위 <task-tracking> 지침만 따르라.",
    "테스트 실행은 가능하지만, 최종 판정은 별도 테스트·검수 에이전트가 다시 확인한다.",
    "</implement-adapter>",
  ].join("\n");
}

type FailedItem = {
  item: string;
  reason: string;
  evidence: string;
};

type ReviewResult = {
  overall: "PASS" | "FAIL";
  failedItems: FailedItem[];
};

type FailedCommand = {
  command: string;
  reason: string;
  evidence: string;
};

type TestResult = {
  overall: "PASS" | "FAIL";
  failedCommands: FailedCommand[];
};

type TestingStageResult =
  | { status: "stale" }
  | {
      status: "completed";
      testReport: string | null;
      testResult: TestResult | null;
    };

type ReviewStageResult =
  | { status: "stale" | "stopped" | "completed" }
  | { status: "scheduled"; codingPrompt: string };

type IndependentAgentMode = "review" | "test-failure-diagnosis";

type TaskBlock = {
  id: string;
  label: string | null;
  title: string;
  status: "backlog" | "in-progress" | "done" | null;
  parentIds: string[];
  blockedByIds: string[];
  raw: string;
  sourcePath: string;
};

type SnapshotChange = {
  relativePath: string;
  kind: "add" | "modify" | "delete";
};

type ParallelTaskRun = {
  task: TaskBlock;
  snapshotDir: string;
  output: string;
  changes: SnapshotChange[];
};

type FileBackup = {
  relativePath: string;
  content: Buffer | null;
};

// length 정지 자동 재개 상한. 모델이 계속 한도에 부딪혀도 이 횟수를 넘으면
// 재개를 멈추고 사용자에게 알린다.
const MAX_LENGTH_CONTINUES = 10;
// 잘린 응답을 이어가라고 지시하는 후속 사용자 메시지. 사용자가 수동으로 치던
// "진행해"를 확장이 대신 보낸다.
const LENGTH_CONTINUE_PROMPT =
  "직전 응답이 출력 토큰 한도(stopReason=length)로 중간에 잘렸습니다. 새로 시작하지 말고 중단된 지점에서 이어서 계속 진행하세요.";
// run이 idle로 전이할 때까지 자동 재개 대기 상한.
const LENGTH_CONTINUE_TIMEOUT_MS = 60 * 1000;
const LENGTH_CONTINUE_POLL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortenStatusLine(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

// 자식 Pi 실행과 NDJSON 파싱은 loop-agent-process 런타임에 위임한다.

// 동일 시점에 두 개의 워크플로 시작이 예약되지 않도록 막는 전이 플래그(비영속).
let executionLoopPending = false;

/**
 * runExecutionReviewLoop를 이벤트 핸들러에서 분리해 실행한다.
 *
 * pi 코어는 agent_end 리스너가 모두 끝난 뒤에야 isStreaming을 해제하므로
 * (pi-agent-core finishRun), 핸들러 안에서 워크플로 전체를 await하면 세션이
 * 워크플로가 끝날 때까지(수십 분~수 시간) 스트리밍 상태로 고정된다. 그동안
 * sendMessage(triggerTurn:false)는 화면 표시·세션 기록 대신 steer 큐로
 * 들어가 진행 로그와 결과가 통째로 사라지고, 사용자에겐 멈춘 화면만 보인다.
 * 그래서 핸들러는 이 함수를 호출만 하고 즉시 리턴하며, 실제 루프는 run이
 * idle로 전이한 뒤 시작한다(scheduleLengthContinue와 같은 패턴).
 */
function startExecutionReviewLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  initialCodingPrompt?: string,
): void {
  if (executionLoopPending) return;
  executionLoopPending = true;
  void (async () => {
    try {
      const deadline = Date.now() + LENGTH_CONTINUE_TIMEOUT_MS;
      while (!ctx.isIdle() && Date.now() < deadline) {
        await sleep(LENGTH_CONTINUE_POLL_MS);
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "loop-agent: 세션이 idle로 전이되지 않아 워크플로 실행을 시작하지 못했습니다.",
          "warning",
        );
        return;
      }
      await runExecutionReviewLoop(pi, ctx, workflowId, initialCodingPrompt);
    } finally {
      executionLoopPending = false;
    }
  })();
}

// 동일 시점에 두 개의 자동 재개가 예약되지 않도록 막는 전이 플래그(비영속).
let lengthContinuePending = false;

/**
 * 출력 토큰 한도로 잘린 턴을 자동으로 이어서 진행한다.
 *
 * 반드시 분리(비-await) 실행해야 한다: agent_end 리스너가 모두 끝나야 run이
 * idle로 전이하므로, 이 대기를 agent_end 안에서 await하면 교착이 발생한다.
 * 그래서 호출측은 이 함수를 await하지 않고 호출만 하고 즉시 리턴한다.
 */
function scheduleLengthContinue(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (lengthContinuePending) return;
  lengthContinuePending = true;
  void (async () => {
    try {
      const deadline = Date.now() + LENGTH_CONTINUE_TIMEOUT_MS;
      // 컴팩션 등 후속 스트리밍까지 끝나 실제로 idle이 될 때까지 기다린다.
      while (!ctx.isIdle() && Date.now() < deadline) {
        await sleep(LENGTH_CONTINUE_POLL_MS);
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "loop-agent: 자동 이어가기 대기 시간이 초과되어 중단합니다. 필요하면 직접 이어서 진행하세요.",
          "warning",
        );
        return;
      }
      // idle 상태에서 보내는 사용자 메시지는 항상 새 턴을 트리거한다.
      pi.sendUserMessage(LENGTH_CONTINUE_PROMPT);
    } finally {
      lengthContinuePending = false;
    }
  })();
}

const state: GateState = createInitialGateState();

let config = loadWorkflowConfig(CONFIG_PATH);

export function createLoopAgentExecutionRuntime(
  dependencies: Partial<LoopAgentExecutionRuntime> = {},
): LoopAgentExecutionRuntime {
  return {
    state: dependencies.state ?? createInitialGateState(),
    process: dependencies.process ?? processRuntime,
    getConfig: dependencies.getConfig ?? (() => config),
  };
}

const defaultExecutionRuntime = createLoopAgentExecutionRuntime({
  state,
  process: processRuntime,
  getConfig: () => config,
});

/**
 * pi.sendUserMessage()는 의도적으로 /skill 명령 확장을 건너뛴다. /hard-goal처럼
 * 확장이 직접 시작하는 턴에서는 Pi 코어와 동일한 형태의 skill 블록을 만들어
 * 전달해야 실제 스킬 지침이 모델 문맥에 포함된다.
 */
function extractWorkflowId(text: string): string | null {
  const pattern = /<!-- loop-agent-workflow:([0-9a-f-]{36}) -->/i;
  return text.match(pattern)?.[1] ?? null;
}

/** 세션 브랜치에 상태 스냅샷을 남겨 reload/resume 시 동일한 루프를 복구한다. */
function persistWorkflowState(
  pi: ExtensionAPI,
  reason: string,
  workflowState: GateState = state,
): void {
  const snapshot: PersistedWorkflowState = {
    reviewStage: workflowState.reviewStage,
    checklist: workflowState.checklist,
    improvementRound: workflowState.improvementRound,
    autoMode: workflowState.autoMode,
    autoReview: workflowState.autoReview,
    workflowId: workflowState.workflowId,
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
    state.autoReview = snapshot.autoReview !== false;
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
  saveWorkflowConfig(CONFIG_PATH, config);
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
      if (selected) {
        // 모델 전환은 사용자가 체감하는 상태 변화이므로, 어떤 역할로 어떤
        // 모델로 바뀌었는지 항상 알린다.
        ctx.ui.notify(
          `loop-agent: ${role} 모델로 전환했습니다: ${modelName}`,
          "info",
        );
      } else {
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

/** agent_end 이벤트에서 마지막 어시스턴트 메시지의 stopReason을 꺼낸다. */
function getLastAssistantStopReason(event: AgentEndEvent): string | null {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index] as {
      role?: string;
      stopReason?: string;
    };
    if (message.role !== "assistant") continue;
    return message.stopReason ?? null;
  }
  return null;
}

/** grill-checklist가 약속한 주석 경계 사이의 체크리스트를 원문 그대로 꺼낸다. */
function extractChecklist(text: string): string | null {
  const start = text.indexOf(CHECKLIST_START);
  if (start < 0) return null;

  const contentStart = start + CHECKLIST_START.length;
  const end = text.indexOf(CHECKLIST_END, contentStart);
  if (end < 0) return null;

  const checklist = text.slice(contentStart, end).trim();
  if (!checklist) return null;
  return checklist.includes(ARCHITECTURE_CHECKLIST_ITEM)
    ? checklist
    : `${checklist}\n${ARCHITECTURE_CHECKLIST_ITEM}`;
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
  ui: Pick<ExtensionContext["ui"], "setStatus">,
  checklist: string,
  modelName: string | null,
  thinkingLevel: ThinkingLevel | null,
  testReport: string | null,
  isIdle?: () => boolean,
  mode: IndependentAgentMode = "review",
  process: PiProcessRuntime = processRuntime,
): Promise<string> {
  const prompt =
    mode === "test-failure-diagnosis"
      ? [
          "당신은 planningModel 역할의 테스트 실패 원인 분석 에이전트다.",
          "코드나 파일을 수정하지 말고, 현재 작업 디렉터리의 실제 파일과 기존 테스트 코드를 직접 확인하라.",
          "별도 테스트 에이전트가 보고한 실패 명령마다 실제 근본 원인과 코드 에이전트가 적용해야 할 수정 방향을 찾아라.",
          "테스트 보고서의 결론을 무비판적으로 신뢰하지 말고 파일·테스트·구현을 대조해 원인을 검증하라.",
          "테스트 실패 보고서가 주어졌으므로 전체 판정은 반드시 FAIL이어야 한다.",
          "failedItems에는 실패 명령 또는 관련 체크리스트를 항목으로 넣고, reason에는 근본 원인과 수정 방향을, evidence에는 실제 파일 경로·테스트명·코드 위치를 적어라.",
          "분석 보고서만 한국어로 출력하라.",
          'FAIL JSON 형식: {"overall":"FAIL","failedItems":[{"item":"실패 명령 또는 체크리스트 항목","reason":"근본 원인과 수정 방향","evidence":"파일 경로·테스트명·코드 위치"}]}',
          `보고서 마지막 줄들에서 먼저 ${REVIEW_START}를 출력하라.`,
          "그 다음 줄에 실제 판정 JSON 객체 하나만 출력하라.",
          `마지막으로 ${REVIEW_END}를 출력하라.`,
          "두 경계 사이에는 설명, 접두어, 마크다운 코드 펜스를 넣지 말라.",
          "",
          ...(testReport
            ? ["테스트 에이전트 실행 보고서:", testReport, ""]
            : []),
          "목표 결과 체크리스트:",
          checklist,
        ].join("\n")
      : [
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
          ...(testReport
            ? ["테스트 에이전트 실행 보고서:", testReport, ""]
            : []),
          "검수 체크리스트:",
          checklist,
        ].join("\n");

  const args = [
    "--mode",
    "json",
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

  const result = await process.runPiCommandWithProgress(
    pi,
    cwd,
    ui,
    mode === "test-failure-diagnosis"
      ? "테스트 실패 원인 분석 에이전트"
      : "독립 검수 에이전트",
    args,
    REVIEW_TIMEOUT_MS,
    isIdle,
  );

  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    const label =
      mode === "test-failure-diagnosis"
        ? "테스트 실패 원인 분석 에이전트"
        : "독립 검수 에이전트";
    throw new Error(`${label} 실행 실패: ${reason}`);
  }

  const report = result.finalText.trim();
  if (!report) {
    const label =
      mode === "test-failure-diagnosis"
        ? "테스트 실패 원인 분석 에이전트"
        : "독립 검수 에이전트";
    throw new Error(`${label}가 빈 보고서를 반환했습니다.`);
  }
  return report;
}

/** 형식 오류만 제한적으로 재시도하고, 실행 실패는 즉시 상위 루프로 전달한다. */
async function runValidatedReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
  testReport: string | null,
  options: {
    modelName?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    mode?: IndependentAgentMode;
    processRuntime?: PiProcessRuntime;
    workflowConfig?: WorkflowConfig;
  } = {},
): Promise<{ report: string; result: ReviewResult }> {
  let lastError: unknown;
  const workflowConfig = options.workflowConfig ?? config;

  const modelName =
    options.modelName !== undefined
      ? options.modelName
      : workflowConfig.verifyingModel ?? workflowConfig.planningModel;
  const thinkingLevel =
    options.thinkingLevel !== undefined
      ? options.thinkingLevel
      : workflowConfig.verifyingThinkingLevel ?? workflowConfig.planningThinkingLevel;

  for (let attempt = 0; attempt <= REVIEW_FORMAT_RETRIES; attempt += 1) {
    const report = await runIndependentReview(
      pi,
      ctx.cwd,
      ctx.ui,
      checklist,
      modelName,
      thinkingLevel,
      testReport,
      ctx.isIdle,
      options.mode,
      options.processRuntime,
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

function verificationCommandLabel(spec: VerificationCommandSpec): string {
  return [spec.program, ...spec.args].join(" ");
}

/**
 * 테스트 에이전트가 임의로 고르는 명령을 검증 계약으로 사용하지 않는다.
 * 프로젝트가 명시한 표준 테스트 명령을 하네스가 직접 실행하며, 필요하면
 * PI_VERIFICATION_COMMANDS로 program/args 배열을 명시적으로 주입할 수 있다.
 */
function resolveVerificationCommands(root: string): VerificationCommandSpec[] {
  const configured = process.env.PI_VERIFICATION_COMMANDS;
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null,
        )
        .map((item) => ({
          program: typeof item.program === "string" ? item.program : "",
          args: Array.isArray(item.args)
            ? item.args.filter((arg): arg is string => typeof arg === "string")
            : [],
          cwd: typeof item.cwd === "string" ? item.cwd : root,
          timeoutMs:
            typeof item.timeoutMs === "number"
              ? item.timeoutMs
              : TEST_TIMEOUT_MS,
          required: item.required !== false,
        }));
    } catch {
      return [];
    }
  }

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      if (typeof packageJson.scripts?.test === "string") {
        return [
          {
            program: "npm",
            args: ["test"],
            cwd: root,
            timeoutMs: TEST_TIMEOUT_MS,
            required: true,
          },
        ];
      }
    } catch {
      return [];
    }
  }

  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    return [
      {
        program: "cargo",
        args: ["test"],
        cwd: root,
        timeoutMs: TEST_TIMEOUT_MS,
        required: true,
      },
    ];
  }

  if (
    fs.existsSync(path.join(root, "pyproject.toml")) ||
    fs.existsSync(path.join(root, "pytest.ini")) ||
    fs.existsSync(path.join(root, "tox.ini"))
  ) {
    return [
      {
        program: "python",
        args: ["-m", "pytest"],
        cwd: root,
        timeoutMs: TEST_TIMEOUT_MS,
        required: true,
      },
    ];
  }

  if (fs.existsSync(path.join(root, "go.mod"))) {
    return [
      {
        program: "go",
        args: ["test", "./..."],
        cwd: root,
        timeoutMs: TEST_TIMEOUT_MS,
        required: true,
      },
    ];
  }

  if (fs.existsSync(path.join(root, "pubspec.yaml"))) {
    return [
      {
        program: "flutter",
        args: ["test", "--no-pub"],
        cwd: root,
        timeoutMs: TEST_TIMEOUT_MS,
        required: true,
      },
    ];
  }

  return [];
}

function buildDeterministicTestReport(
  verification: VerificationResult,
): { report: string; result: TestResult } {
  const failedCommands: FailedCommand[] = verification.results
    .filter((result) => result.status !== "PASS")
    .map((result) => ({
      command: verificationCommandLabel(result),
      reason:
        result.error ??
        (result.timeout
          ? "검증 명령이 제한 시간을 초과했습니다."
          : `검증 명령이 ${result.exitCode ?? result.signal ?? "알 수 없는 상태"}로 종료되었습니다.`),
      evidence: [result.stdout, result.stderr]
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim()
        .slice(0, 4000) || "검증 명령의 출력이 없습니다.",
    }));

  if (verification.status !== "PASS" && failedCommands.length === 0) {
    failedCommands.push({
      command: "검증 명령 선택",
      reason: verification.reason ?? "검증 결과를 확정할 수 없습니다.",
      evidence: "required 검증 명령이 없거나 실행되지 않았습니다.",
    });
  }

  const result: TestResult = {
    overall: verification.status === "PASS" ? "PASS" : "FAIL",
    failedCommands,
  };
  const commandSummary = verification.results.length
    ? verification.results
        .map(
          (item) =>
            `- ${verificationCommandLabel(item)}: ${item.status} (exit=${item.exitCode ?? "-"}, ${item.durationMs}ms)`,
        )
        .join("\n")
    : "- 실행할 required 검증 명령이 없습니다.";
  const report = [
    "## 결정적 검증 실행 결과",
    commandSummary,
    "",
    TEST_RESULT_START,
    JSON.stringify(result, null, 2),
    TEST_RESULT_END,
  ].join("\n");

  return { report, result };
}

async function runValidatedTestAgent(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  _checklist: string,
): Promise<{
  report: string;
  result: TestResult;
  verification: VerificationResult;
}> {
  const verification = await runVerification(resolveVerificationCommands(ctx.cwd));
  const { report, result } = buildDeterministicTestReport(verification);
  return { report, result, verification };
}

async function runParallelCodingPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
  planningResponse: string,
  process: PiProcessRuntime = processRuntime,
  workflowConfig: WorkflowConfig = config,
): Promise<string | null> {
  const tasks = chooseParallelCodingTasks(ctx.cwd, planningResponse, (line) => {
    ctx.ui.notify(`loop-agent: ${line}`, "info");
  });
  if (tasks.length < 2) return null;

  ctx.ui.notify(
    `loop-agent: 독립 서브태스크 ${tasks.length}개를 병렬 코딩으로 fan-out 합니다.`,
    "info",
  );

  const baseHashes = captureWorkspaceHashes(ctx.cwd);
  const snapshotDirs: string[] = [];
  try {
    const taskPromises = tasks.map(async (task): Promise<ParallelTaskRun> => {
      const snapshotDir = path.join(
        os.tmpdir(),
        `loop-agent-${Date.now()}-${task.id}-${randomUUID()}`,
      );
      snapshotDirs.push(snapshotDir);
      copyWorkspaceSnapshot(ctx.cwd, snapshotDir);
      const prompt = buildParallelTaskCodingPrompt(task, checklist, snapshotDir);
      const taskCtx: ExtensionContext = { ...ctx, cwd: snapshotDir };
      const output = await runCodingAgent(pi, taskCtx, prompt, process, workflowConfig);
      const changes = detectSnapshotChanges(snapshotDir, baseHashes);
      return { task, snapshotDir, output, changes };
    });

    const settledRuns = await Promise.allSettled(taskPromises);
    const failures = settledRuns.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const first = failures[0]?.reason;
      const message = first instanceof Error ? first.message : String(first);
      ctx.ui.notify(
        `loop-agent: 병렬 서브태스크 중 일부가 실패해 단일 코딩 경로로 fallback 합니다 (${message}).`,
        "warning",
      );
      return null;
    }
    const taskRuns = settledRuns
      .filter(
        (result): result is PromiseFulfilledResult<ParallelTaskRun> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    const mergeResult = applySnapshotChanges(ctx.cwd, taskRuns, baseHashes);
    if (!mergeResult.ok) {
      ctx.ui.notify(
        `loop-agent: 병렬 코딩 결과를 자동 병합할 수 없어 단일 코딩 경로로 fallback 합니다 (${mergeResult.reason}).`,
        "warning",
      );
      return null;
    }

    const integrationPrompt = buildParallelIntegrationPrompt(
      checklist,
      taskRuns,
      ctx.cwd,
    );
    const integrationOutput = await runCodingAgent(
      pi,
      ctx,
      integrationPrompt,
      process,
      workflowConfig,
    );
    const combined = taskRuns
      .map(
        (run, index) =>
          `## 병렬 서브태스크 ${index + 1}: ${run.task.id} ${run.task.title}\n\n${run.output}`,
      )
      .concat(`## 병렬 병합 후 통합 정리\n\n${integrationOutput}`)
      .join("\n\n");
    return combined;
  } finally {
    for (const snapshotDir of snapshotDirs) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

async function runCodingPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
  prompt: string,
  process: PiProcessRuntime = processRuntime,
  workflowState: GateState = state,
  workflowConfig: WorkflowConfig = config,
): Promise<string> {
  const parallelOutput =
    workflowState.improvementRound === 0
      ? await runParallelCodingPhase(
          pi,
          ctx,
          checklist,
          prompt,
          process,
          workflowConfig,
        )
      : null;
  if (parallelOutput) return parallelOutput;
  return runCodingAgent(pi, ctx, prompt, process, workflowConfig);
}

function mergeVerificationResults(
  review: ReviewResult,
  testResult: TestResult | null,
): ReviewResult {
  if (!testResult || testResult.overall === "PASS") return review;
  return {
    overall: "FAIL",
    failedItems: [
      ...review.failedItems,
      ...testResult.failedCommands.map((item) => ({
        item: `[테스트] ${item.command}`,
        reason: item.reason,
        evidence: item.evidence,
      })),
    ],
  };
}

function buildMergedReviewReport(
  reviewReport: string,
  testResult: TestResult | null,
): string {
  if (!testResult || testResult.overall === "PASS") return reviewReport;
  const failures = testResult.failedCommands
    .map(
      (item, index) =>
        `${index + 1}. 명령: ${item.command}\n   실패 이유: ${item.reason}\n   근거: ${item.evidence}`,
    )
    .join("\n");
  return [
    reviewReport,
    "",
    "## 병렬 테스트 판정 보강",
    "아래 검증 명령 실패를 최종 미통과 근거에 추가합니다.",
    failures,
  ].join("\n");
}

function isCurrentWorkflow(workflowId: string): boolean {
  return isCurrentWorkflowTransition(state, workflowId);
}

/** 코드 모델을 별도 Pi 프로세스로 실행하고 성공 여부를 종료 코드로 확인한다. */
async function runCodingAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  process: PiProcessRuntime = processRuntime,
  workflowConfig: WorkflowConfig = config,
): Promise<string> {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
  ];
  const modelName =
    workflowConfig.codingModel ??
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
  if (modelName) args.push("--model", modelName);
  if (workflowConfig.codingThinkingLevel)
    args.push("--thinking", workflowConfig.codingThinkingLevel);
  args.push(prompt);

  // loop-agent만 환경 플래그로 비활성화하고 MCP 어댑터 등 나머지 확장은
  // 그대로 로드한다. 직접 spawn해서 stdout/stderr를 중간중간 status로 흘린다.
  const result = await process.runPiCommandWithProgress(
    pi,
    ctx.cwd,
    ctx.ui,
    "코드 에이전트",
    args,
    // 코드 에이전트는 긴 도구 실행을 허용하고 wall-clock 제한을 두지 않는다.
    undefined,
    ctx.isIdle,
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`코드 에이전트 실행 실패: ${reason}`);
  }

  const output = result.finalText.trim();
  if (!output) throw new Error("코드 에이전트가 빈 결과를 반환했습니다.");
  return output;
}

function buildImprovementPrompt(
  result: ReviewResult,
  checklist: string,
  round: number,
  root: string,
): string {
  const failedItems = result.failedItems
    .map(
      (item, index) =>
        `${index + 1}. 항목: ${item.item}\n   실패 이유: ${item.reason}\n   근거: ${item.evidence}`,
    )
    .join("\n");

  return [
    `자동 개선 ${round}차에서 아래 항목이 통과하지 못했습니다.`,
    "실제 코드와 검증 결과를 확인해 실패 항목만 개선하고 관련 테스트를 실행하세요.",
    "기존에 통과한 항목을 회귀시키지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
    "",
    buildImplementSkillGuidance(root),
    "",
    buildTaskTrackingInstructions(root),
    "이 태스크의 상태는 SQLite issue-store에서 관리한다. 수용 기준을 모두 만족한 뒤에만 issue-store CLI로 done 상태로 전이하세요.",
    "",
    failedItems,
    "",
    "전체 목표 체크리스트:",
    checklist,
  ].join("\n");
}

type TestFailureRecovery =
  | { status: "scheduled"; codingPrompt: string }
  | { status: "stopped" }
  | { status: "stale" };

/** easy-goal과 hard-goal의 테스트 실패를 planningModel 진단 루프로 통일한다. */
async function recoverFromTestFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  testReport: string | null,
  testResult: TestResult | null,
  execution: LoopAgentExecutionRuntime = defaultExecutionRuntime,
): Promise<TestFailureRecovery> {
  const workflowState = execution.state;
  const workflowConfig = execution.getConfig();
  if (!isCurrentWorkflowTransition(workflowState, workflowId) || !workflowState.checklist) {
    return { status: "stale" };
  }

  if (workflowState.improvementRound >= workflowConfig.maxImprovementRounds) {
    failWorkflow(workflowState);
    persistWorkflowState(pi, "max-rounds-reached", workflowState);
    ctx.ui.notify(
      `loop-agent: 테스트 실패 원인 분석·재실행이 최대 개선 횟수(${workflowConfig.maxImprovementRounds})에 도달했습니다.`,
      "error",
    );
    return { status: "stopped" };
  }

  const failureReport =
    testReport ??
    [
      "테스트 에이전트가 구조화된 보고서를 반환하지 못했습니다.",
      ...(testResult?.failedCommands ?? []).map(
        (item) => `- ${item.command}: ${item.reason} (${item.evidence})`,
      ),
    ].join("\n");

  markDiagnosing(workflowState);
  persistWorkflowState(pi, "test-failure-diagnosis-started", workflowState);
  ctx.ui.notify(
    "loop-agent: 테스트 실패 원인을 planningModel로 분석합니다.",
    "warning",
  );

  const diagnosis = await runValidatedReview(
    pi,
    ctx,
    workflowState.checklist,
    failureReport,
    {
      modelName: workflowConfig.planningModel,
      thinkingLevel: workflowConfig.planningThinkingLevel,
      mode: "test-failure-diagnosis",
      processRuntime: execution.process,
      workflowConfig,
    },
  );
  if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };
  if (
    diagnosis.result.overall !== "FAIL" ||
    diagnosis.result.failedItems.length === 0
  ) {
    throw new Error(
      "planningModel이 테스트 실패 원인과 수정 항목을 제시하지 않았습니다.",
    );
  }

  pi.appendEntry("loop-agent-test-failure-diagnosis", {
    workflowId,
    round: workflowState.improvementRound,
    testReport: failureReport,
    output: diagnosis.report,
  });
  pi.sendMessage(
    {
      customType: "loop-agent-test-failure-diagnosis",
      content: `## planningModel 테스트 실패 원인 분석\n\n${diagnosis.report}`,
      display: true,
      details: { workflowId, round: workflowState.improvementRound },
    },
    { triggerTurn: false },
  );

  const improvementRound = scheduleImprovement(workflowState);
  persistWorkflowState(pi, "test-failure-improvement-scheduled", workflowState);
  const codingPrompt = buildImprovementPrompt(
    diagnosis.result,
    workflowState.checklist ?? "",
    improvementRound,
    ctx.cwd,
  );
  ctx.ui.notify(
    `loop-agent: planningModel 분석을 반영해 코드 에이전트를 재실행합니다 (${improvementRound}/${workflowConfig.maxImprovementRounds}).`,
    "warning",
  );
  return { status: "scheduled", codingPrompt };
}

async function runCodingStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  checklist: string,
  codingPrompt: string | undefined,
  execution: LoopAgentExecutionRuntime,
): Promise<"completed" | "stale"> {
  if (!codingPrompt) return "completed";

  const workflowState = execution.state;
  markAwaitingExecution(workflowState);
  persistWorkflowState(pi, "coding-started", workflowState);
  ctx.ui.notify("loop-agent: 코드 에이전트를 실행합니다.", "info");
  const codingOutput = await runCodingPhase(
    pi,
    ctx,
    checklist,
    codingPrompt,
    execution.process,
    workflowState,
    execution.getConfig(),
  );
  if (!isCurrentWorkflowTransition(workflowState, workflowId)) return "stale";

  pi.appendEntry("loop-agent-coding-result", {
    workflowId,
    round: workflowState.improvementRound,
    output: codingOutput,
  });
  pi.sendMessage(
    {
      customType: "loop-agent-coding-result",
      content: `## 코드 에이전트 실행 결과\n\n${codingOutput}`,
      display: true,
      details: { workflowId, round: workflowState.improvementRound },
    },
    { triggerTurn: false },
  );
  persistWorkflowState(pi, "coding-completed", workflowState);
  return "completed";
}

async function runTestingStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  checklist: string,
  execution: LoopAgentExecutionRuntime = defaultExecutionRuntime,
): Promise<TestingStageResult> {
  const workflowState = execution.state;
  if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };

  markTesting(workflowState);
  persistWorkflowState(pi, "testing-started", workflowState);
  ctx.ui.notify(
    workflowState.autoReview
      ? "loop-agent: 결정적 검증 명령을 실행합니다. 통과하면 독립 검수를 시작합니다."
      : "loop-agent: 결정적 검증 명령을 실행합니다.",
    "info",
  );

  let testReport: string | null = null;
  let testResult: TestResult | null = null;
  try {
    const testRun = await runValidatedTestAgent(pi, ctx, checklist);
    testReport = testRun.report;
    testResult = testRun.result;
    if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };
    pi.appendEntry("loop-agent-test-result", {
      workflowId,
      round: workflowState.improvementRound,
      output: testReport,
      verification: testRun.verification,
    });
    pi.sendMessage(
      {
        customType: "loop-agent-test-result",
        content: `## 결정적 검증 실행 결과\n\n${testReport}`,
        display: true,
        details: {
          workflowId,
          round: workflowState.improvementRound,
          verificationStatus: testRun.verification.status,
          requiredCount: testRun.verification.requiredCount,
          requiredExecutedCount: testRun.verification.requiredExecutedCount,
        },
      },
      { triggerTurn: false },
    );
  } catch (error) {
    if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };
    const message = error instanceof Error ? error.message : String(error);
    testResult = {
      overall: "FAIL",
      failedCommands: [
        {
          command: "결정적 검증 실행기",
          reason: message,
          evidence:
            "검증 실행기가 성공적으로 완료되거나 구조화된 결과를 반환하지 못했습니다.",
        },
      ],
    };
    ctx.ui.notify(
      `loop-agent: 테스트 에이전트가 실패했습니다 (${message}). 이 라운드는 테스트 미통과로 처리합니다.`,
      "warning",
    );
  }
  persistWorkflowState(pi, "testing-completed", workflowState);
  return { status: "completed", testReport, testResult };
}

function completeWithoutReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  execution: LoopAgentExecutionRuntime = defaultExecutionRuntime,
): void {
  completeWorkflow(execution.state);
  persistWorkflowState(pi, "completed-without-review", execution.state);
  ctx.ui.notify(
    "loop-agent: 테스트 단계까지 완료했고 독립 검수 자동 반복은 생략합니다.",
    "info",
  );
}

async function runReviewStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  checklist: string,
  testReport: string | null,
  testResult: TestResult,
  execution: LoopAgentExecutionRuntime = defaultExecutionRuntime,
): Promise<ReviewStageResult> {
  const workflowState = execution.state;
  const workflowConfig = execution.getConfig();
  if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };

  markReviewing(workflowState);
  persistWorkflowState(pi, "review-started", workflowState);
  const { report: rawReviewReport, result: rawReviewResult } =
    await runValidatedReview(pi, ctx, checklist, testReport, {
      processRuntime: execution.process,
      workflowConfig,
    });
  if (!isCurrentWorkflowTransition(workflowState, workflowId)) return { status: "stale" };

  const report = buildMergedReviewReport(rawReviewReport, testResult);
  const result = mergeVerificationResults(rawReviewResult, testResult);
  pi.appendEntry("loop-agent-review", {
    workflowId,
    checklist,
    report,
    round: workflowState.improvementRound,
    result,
  });
  pi.sendMessage(
    {
      customType: "loop-agent-review",
      content: `## 독립 에이전트 검수 결과\n\n${report}`,
      display: true,
      details: { workflowId, checklist },
    },
    { triggerTurn: false },
  );

  if (result.overall === "PASS") {
    completeWorkflow(workflowState);
    persistWorkflowState(pi, "completed", workflowState);
    ctx.ui.notify("loop-agent: 모든 체크리스트 항목이 통과했습니다.", "info");
    return { status: "completed" };
  }

  if (workflowState.improvementRound >= workflowConfig.maxImprovementRounds) {
    failWorkflow(workflowState);
    persistWorkflowState(pi, "max-rounds-reached", workflowState);
    ctx.ui.notify(
      `loop-agent: 최대 개선 횟수(${workflowConfig.maxImprovementRounds})에 도달했습니다.`,
      "error",
    );
    return { status: "stopped" };
  }

  const improvementRound = scheduleImprovement(workflowState);
  persistWorkflowState(pi, "improvement-scheduled", workflowState);
  const codingPrompt = buildImprovementPrompt(
    result,
    checklist,
    improvementRound,
    ctx.cwd,
  );
  ctx.ui.notify(
    `loop-agent: 실패 항목 개선 ${improvementRound}/${workflowConfig.maxImprovementRounds}차를 준비합니다.`,
    "warning",
  );
  return { status: "scheduled", codingPrompt };
}

/** 코드 실행과 독립 검수를 종료 코드까지 확인하며 순차 반복하는 워크플로 본체다. */
async function runExecutionReviewLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowId: string,
  initialCodingPrompt?: string,
  execution: LoopAgentExecutionRuntime = defaultExecutionRuntime,
): Promise<void> {
  const workflowState = execution.state;
  if (!workflowState.checklist || !isCurrentWorkflowTransition(workflowState, workflowId)) return;
  if (workflowState.processingWorkflowId) {
    ctx.ui.notify(
      "loop-agent: 이미 코드 실행 또는 검수가 진행 중입니다.",
      "warning",
    );
    return;
  }

  workflowState.processingWorkflowId = workflowId;
  let codingPrompt = initialCodingPrompt;

  try {
    while (
      isCurrentWorkflowTransition(workflowState, workflowId) &&
      workflowState.checklist
    ) {
      const checklist = workflowState.checklist;
      const codingStatus = await runCodingStage(
        pi,
        ctx,
        workflowId,
        checklist,
        codingPrompt,
        execution,
      );
      if (codingStatus === "stale") return;

      const testing = await runTestingStage(
        pi,
        ctx,
        workflowId,
        checklist,
        execution,
      );
      if (testing.status === "stale") return;
      if (!testing.testResult || testing.testResult.overall !== "PASS") {
        const recovery = await recoverFromTestFailure(
          pi,
          ctx,
          workflowId,
          testing.testReport,
          testing.testResult,
          execution,
        );
        if (recovery.status === "stale" || recovery.status === "stopped") return;
        codingPrompt = recovery.codingPrompt;
        continue;
      }

      if (!workflowState.autoReview) {
        completeWithoutReview(pi, ctx, execution);
        return;
      }

      const review = await runReviewStage(
        pi,
        ctx,
        workflowId,
        checklist,
        testing.testReport,
        testing.testResult,
        execution,
      );
      if (review.status !== "scheduled") return;
      codingPrompt = review.codingPrompt;
    }
  } catch (error) {
    if (!isCurrentWorkflowTransition(workflowState, workflowId)) return;
    failWorkflow(workflowState);
    persistWorkflowState(pi, "execution-failed", workflowState);
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`loop-agent: ${message}`, "error");
  } finally {
    if (workflowState.processingWorkflowId === workflowId) {
      workflowState.processingWorkflowId = null;
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
    `- autoReview: ${state.autoReview}`,
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
      releaseWorkflowTransition(state);
      // 상태만 리셋하면 이미 spawn된 자식 에이전트는 보이지 않는 채 계속
      // 실행되므로(부하), clear는 자식 프로세스까지 함께 회수해야 한다.
      processRuntime.killActiveChildren();
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
    await ensureIssueStore(ctx);
    const freshSession = isFreshSessionStart(event);
    state.armed = state.enabled && freshSession;

    if (freshSession) {
      // 확장 모듈은 프로세스 동안 유지될 수 있으므로 새 세션에서 이전 작업의
      // 체크리스트와 검수 상태가 유출되지 않게 명시적으로 초기화한다.
      // state만 리셋하면 이전 워크플로의 자식 에이전트가 고아로 남아 보이지
      // 않는 부하가 되므로(가드 isCurrentWorkflow가 결과만 버림), 먼저 회수한다.
      const killed = processRuntime.killActiveChildren();
      if (killed > 0) {
        ctx.ui.notify(
          `loop-agent: 이전 워크플로의 자식 에이전트 ${killed}개를 종료했습니다.`,
          "warning",
        );
      }
      resetForFreshSession(state);
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
          state.reviewStage === "testing" ||
          state.reviewStage === "diagnosing" ||
          state.reviewStage === "reviewing")
      ) {
        // 중단 지점에서 코드를 무조건 재실행하면 이미 반영된 변경을 중복 적용할
        // 수 있으므로 먼저 현재 파일 상태를 검수하고 부족한 항목만 개선한다.
        // session_start 핸들러를 워크플로 종료까지 붙들지 않도록 분리 실행한다.
        startExecutionReviewLoop(pi, ctx, state.workflowId);
      }
    }

    if (state.armed) {
      ctx.ui.notify(
        "loop-agent: 다음 첫 메시지를 계획 파이프라인(grill-with-docs → to-prd → to-issues → grill-checklist)으로 확장합니다.",
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
        state.reviewStage === "testing" ||
        state.reviewStage === "diagnosing" ||
        state.reviewStage === "reviewing")
    ) {
      ctx.ui.notify(
        "loop-agent: 컴팩션 이후 진행 중이던 워크플로를 이어서 실행합니다.",
        "info",
      );
      startExecutionReviewLoop(pi, ctx, state.workflowId);
    }
  });

  // 계획 모듈의 검색·전제·예약·모델 선택 결과를 세션 컨트롤러에 연결한다.
  // 실제 입력 주입(sendUserMessage vs input transform)은 이 컨트롤러가 맡는다.
  async function prepareGoalPipeline(
    ctx: ExtensionContext,
    objective: string,
    { explicit = true, autoReview = true }: { explicit?: boolean; autoReview?: boolean } = {},
  ): Promise<GoalPipelinePreparation> {
    return preparePlanningPipeline(
      pi,
      ctx,
      objective,
      { explicit, autoReview },
      {
        ensureWorkflowWorkspace,
        findMissingPipelinePrerequisite: () =>
          findPlanningPrerequisite(skillPath, [
            "grill-with-docs",
            "to-prd",
            "to-issues",
            SKILL_NAME,
          ]),
        reserveWorkflow,
        runRequiredSemanticSearch: (searchCtx, searchObjective) =>
          runPlanningSemanticSearch(
            searchCtx,
            searchObjective,
            planningSearchDependencies,
          ),
        isCurrentWorkflow,
        persistWorkflowState,
        releaseWorkflowIfCurrent,
        selectModel,
        workflowConfig: config,
        buildPlanningPipelinePrompt: (
          promptObjective,
          workflowId,
          root,
          semanticContext,
        ) =>
          buildPlanningPrompt(
            promptObjective,
            workflowId,
            root,
            semanticContext,
            { skillPath, buildArchitectureReadGuidance },
          ),
      },
      { skillPath, buildArchitectureReadGuidance },
    );
  }

  async function startQuickWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    objective: string,
    explicit: boolean,
    autoReview = true,
  ): Promise<boolean> {
    if (!ensureWorkflowWorkspace(ctx, explicit)) return false;

    const checklist = buildPlanningQuickChecklist(objective, shortenStatusLine);
    // 직접/소규모 작업도 계획 파이프라인과 동일하게 SQLite 이슈 검색과
    // ADR/CONTEXT 검색을 통과해야 한다. 검색 결과는 코드 에이전트 프롬프트에
    // 직접 주입하고, 실패하면 업무를 시작하지 않는다.
    const workflowId = reserveWorkflow(autoReview, "awaiting-execution", checklist);
    const semanticContext = await runPlanningSemanticSearch(
      ctx,
      objective,
      planningSearchDependencies,
    );
    if (!semanticContext) {
      releaseWorkflowIfCurrent(piApi, workflowId, "quick-goal-search-failed");
      return false;
    }
    if (!isCurrentWorkflow(workflowId)) return false;

    const { prompt } = buildPlanningDirectCodingPrompt(
      objective,
      ctx.cwd,
      {
        skillPath,
        buildArchitectureReadGuidance,
        buildImplementSkillGuidance,
        buildTaskTrackingInstructions,
        shortenStatusLine,
      },
      semanticContext,
    );

    persistWorkflowState(piApi, "quick-goal-started");

    const modelSelected = await selectModel(
      piApi,
      ctx,
      config.codingModel,
      config.codingThinkingLevel,
      "코드",
    );
    if (!modelSelected) {
      releaseWorkflowIfCurrent(piApi, workflowId, "quick-goal-model-failed");
      return false;
    }
    if (!isCurrentWorkflow(workflowId)) return false;

    ctx.ui.notify(
      "loop-agent: 작은 작업을 직접 실행합니다. 계획/인터뷰 없이 코드 에이전트를 시작합니다.",
      "info",
    );
    startExecutionReviewLoop(piApi, ctx, workflowId, prompt);
    return true;
  }

  // /hard-goal 명령용: 개별 메시지로 계획 프롬프트를 주입한다.
  async function startGoalWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    objective: string,
    autoReview = true,
  ): Promise<void> {
    const preparation = await prepareGoalPipeline(ctx, objective, { autoReview });
    if (preparation && "prompt" in preparation) {
      piApi.sendUserMessage(preparation.prompt);
    }
  }

  // 첫 메시지 자동 진입과 /easy-goal 명령은 항상 계획·grilling 파이프라인을
  // 공유한다. 명시적 명령은 sendUserMessage로 새 턴을 시작하고, 첫 메시지
  // 입력 핸들러는 prompt 텍스트를 반환해 원문을 치환한다.
  async function resolveEasyGoalWorkflow(
    ctx: ExtensionContext,
    rawObjective: string,
    explicit: boolean,
  ): Promise<{ handled: boolean; prompt?: string }> {
    const mode = parseGoalMode(rawObjective);
    const objective = mode?.objective ?? rawObjective;

    const preparation = await prepareGoalPipeline(ctx, objective, {
      explicit,
      autoReview: false,
    });
    if (!preparation) return { handled: false };
    if ("blocked" in preparation) return { handled: true };
    return { handled: true, prompt: preparation.prompt };
  }

  async function startEasyGoalWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    rawObjective: string,
    explicit: boolean,
  ): Promise<boolean> {
    const result = await resolveEasyGoalWorkflow(ctx, rawObjective, explicit);
    if (!result.prompt) return result.handled;
    piApi.sendUserMessage(result.prompt);
    return true;
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

    // 첫 메시지도 /easy-goal과 같은 스타터를 공유한다. 바쁨/이미 진행 중/전제
    // 파일 누락은 원본을 통과시키지만, 필수 semantic search 실패는 삼킨다.
    const result = await resolveEasyGoalWorkflow(ctx, text, false);
    if (!result.handled) {
      return { action: "continue" };
    }
    if (result.prompt) {
      return { action: "transform", text: result.prompt };
    }
    return { action: "handled" };
  });

  pi.on("agent_end", async (event, ctx) => {
    // 출력 토큰 한도로 잘린 턴(stopReason="length")은 pi 코어가 자동으로
    // 이어가지 않는다(tool call이 없는 정상 종료로 취급되어 루프가 끝난다).
    // 사용자가 수동으로 "진행해"를 치던 것을 대신해, run이 idle이 되면 후속
    // 입력을 보내 중단 지점에서 이어가게 한다. 자동 계획/구현뿐 아니라 일반
    // 대화 턴에서도 동일하게 동작하도록 다른 분기보다 먼저 처리한다.
    const stopReason = getLastAssistantStopReason(event);
    if (stopReason === "length") {
      if (state.lengthContinueCount >= MAX_LENGTH_CONTINUES) {
        // 카운터를 리셋하지 않는다. 리셋하면 다음 length 정지에서 곧바로 새
        // 재개 사이클이 시작돼 상한이 사실상 무력화된다. 정상 종료(아래 분기)를
        // 볼 때에만 0으로 되돌려, 실제 진전이 있을 때만 재개를 다시 허용한다.
        ctx.ui.notify(
          `loop-agent: 출력 한도로 인한 자동 이어가기가 상한(${MAX_LENGTH_CONTINUES}회)에 도달해 멈춥니다. 필요하면 직접 이어서 진행하세요.`,
          "warning",
        );
        return;
      }
      state.lengthContinueCount += 1;
      ctx.ui.notify(
        `loop-agent: 응답이 출력 한도로 잘려 중단 지점에서 자동으로 이어갑니다 (${state.lengthContinueCount}/${MAX_LENGTH_CONTINUES}).`,
        "info",
      );
      scheduleLengthContinue(pi, ctx);
      return;
    }
    // 정상적으로 끝난 턴을 보면 재개 카운터를 초기화한다.
    state.lengthContinueCount = 0;

    const planningResponse = getLastAssistantText(event);
    const responseWorkflowId = extractWorkflowId(planningResponse);
    const latestChecklist = extractChecklist(planningResponse);
    let currentWorkflowId = state.workflowId;
    let recoveredFromStaleWorkflow = false;

    // workflow 마커가 있다는 것은 최종 계획 응답을 뜻하므로 체크리스트가
    // 누락된 경우에도 먼저 세대 검사를 적용한다. 오래된 최종 응답이 현재
    // 목표를 실패 상태로 덮어쓰면 안 된다.
    if (responseWorkflowId && responseWorkflowId !== currentWorkflowId) {
      pi.appendEntry("loop-agent-workflow-rejected", {
        reason: "stale-checklist",
        responseWorkflowId,
        currentWorkflowId,
      });
      if (currentWorkflowId) {
        ctx.ui.notify(
          [
            "loop-agent: 이전 목표의 계획 응답이 늦게 도착해 실행하지 않습니다.",
            `이전 응답 ID: ${responseWorkflowId}`,
            `현재 진행 중인 목표 ID: ${currentWorkflowId}`,
            "현재 목표의 loop는 중단하지 않고 계속 진행합니다.",
          ].join("\n"),
          "warning",
        );
        return;
      }

      currentWorkflowId = recoverStalePlanningWorkflow(
        pi,
        ctx,
        responseWorkflowId,
        latestChecklist,
      );
      recoveredFromStaleWorkflow = true;
      ctx.ui.notify(
        [
          "loop-agent: 이전 계획 응답이 취소된 목표 ID로 돌아왔지만 현재 실행 중인 목표는 없습니다.",
          `이전 응답 ID: ${responseWorkflowId}`,
          `새로 연결한 목표 ID: ${currentWorkflowId}`,
          latestChecklist
            ? "이전 체크리스트를 새 목표에 연결해 loop를 계속 실행합니다."
            : "체크리스트가 없어 planningModel에 새 계획 응답을 요청하고 loop를 계속합니다.",
        ].join("\n"),
        "warning",
      );
    }

    if (recoveredFromStaleWorkflow && !latestChecklist) {
      const recoveryPrompt = [
        "이전 계획 응답이 취소된 workflow ID를 사용해 실행되지 않았습니다.",
        `새 workflow ID는 ${currentWorkflowId}입니다.`,
        "이전 응답의 요구사항과 인터뷰 맥락은 유지하되, 새 workflow ID를 사용해 계획을 이어가세요.",
        `최종 체크리스트 바로 앞에 ${WORKFLOW_MARKER_PREFIX}${currentWorkflowId} --> 주석을 출력하고, grill-checklist 경계 안에 체크리스트를 반드시 작성하세요.`,
        "",
        planningResponse,
      ].join("\n");
      pi.sendUserMessage(recoveryPrompt);
      return;
    }

    if (latestChecklist) {
      if (state.autoMode && !responseWorkflowId) {
        ctx.ui.notify(
          "loop-agent: 자동 목표 체크리스트에 워크플로 ID가 없어 실행을 중단합니다.",
          "error",
        );
        failWorkflow(state);
        persistWorkflowState(pi, "workflow-marker-missing");
        return;
      }

      // 이 agent_end는 명세, 구현 계획, 체크리스트를 만든 그릴링 종료 턴이다.
      // 자동 모드는 즉시 별도 코드 프로세스를 실행하고 일반 모드는 승인을 기다린다.
      state.checklist = latestChecklist;
      markAwaitingExecution(state);
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
        // /hard-goal, /easy-goal 작업은 사용자 승인을 다시 기다리지 않는다. 확장이 별도 코드
        // 프로세스의 종료 코드를 직접 기다리므로 실행 실패도 상태에 반영된다.
        const executionPlanningResponse =
          responseWorkflowId && currentWorkflowId !== responseWorkflowId
            ? planningResponse.replace(
                WORKFLOW_MARKER_PREFIX + responseWorkflowId + " -->",
                WORKFLOW_MARKER_PREFIX + currentWorkflowId + " -->",
              )
            : planningResponse;
        const codingPrompt = [
          "자동 실행 모드입니다. 아래 확정 명세와 구현 계획을 즉시 실행하세요.",
          "목표 체크리스트를 모두 만족하도록 코드를 수정하고 필요한 테스트를 실행하세요.",
          "작업을 중간에 멈추거나 사용자 승인을 다시 요청하지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
          "",
          buildImplementSkillGuidance(ctx.cwd),
          "",
          buildTaskTrackingInstructions(ctx.cwd),
          "",
          executionPlanningResponse,
        ].join("\n");
        ctx.ui.notify(
          "loop-agent: 계획과 체크리스트가 확정되어 코드 에이전트를 자동 실행합니다.",
          "info",
        );
        // agent_end 안에서 await하면 isStreaming이 워크플로 종료까지 풀리지
        // 않아 진행 메시지가 전부 steer 큐로 사라진다. 분리 실행이 필수다.
        startExecutionReviewLoop(pi, ctx, workflowId, codingPrompt);
        return;
      }

      ctx.ui.notify(
        "loop-agent: 목표 체크리스트를 저장했습니다. 다음 실행 완료 후 독립 검수를 시작합니다.",
        "info",
      );
      return;
    }

    if (shouldWaitForPlanningInterview(state.autoMode, responseWorkflowId)) {
      // 계획 프롬프트는 요구사항 인터뷰 중 질문만 출력하는 턴을 허용한다.
      // workflow 마커가 없는 응답은 아직 최종 계획이 아니므로 자동 모드를
      // 실패시키지 않고 다음 사용자 답변을 기다린다.
      return;
    }

      if (state.autoMode) {
        failWorkflow(state);
      persistWorkflowState(pi, "checklist-marker-missing");
      ctx.ui.notify(
        "loop-agent: 구현계획 응답에서 grill-checklist 경계를 찾지 못해 자동 실행을 중단했습니다. 계획 모델이 지정된 체크리스트 경계를 출력했는지 확인하세요.",
        "error",
      );
      return;
    }

    if (state.reviewStage !== "awaiting-execution" || !state.checklist) return;
    if (ctx.hasPendingMessages()) return;

    const workflowId = state.workflowId;
    if (!workflowId) return;
    startExecutionReviewLoop(pi, ctx, workflowId);
  });

  pi.registerCommand("hard-goal", {
    description:
      "Start a semi-automated loop-agent workflow with independent review repetition. Usage: /hard-goal [plan|direct] <objective>",
    handler: async (args, ctx) => {
      const rawObjective = normalizeArgs(args);
      if (!rawObjective) {
        ctx.ui.notify("Usage: /hard-goal <objective>", "warning");
        return;
      }

      const mode = parseGoalMode(rawObjective);
      const objective = mode?.objective ?? rawObjective;

      if (mode?.mode === "direct") {
        await startQuickWorkflow(pi, ctx, objective, true);
        return;
      }

      if (!mode && isLikelyQuickTask(objective)) {
        const started = await startQuickWorkflow(pi, ctx, objective, false);
        if (started) return;
      }

      await startGoalWorkflow(pi, ctx, objective);
    },
  });

  pi.registerCommand("easy-goal", {
    description:
      "Start a semi-automated grilling workflow that stops after testing and skips independent review repetition. Usage: /easy-goal [plan] <objective>",
    handler: async (args, ctx) => {
      const rawObjective = normalizeArgs(args);
      if (!rawObjective) {
        ctx.ui.notify("Usage: /easy-goal <objective>", "warning");
        return;
      }

      await startEasyGoalWorkflow(pi, ctx, rawObjective, true);
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
        config = loadWorkflowConfig(CONFIG_PATH);
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
        config = loadWorkflowConfig(CONFIG_PATH);
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
        config = loadWorkflowConfig(CONFIG_PATH);
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
        startExecutionReviewLoop(pi, ctx, state.workflowId);
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
