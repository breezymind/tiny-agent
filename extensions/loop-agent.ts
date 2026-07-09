import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
const TEST_RESULT_START = "<!-- loop-agent-test-result:start -->";
const TEST_RESULT_END = "<!-- loop-agent-test-result:end -->";
const PARALLEL_TASKS_START = "<!-- loop-agent-parallel-tasks:start -->";
const PARALLEL_TASKS_END = "<!-- loop-agent-parallel-tasks:end -->";
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const CODING_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_FORMAT_RETRIES = 2;
const MAX_PARALLEL_CODING_TASKS = 4;
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

// to-prd/to-issues는 이 문서의 규약에 따라 이슈를 발행한다. 이 문서와 아래
// 태스크 트리는 "실행 중인 프로젝트"에 속하므로 에이전트 설치 폴더가 아니라
// 프로젝트 루트(에이전트의 cwd) 기준으로 계산한다. 그래야 ~/Workspace/tetris
// 처럼 임의의 프로젝트에서 pi를 실행해도 그 프로젝트의 문서를 본다.
// 프로젝트별 문서/태스크 경로 묶음. root는 에이전트 실행 cwd(ctx.cwd)다.
type ProjectDocPaths = {
  issueTracker: string;
  tasksBacklog: string;
  tasksCurrent: string;
  tasksArchiveDir: string;
  changesDir: string;
};
function projectDocPaths(root: string): ProjectDocPaths {
  const docs = path.join(root, "docs");
  return {
    issueTracker: path.join(docs, "agents", "issue-tracker.md"),
    tasksBacklog: path.join(docs, "tasks", "backlog.md"),
    tasksCurrent: path.join(docs, "tasks", "current.md"),
    tasksArchiveDir: path.join(docs, "tasks", "archive"),
    changesDir: path.join(docs, "changes"),
  };
}

// 새 프로젝트에는 docs 트리가 없다. 파이프라인이 요구하는 이슈 트래커 규약
// 문서와 태스크 파일 트리를 프로젝트 루트에 자동 생성해, 빈 저장소에서도
// /hard-goal·첫 메시지 파이프라인이 곧바로 성립하게 한다. 템플릿 원본은 코드에
// 인라인하지 않고 에이전트 설치 폴더의 templates/docs/ 아래 실제 파일로 두어
// (스킬 본문을 파일로 주입하는 기존 관례와 동일) 콘텐츠와 코드를 분리한다.
// 이 원본은 buildTaskTrackingInstructions가 강제하는 마커(## Backlog/
// ## In progress/## Done, T-###, **Status:**)와 to-prd/to-issues 스킬의 이슈
// 블록 형식에 정확히 일치해야 한다. 어긋나면 코딩 에이전트가 상태 파일을
// 옮기지 못한다.
const DOC_TEMPLATE_DIR = path.join(path.dirname(CONFIG_PATH), "templates", "docs");

// 템플릿 원본(설치 폴더) → 프로젝트 대상 경로 매핑. archive/changes 디렉터리는
// 코딩 에이전트가 완료·변경 시점에 월별 파일을 직접 만들므로 파일이 아닌 빈
// 디렉터리만 확보한다.
function docTemplateFiles(root: string): Array<[string, string]> {
  const docs = projectDocPaths(root);
  return [
    [path.join(DOC_TEMPLATE_DIR, "agents", "issue-tracker.md"), docs.issueTracker],
    [path.join(DOC_TEMPLATE_DIR, "tasks", "backlog.md"), docs.tasksBacklog],
    [path.join(DOC_TEMPLATE_DIR, "tasks", "current.md"), docs.tasksCurrent],
  ];
}

// 프로젝트에 문서 트리가 없으면 설치 폴더의 원본 템플릿을 복사해 생성한다.
// 이미 있는 파일은 사용자 내용을 덮어쓰지 않도록 건너뛴다. 생성한 대상 경로
// 목록을 돌려주어(빈 배열이면 이미 완비) 호출자가 사용자에게 알릴 수 있게 한다.
// 원본 템플릿 파일이 없으면 파이프라인 전제 자체를 세울 수 없으므로 예외를
// 그대로 전파한다(상위에서 잡아 안내).
function ensureProjectDocs(root: string): string[] {
  const created: string[] = [];
  for (const [source, target] of docTemplateFiles(root)) {
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    created.push(target);
  }
  const docs = projectDocPaths(root);
  for (const dir of [docs.tasksArchiveDir, docs.changesDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return created;
}

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
function buildTaskTrackingInstructions(root: string): string {
  const month = currentYearMonth();
  const docs = projectDocPaths(root);
  return [
    "<task-tracking>",
    `이 프로젝트의 이슈 트래커는 로컬 파일 트리다. 규약은 ${docs.issueTracker} 참조.`,
    "작업 시작·진행·완료에 따라 아래 파일을 반드시 직접 수정하라(edit/write). 외부 트래커를 찾지 말라.",
    "",
    `1) 착수: 이번에 구현할 큰 태스크(T-###) 블록을 ${docs.tasksBacklog}의 ## Backlog에서 잘라내`,
    `   ${docs.tasksCurrent}의 ## In progress로 옮기고 **Status:**를 in-progress로 바꿔라. 해당 태스크가`,
    "   backlog에 아직 없다면(즉석 목표) current.md에 새 T-### 블록을 만들어 추가하라.",
    `2) 완료: 모든 수용 기준을 만족하면 current.md의 해당 T-### 블록을 잘라내`,
    `   ${path.join(docs.tasksArchiveDir, `${month}.md`)}의 ## Done으로 옮기고 **Status:**를 done으로 바꿔라.`,
    "   블록 내용을 지우지 말고 이동만 하라(감사 추적). 아카이브 파일이 없으면 새로 생성하라.",
    `3) 사소한 변경: 큰 태스크가 아닌 부수 변경(오타·문구·리팩터·설정 등)은`,
    `   ${path.join(docs.changesDir, `${month}.md`)}에 "- ${month}-DD: 요약 (관련 T-### 있으면 참조)" 형태로 append하라.`,
    "</task-tracking>",
  ].join("\n");
}

function buildQuickChecklist(objective: string): string {
  const summary = shortenStatusLine(objective, 120);
  return [
    "## 목표 결과 체크리스트",
    `- [ ] 요청 "${summary}" 를 최소 변경으로 구현했다.`,
    "- [ ] 관련 검증(테스트, 빌드, 정적 검사) 중 필요한 것을 실행했다.",
    "- [ ] 기존의 직접 연관된 동작을 불필요하게 바꾸지 않았다.",
  ].join("\n");
}

function buildDirectCodingPrompt(objective: string, root: string): {
  checklist: string;
  prompt: string;
} {
  const checklist = buildQuickChecklist(objective);
  const prompt = [
    "작은 단일 작업이다. 인터뷰, PRD, 이슈 분해 없이 바로 구현하라.",
    "최소 변경으로 요청을 충족하고, 끝나면 변경 내용과 검증 근거를 간단히 보고하라.",
    "",
    "다음 체크리스트를 만족하도록 작업하라:",
    checklist,
    "",
    buildImplementSkillGuidance(),
    "",
    buildTaskTrackingInstructions(root),
    "",
    "작업 요청:",
    objective,
  ].join("\n");

  return { checklist, prompt };
}

function sectionBody(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `## ${escaped}\\n([\\s\\S]*?)(?=\\n## [^\\n]+\\n|$)`,
    "i",
  );
  return markdown.match(pattern)?.[1]?.trim() ?? "";
}

function extractTaskIdsFromSection(markdown: string, heading: string): string[] {
  const body = sectionBody(markdown, heading);
  return Array.from(body.matchAll(/-\s*(T-\d{3})\b/g)).map((match) => match[1]);
}

function parseTaskBlocksFromFile(filePath: string): TaskBlock[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const headerPattern =
    /^###\s+(T-\d{3})\s+(?:\[([^\]]+)\]\s+)?(.+?)\s*$/gm;
  const headers = Array.from(text.matchAll(headerPattern));
  const tasks: TaskBlock[] = [];

  for (let index = 0; index < headers.length; index += 1) {
    const match = headers[index];
    const start = match.index ?? 0;
    const end = headers[index + 1]?.index ?? text.length;
    const raw = text.slice(start, end).trim();
    const statusMatch = raw.match(/\*\*Status:\*\*\s*(backlog|in-progress|done)\b/i);
    tasks.push({
      id: match[1],
      label: match[2] ?? null,
      title: match[3].trim(),
      status: (statusMatch?.[1]?.toLowerCase() as TaskBlock["status"]) ?? null,
      parentIds: extractTaskIdsFromSection(raw, "Parent"),
      blockedByIds: extractTaskIdsFromSection(raw, "Blocked by"),
      raw,
      sourcePath: filePath,
    });
  }

  return tasks;
}

function loadCandidateTasks(root: string): TaskBlock[] {
  const docs = projectDocPaths(root);
  return [
    ...parseTaskBlocksFromFile(docs.tasksBacklog),
    ...parseTaskBlocksFromFile(docs.tasksCurrent),
  ];
}

function extractParallelTaskIds(text: string): string[] {
  const start = text.indexOf(PARALLEL_TASKS_START);
  const end = text.indexOf(PARALLEL_TASKS_END, start + PARALLEL_TASKS_START.length);
  if (start < 0 || end < 0) return [];
  return Array.from(
    text
      .slice(start + PARALLEL_TASKS_START.length, end)
      .matchAll(/\bT-\d{3}\b/g),
  ).map((match) => match[0]);
}

function chooseParallelCodingTasks(root: string, planningResponse: string): TaskBlock[] {
  const allTasks = loadCandidateTasks(root);
  const preferredIds = new Set(extractParallelTaskIds(planningResponse));
  if (preferredIds.size === 0) return [];
  const preferredTasks = allTasks.filter((task) => preferredIds.has(task.id));

  const eligible = preferredTasks.filter(
    (task) =>
      task.label === "ready-for-agent" &&
      task.status !== "done" &&
      task.blockedByIds.length === 0,
  );
  if (eligible.length < 2) return [];

  const grouped = new Map<string, TaskBlock[]>();
  for (const task of eligible) {
    const parentKey = task.parentIds[0] ?? `__self__:${task.id}`;
    const bucket = grouped.get(parentKey) ?? [];
    bucket.push(task);
    grouped.set(parentKey, bucket);
  }

  const bestGroup = Array.from(grouped.values())
    .filter((tasks) => tasks.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (!bestGroup) return [];

  return bestGroup.slice(0, MAX_PARALLEL_CODING_TASKS);
}

function buildParallelTaskCodingPrompt(
  task: TaskBlock,
  checklist: string,
  root: string,
): string {
  return [
    "당신은 병렬 코딩 단계의 서브태스크 전용 구현 에이전트다.",
    "아래 T-### 블록 하나만 책임지고 구현하라. 다른 서브태스크까지 확장하지 말라.",
    "다른 병렬 에이전트와 충돌을 줄이기 위해 docs/tasks/* 파일, CONTEXT.md, ADR 문서는 수정하지 말라.",
    "현재 작업 디렉터리는 임시 분기용 스냅샷이다. 이 스냅샷 안에서 필요한 코드만 수정하라.",
    `실제 수정 대상 루트: ${root}`,
    "가능하면 이 서브태스크와 직접 관련된 파일만 건드리고, 완료 후 변경 내용과 실행한 검증만 간단히 보고하라.",
    "",
    buildImplementSkillGuidance(),
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
    "이제 남은 일만 처리하라: 교차 서브태스크 seam 정리, 누락된 최소 통합 수정, 그리고 태스크 추적 문서 갱신.",
    "이미 병합된 큰 구현을 다시 처음부터 뒤엎지 말고, 현재 워크트리를 직접 읽어 최소 보완만 하라.",
    "",
    buildImplementSkillGuidance(),
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
  explicit: boolean,
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

  try {
    const created = ensureProjectDocs(ctx.cwd);
    if (created.length > 0) {
      ctx.ui.notify(
        `loop-agent: 이 프로젝트에 이슈 트래커 문서를 생성했습니다 (${created.length}개): ${created.join(", ")}`,
        "info",
      );
    }
  } catch (error) {
    if (explicit) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `loop-agent: 이슈 트래커 문서를 생성하지 못했습니다: ${message}`,
        "error",
      );
    }
    return false;
  }

  return true;
}

// 구현 단계에서 따를 스킬: implement(구현 절차) + tdd(red-green-refactor 규율).
// 자식 프로세스는 --no-skills로 실행되므로, 본문을 직접 붙이지 말고 파일 경로만
// 알려준 뒤 read 도구로 읽게 한다.
const IMPLEMENT_PIPELINE_SKILLS = ["implement", "tdd"] as const;

function buildImplementSkillGuidance(): string {
  const skillFiles = IMPLEMENT_PIPELINE_SKILLS.map((skillName) =>
    skillPath(skillName),
  );

  return [
    "<implement-adapter>",
    "아래 스킬 파일을 먼저 직접 읽고 절차를 따르라. 본문을 프롬프트에 재인용하지 말라:",
    ...skillFiles.map((filePath) => `- ${filePath}`),
    "이 자동 파이프라인에서는 `/tdd`, `/code-review` 슬래시 호출을 스스로 하지 말라.",
    "직접 git 커밋/푸시는 하지 말고, 태스크 상태는 위 <task-tracking> 지침만 따르라.",
    "테스트 실행은 가능하지만, 최종 판정은 별도 테스트·검수 에이전트가 다시 확인한다.",
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

type FailedCommand = {
  command: string;
  reason: string;
  evidence: string;
};

type TestResult = {
  overall: "PASS" | "FAIL";
  failedCommands: FailedCommand[];
};

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
  // /hard-goal, /easy-goal로 시작한 작업만 체크리스트 생성 직후 구현까지 자동 진행한다.
  // 일반 대화는 기존처럼 사용자의 구현 승인을 기다린다.
  autoMode: boolean;
  // true면 테스트 뒤 독립 검수/개선 루프까지 이어가고, false면 테스트까지만 자동 실행한다.
  autoReview: boolean;
  // 비동기 코드 실행과 검수 결과가 다른 목표의 상태를 덮어쓰지 않도록 각
  // 워크플로에 고유 ID를 부여한다. processingWorkflowId는 중복 agent_end 진입을 막는다.
  workflowId: string | null;
  processingWorkflowId: string | null;
  // 출력 토큰 한도(stopReason="length")로 잘린 턴을 자동으로 이어서 진행한
  // 횟수. pi 코어는 length 정지 시 tool call이 없으면 continue 없이 루프를
  // 끝내므로(auto-compaction 여부와 무관), 확장이 후속 입력을 큐잉해 재개한다.
  // 무한 재개를 막기 위해 상한을 두며, length가 아닌 정상 종료를 보면 0으로 되돌린다.
  lengthContinueCount: number;
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

type StreamingRunResult = {
  code: number;
  // 자식이 --mode json으로 스트리밍한 이벤트에서 뽑아낸 최종 어시스턴트 텍스트.
  // 과거 text 모드의 stdout(최종 응답)과 동일한 의미를 갖는다.
  finalText: string;
  stderr: string;
};

function formatProgressMessage(
  label: string,
  stream: "stdout" | "stderr" | "heartbeat",
  transcript: string[],
  details?: string,
): string {
  const lines = [
    `## ${label} 진행 로그`,
    "",
    `- 최신 상태: ${stream}`,
    `- 누적 로그: ${transcript.length}줄`,
  ];

  if (details) {
    lines.push(`- 상세: ${details}`);
  }

  lines.push("", transcript.slice(-8).join("\n") || "(아직 출력 없음)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 자식 pi(--mode json)의 NDJSON 이벤트 파싱
//
// text 모드는 실행이 끝난 뒤 최종 어시스턴트 텍스트만 한 번 stdout에 쓴다
// (pi 코어 modes/print-mode.js). 그래서 부모가 stdout을 아무리 실시간으로
// 파이프해도 진행 중에는 보여줄 게 없었다. json 모드는 session.subscribe의
// 모든 이벤트를 한 줄에 하나씩 JSON으로 흘려보내므로, 이를 파싱하면 자식
// 에이전트의 도구 호출·결과·어시스턴트 텍스트를 실시간으로 중계할 수 있다.
// 이벤트 스키마는 pi-agent-core의 AgentEvent와 pi-ai의 AssistantMessageEvent다.
// ---------------------------------------------------------------------------

type JsonTextContent = { type?: string; text?: string };
type JsonAssistantMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: string | JsonTextContent[];
};

/** 어시스턴트 메시지 content(문자열 또는 블록 배열)에서 text만 이어붙인다. */
function joinAssistantText(message: JsonAssistantMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is JsonTextContent =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

/** agent_end 이벤트의 messages 배열에서 마지막 어시스턴트 텍스트를 뽑는다. */
function extractFinalTextFromMessages(
  messages: JsonAssistantMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return joinAssistantText(message).trim();
  }
  return "";
}

/** 도구 인자 객체에서 표시에 쓸 대표 필드만 골라 한 줄로 축약한다. */
function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return shortenStatusLine(args, 60);
  if (typeof args !== "object") return shortenStatusLine(String(args), 60);

  const record = args as Record<string, unknown>;
  // 자주 쓰는 도구 인자의 핵심 필드를 우선 노출한다.
  const preferred = [
    "command",
    "path",
    "file_path",
    "filePath",
    "pattern",
    "query",
    "url",
    "cmd",
  ];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return shortenStatusLine(value, 60);
    }
  }
  try {
    return shortenStatusLine(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

/** 도구 결과(AgentToolResult 또는 임의 값)에서 표시용 텍스트를 축약한다. */
function summarizeToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return shortenStatusLine(result, 60);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is JsonTextContent =>
            (part as JsonTextContent)?.type === "text" &&
            typeof (part as JsonTextContent).text === "string",
        )
        .map((part) => part.text as string)
        .join(" ");
      if (text.trim()) return shortenStatusLine(text, 60);
    }
    try {
      return shortenStatusLine(JSON.stringify(result), 60);
    } catch {
      return "";
    }
  }
  return shortenStatusLine(String(result), 60);
}

type ParsedEventLine = {
  // progressTranscript에 남길 사람이 읽는 로그 라인(없으면 로그 미기록).
  log?: string;
  // 상태줄에 표시할 최신 활동(없으면 상태줄 유지).
  status?: string;
};

// 하나의 자식 실행 동안 누적되는 이벤트 파싱 상태.
type EventParseState = {
  finalText: string;
  // 도구 호출 ID → 도구명. end 이벤트에서 toolName이 없을 때 대비한 매핑.
  toolNames: Map<string, string>;
  // 어시스턴트 텍스트 델타 누적(로그가 아닌 상태줄 표시에 사용).
  assistantBuffer: string;
  // assistant 에러(stopReason error/aborted 또는 error 이벤트)를 감지했는지.
  errorMessage: string | null;
};

/**
 * NDJSON 한 줄(이미 JSON.parse된 이벤트)을 표시용 라인으로 변환하고,
 * 최종 텍스트/에러 등 파싱 상태를 갱신한다.
 */
function handleJsonEvent(
  event: Record<string, unknown>,
  parse: EventParseState,
): ParsedEventLine {
  const type = typeof event.type === "string" ? event.type : "";

  switch (type) {
    case "tool_execution_start": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (toolCallId) parse.toolNames.set(toolCallId, toolName);
      const argsSummary = summarizeToolArgs(event.args);
      const line = argsSummary
        ? `🔧 ${toolName}: ${argsSummary}`
        : `🔧 ${toolName}`;
      return { log: line, status: line };
    }
    case "tool_execution_update": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      const partial = summarizeToolResult(event.partialResult);
      if (!partial) return {};
      // 부분 출력은 소음이 많아 상태줄로만 흘리고 로그에는 남기지 않는다.
      return { status: `⏳ ${toolName}: ${partial}` };
    }
    case "tool_execution_end": {
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : "";
      const toolName =
        (typeof event.toolName === "string" && event.toolName) ||
        parse.toolNames.get(toolCallId) ||
        "tool";
      const isError = event.isError === true;
      const resultSummary = summarizeToolResult(event.result);
      const icon = isError ? "❌" : "✅";
      const line = resultSummary
        ? `${icon} ${toolName} → ${resultSummary}`
        : `${icon} ${toolName}`;
      return { log: line, status: line };
    }
    case "message_update": {
      const ame = event.assistantMessageEvent as
        | { type?: string; delta?: string; content?: string }
        | undefined;
      if (!ame || typeof ame.type !== "string") return {};
      if (ame.type === "text_delta" && typeof ame.delta === "string") {
        parse.assistantBuffer += ame.delta;
        // 델타는 상태줄로만 흘린다(토큰 단위라 로그로 남기면 폭발한다).
        return { status: `💬 ${shortenStatusLine(parse.assistantBuffer, 60)}` };
      }
      if (ame.type === "text_end" && typeof ame.content === "string") {
        parse.assistantBuffer = "";
        const text = ame.content.trim();
        if (!text) return {};
        // 문단 단위로만 로그에 요약을 남긴다.
        return { log: `💬 ${shortenStatusLine(text, 100)}` };
      }
      if (ame.type === "error") {
        const errMsg = (ame as { error?: JsonAssistantMessage }).error;
        const message = errMsg?.errorMessage || "요청 오류";
        parse.errorMessage = message;
        return { log: `⚠️ ${shortenStatusLine(message, 100)}` };
      }
      return {};
    }
    case "message_end":
    case "turn_end": {
      const message = (event.message ?? {}) as JsonAssistantMessage;
      if (message.role === "assistant") {
        const text = joinAssistantText(message).trim();
        if (text) parse.finalText = text;
        if (
          message.stopReason === "error" ||
          message.stopReason === "aborted"
        ) {
          parse.errorMessage =
            message.errorMessage || `요청이 ${message.stopReason} 상태로 종료됨`;
        }
      }
      return {};
    }
    case "agent_end": {
      const messages = Array.isArray(event.messages)
        ? (event.messages as JsonAssistantMessage[])
        : [];
      const text = extractFinalTextFromMessages(messages);
      if (text) parse.finalText = text;
      return {};
    }
    default:
      return {};
  }
}

// 자식은 항상 --mode json으로 실행해 이벤트를 실시간 파싱한다. 호출측 args에
// --mode가 없으면 여기서 주입하고, text 등 다른 모드가 지정돼 있으면 json으로
// 교체한다(진행 로그 스트리밍은 json 이벤트에만 존재하기 때문).
function withJsonMode(args: string[]): string[] {
  const result = [...args];
  const modeIndex = result.indexOf("--mode");
  if (modeIndex >= 0 && modeIndex + 1 < result.length) {
    result[modeIndex + 1] = "json";
    return result;
  }
  return ["--mode", "json", ...result];
}

// 실행 중인 자식 pi 프로세스 추적. 자식은 완전한 LLM 에이전트라서 화면에 안
// 보이는 채 방치되면 그대로 시스템 부하가 된다. 부모 종료·새 세션 시작·clear
// 시점에 여기 남은 자식을 반드시 회수한다.
const activeChildren = new Set<ChildProcess>();
const activeChildStatuses = new Map<string, string>();

function renderActiveChildStatuses(): string | undefined {
  if (activeChildStatuses.size === 0) return undefined;
  return Array.from(activeChildStatuses.entries())
    .map(([label, status]) => `${label}: ${status}`)
    .join(" | ");
}

function setLoopAgentChildStatus(
  ui: Pick<ExtensionContext["ui"], "setStatus">,
  label: string,
  status: string,
): void {
  activeChildStatuses.set(label, status);
  ui.setStatus("loop-agent", renderActiveChildStatuses());
}

function clearLoopAgentChildStatus(
  ui: Pick<ExtensionContext["ui"], "setStatus">,
  label: string,
): void {
  activeChildStatuses.delete(label);
  ui.setStatus("loop-agent", renderActiveChildStatuses());
}

// 부모 pi가 종료할 때 남은 자식을 고아로 남기지 않는다. 'exit' 핸들러는 동기
// 코드만 실행되므로 신호 전송까지만 한다(SIGKILL 에스컬레이션은 불가능하지만,
// 자식 pi는 SIGTERM으로 정상 종료한다).
process.once("exit", () => {
  for (const child of activeChildren) child.kill("SIGTERM");
});

/** 추적 중인 자식을 모두 종료하고 종료 신호를 보낸 개수를 돌려준다. */
function killActiveChildren(): number {
  let killed = 0;
  for (const child of activeChildren) {
    child.kill("SIGTERM");
    killed += 1;
  }
  activeChildren.clear();
  activeChildStatuses.clear();
  return killed;
}

async function runPiCommandWithProgress(
  pi: Pick<ExtensionAPI, "sendMessage">,
  cwd: string,
  ui: Pick<ExtensionContext["ui"], "setStatus">,
  label: string,
  args: string[],
  timeoutMs: number,
  // 부모 세션이 LLM 턴을 스트리밍하는 동안 sendMessage(triggerTurn:false)는
  // 표시·기록 대신 steer 큐로 들어가 사라진다(pi 코어 sendCustomMessage).
  // idle일 때만 진행 메시지를 보내고, 스트리밍 중엔 상태줄만 갱신한다.
  isIdle?: () => boolean,
): Promise<StreamingRunResult> {
  setLoopAgentChildStatus(ui, label, "시작");

  return await new Promise<StreamingRunResult>((resolve, reject) => {
    const child = spawn("pi", withJsonMode(args), {
      cwd,
      env: {
        ...process.env,
        LOOP_AGENT_CHILD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);

    let stderr = "";
    const progressTranscript: string[] = [];
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let lastActivity = Date.now();
    let finished = false;
    let timedOut = false;

    const parse: EventParseState = {
      finalText: "",
      toolNames: new Map(),
      assistantBuffer: "",
      errorMessage: null,
    };

    const clearStatus = (): void => {
      clearLoopAgentChildStatus(ui, label);
    };

    const finish = (result: StreamingRunResult): void => {
      if (finished) return;
      finished = true;
      activeChildren.delete(child);
      clearInterval(heartbeat);
      clearTimeout(timer);
      clearStatus();
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      activeChildren.delete(child);
      clearInterval(heartbeat);
      clearTimeout(timer);
      clearStatus();
      reject(error);
    };

    // 파싱된 이벤트에서 나온 표시용 라인을 로그/상태줄로 흘려보낸다.
    const emit = (parsed: ParsedEventLine): void => {
      if (parsed.status) {
        setLoopAgentChildStatus(ui, label, parsed.status);
      }
      if (!parsed.log) return;
      progressTranscript.push(parsed.log);
      // 스트리밍 중에는 steer 큐로 사라지므로 상태줄/누적 로그만 유지하고
      // 메시지 전송은 건너뛴다. 다음 idle 시점의 메시지가 전체 누적 로그를
      // 포함하므로 유실되지 않는다.
      if (isIdle && !isIdle()) return;
      pi.sendMessage(
        {
          customType: "loop-agent-progress",
          content: formatProgressMessage(label, "stdout", progressTranscript),
          display: true,
          details: {
            label,
            stream: "stdout",
            lines: progressTranscript.length,
          },
        },
        { triggerTurn: false },
      );
    };

    // 자식 stdout은 개행 구분 JSON 이벤트 스트림이다. 완성된 줄만 파싱한다.
    const ingestStdout = (chunk: string): void => {
      lastActivity = Date.now();
      const current = stdoutRemainder + chunk;
      const parts = current.split(/\r?\n/);
      stdoutRemainder = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // JSON이 아닌 진단 출력은 그대로 로그에 남긴다.
          emit({ log: shortenStatusLine(line, 200) });
          continue;
        }
        emit(handleJsonEvent(event, parse));
      }
    };

    // stderr는 사람이 읽는 진단/오류이므로 줄 단위로 로그에 남긴다.
    const ingestStderr = (chunk: string): void => {
      lastActivity = Date.now();
      const current = stderrRemainder + chunk;
      const parts = current.split(/\r?\n/);
      stderrRemainder = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        emit({ log: `[stderr] ${shortenStatusLine(line, 200)}` });
      }
    };

    const heartbeat = setInterval(() => {
      if (finished) return;
      // emit과 같은 이유: 스트리밍 중 sendMessage는 steer 큐로 사라진다.
      if (isIdle && !isIdle()) return;
      const elapsedSeconds = Math.max(
        1,
        Math.floor((Date.now() - lastActivity) / 1000),
      );
      pi.sendMessage(
        {
          customType: "loop-agent-progress",
          content: formatProgressMessage(
            label,
            "heartbeat",
            progressTranscript,
            `${elapsedSeconds}초 동안 새 출력 없음`,
          ),
          display: true,
          details: {
            label,
            stream: "heartbeat",
            lines: progressTranscript.length,
            elapsedSeconds,
          },
        },
        { triggerTurn: false },
      );
    }, 5000);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      setLoopAgentChildStatus(ui, label, "시간 초과, 종료 중");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      ingestStdout(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      ingestStderr(text);
    });

    child.once("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("close", (code, signal) => {
      clearInterval(heartbeat);
      if (timedOut) {
        fail(
          new Error(
            `${label} 실행이 ${Math.floor(timeoutMs / 1000)}초 제한을 넘겨 종료되었습니다.`,
          ),
        );
        return;
      }

      // 마지막 줄에 개행이 없을 수 있으므로 남은 버퍼도 처리한다.
      const stdoutTail = stdoutRemainder.trim();
      if (stdoutTail) {
        try {
          emit(handleJsonEvent(JSON.parse(stdoutTail), parse));
        } catch {
          emit({ log: shortenStatusLine(stdoutTail, 200) });
        }
      }
      const stderrTail = stderrRemainder.trim();
      if (stderrTail) emit({ log: `[stderr] ${shortenStatusLine(stderrTail, 200)}` });

      // json 모드는 assistant 에러가 나도 프로세스 exit는 0일 수 있다. 파싱
      // 단계에서 감지한 에러를 종료 코드로 승격해 호출측 계약(code!==0=실패)을 지킨다.
      const exitCode = code ?? (signal ? 1 : 0);
      const effectiveCode =
        exitCode !== 0 ? exitCode : parse.errorMessage ? 1 : 0;

      finish({
        code: effectiveCode,
        finalText: parse.finalText.trim(),
        stderr: (parse.errorMessage
          ? `${parse.errorMessage}\n${stderr}`
          : stderr
        ).trim(),
      });
    });
  });
}

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

type PersistedWorkflowState = Pick<
  GateState,
  "reviewStage" | "checklist" | "improvementRound" | "autoMode" | "autoReview" | "workflowId"
>;

const state: GateState = {
  enabled: true,
  armed: false,
  reviewStage: "idle",
  checklist: null,
  improvementRound: 0,
  autoMode: false,
  autoReview: true,
  workflowId: null,
  processingWorkflowId: null,
  lengthContinueCount: 0,
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
 * pi.sendUserMessage()는 의도적으로 /skill 명령 확장을 건너뛴다. /hard-goal처럼
 * 확장이 직접 시작하는 턴에서는 Pi 코어와 동일한 형태의 skill 블록을 만들어
 * 전달해야 실제 스킬 지침이 모델 문맥에 포함된다.
 */
/**
 * 계획 파이프라인이 요구하는 스킬 파일과 issue-tracker 문서가 모두 존재하고
 * 읽을 수 있는지 확인한다. 하나라도 없으면 그 경로를, 모두 갖춰졌으면 null을
 * 돌려준다. 워크플로 상태를 바꾸기 전에 호출해, 전제가 갖춰지지 않은 환경에서
 * 첫 메시지를 파이프라인으로 삼켰다가 곧바로 실패하는 일을 막는다.
 */
function findMissingPipelinePrerequisite(root: string): string | null {
  const required = [
    skillPath("grilling"),
    skillPath("domain-modeling"),
    ...PLANNING_PIPELINE_SKILLS.map((skillName) => skillPath(skillName)),
    projectDocPaths(root).issueTracker,
  ];
  for (const filePath of required) {
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch {
      return filePath;
    }
  }
  return null;
}

/**
 * 자동 계획 턴에 필요한 스킬 지침을 모두 주입한다. 파이프라인은
 * grill-with-docs → to-prd → to-issues → grill-checklist 순서로 하나의 턴에서
 * 진행되며, 마지막에 grill-checklist가 기계 판독 경계 안에 목표 체크리스트를
 * 출력해야 한다. 세부 절차는 각 스킬 파일과 issue-tracker 문서를 직접 읽어
 * 따르도록 하고, 이 프롬프트에는 반복되는 본문을 재주입하지 않는다.
 */
function buildPlanningPipelinePrompt(
  objective: string,
  workflowId: string,
  root: string,
): string {
  const docs = projectDocPaths(root);
  return [
    "<loop-agent-pipeline>",
    "아래 파일들을 source of truth로 사용하라. 본문을 프롬프트에 재인용하지 말고 필요할 때 직접 읽어라.",
    `- ${skillPath("grill-checklist")}`,
    `- ${skillPath("grill-with-docs")}`,
    `- ${skillPath("grilling")}`,
    `- ${skillPath("domain-modeling")}`,
    `- ${skillPath("to-prd")}`,
    `- ${skillPath("to-issues")}`,
    `- ${docs.issueTracker}`,
    "필요할 때는 `read` 도구로 해당 파일을 직접 읽어라. `grep`으로 본문을 재생산하지 말고, 한 번에 하나씩 읽어라.",
    "한 번에 하나의 질문만 하고, 아직 물을 질문이 남았으면 그 턴은 질문으로 끝내라.",
    "이전 세션의 요약이나 추측을 섞지 말고, 위 파일과 현재 대화에서만 근거를 가져와라.",
    "</loop-agent-pipeline>",
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
    autoReview: state.autoReview,
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

function extractTestResult(report: string): TestResult {
  const start = report.indexOf(TEST_RESULT_START);
  const end = report.indexOf(TEST_RESULT_END, start + TEST_RESULT_START.length);
  if (start < 0 || end < 0) {
    throw new Error("테스트 보고서에 구조화된 판정 블록이 없습니다.");
  }

  const parsed = JSON.parse(
    report.slice(start + TEST_RESULT_START.length, end).trim(),
  ) as Partial<TestResult>;
  if (parsed.overall !== "PASS" && parsed.overall !== "FAIL") {
    throw new Error("테스트 보고서의 overall 판정이 올바르지 않습니다.");
  }

  const failedCommands = Array.isArray(parsed.failedCommands)
    ? parsed.failedCommands.filter(
        (item): item is FailedCommand =>
          typeof item?.command === "string" &&
          typeof item?.reason === "string" &&
          typeof item?.evidence === "string",
      )
    : [];

  if (parsed.overall === "FAIL" && failedCommands.length === 0) {
    throw new Error("FAIL 판정에 실패한 검증 명령이 포함되지 않았습니다.");
  }
  return { overall: parsed.overall, failedCommands };
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

  const result = await runPiCommandWithProgress(
    pi,
    cwd,
    ui,
    "독립 검수 에이전트",
    args,
    REVIEW_TIMEOUT_MS,
    isIdle,
  );

  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`독립 검수 에이전트 실행 실패: ${reason}`);
  }

  const report = result.finalText.trim();
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
      ctx.ui,
      checklist,
      resolveVerifyingModel(),
      resolveVerifyingThinkingLevel(),
      testReport,
      ctx.isIdle,
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

async function runValidatedTestAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
): Promise<{ report: string; result: TestResult }> {
  const report = await runTestAgent(pi, ctx, checklist);
  return { report, result: extractTestResult(report) };
}

async function runParallelCodingPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checklist: string,
  planningResponse: string,
): Promise<string | null> {
  const tasks = chooseParallelCodingTasks(ctx.cwd, planningResponse);
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
      const output = await runCodingAgent(pi, taskCtx, prompt);
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
    const integrationOutput = await runCodingAgent(pi, ctx, integrationPrompt);
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
): Promise<string> {
  const parallelOutput =
    state.improvementRound === 0
      ? await runParallelCodingPhase(pi, ctx, checklist, prompt)
      : null;
  if (parallelOutput) return parallelOutput;
  return runCodingAgent(pi, ctx, prompt);
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
    "json",
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
  // 그대로 로드한다. 직접 spawn해서 stdout/stderr를 중간중간 status로 흘린다.
  const result = await runPiCommandWithProgress(
    pi,
    ctx.cwd,
    ctx.ui,
    "코드 에이전트",
    args,
    CODING_TIMEOUT_MS,
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
    'PASS JSON 형식: {"overall":"PASS","failedCommands":[]}',
    'FAIL JSON 형식: {"overall":"FAIL","failedCommands":[{"command":"실패한 명령","reason":"실패 이유","evidence":"실패 로그/테스트명"}]}',
    `보고서 마지막 줄들에서 먼저 ${TEST_RESULT_START}를 출력하라.`,
    "그 다음 줄에 실제 판정 JSON 객체 하나만 출력하라.",
    `마지막으로 ${TEST_RESULT_END}를 출력하라.`,
    "두 경계 사이에는 설명, 접두어, 마크다운 코드 펜스를 넣지 말라.",
    "",
    "목표 결과 체크리스트(참조용, 직접 판정하지 말 것):",
    checklist,
  ].join("\n");

  const args = [
    "--mode",
    "json",
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
  const result = await runPiCommandWithProgress(
    pi,
    ctx.cwd,
    ctx.ui,
    "테스트 에이전트",
    args,
    TEST_TIMEOUT_MS,
    ctx.isIdle,
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`테스트 에이전트 실행 실패: ${reason}`);
  }

  const output = result.finalText.trim();
  if (!output) throw new Error("테스트 에이전트가 빈 결과를 반환했습니다.");
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
    `독립 검수 ${round}차에서 아래 항목이 통과하지 못했습니다.`,
    "실제 코드와 검증 결과를 확인해 실패 항목만 개선하고 관련 테스트를 실행하세요.",
    "기존에 통과한 항목을 회귀시키지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
    "",
    buildImplementSkillGuidance(),
    "",
    buildTaskTrackingInstructions(root),
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
        const codingOutput = await runCodingPhase(
          pi,
          ctx,
          state.checklist,
          codingPrompt,
        );
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

      state.reviewStage = state.autoReview ? "reviewing" : "testing";
      persistWorkflowState(pi, "testing-started");
      ctx.ui.notify(
        state.autoReview
          ? "loop-agent: 테스트 전용 에이전트와 독립 검수 에이전트를 병렬 실행합니다."
          : "loop-agent: 테스트 전용 에이전트를 실행합니다.",
        "info",
      );
      let testReport: string | null = null;
      let testResult: TestResult | null = null;
      const testPromise = runValidatedTestAgent(pi, ctx, state.checklist);

      let reviewPromise:
        | Promise<
            | { ok: true; value: { report: string; result: ReviewResult } }
            | { ok: false; error: unknown }
          >
        | null = null;
      if (state.autoReview) {
        persistWorkflowState(pi, "review-started");
        reviewPromise = runValidatedReview(pi, ctx, state.checklist, null)
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error }));
      }

      try {
        const testRun = await testPromise;
        testReport = testRun.report;
        testResult = testRun.result;
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
        testResult = {
          overall: "FAIL",
          failedCommands: [
            {
              command: "테스트 에이전트 실행",
              reason: message,
              evidence:
                "테스트 에이전트가 성공적으로 완료되거나 구조화된 결과를 반환하지 못했습니다.",
            },
          ],
        };
        ctx.ui.notify(
          `loop-agent: 테스트 에이전트가 실패했습니다 (${message}). 이 라운드는 테스트 미통과로 처리합니다.`,
          "warning",
        );
      }
      persistWorkflowState(pi, "testing-completed");

      if (!state.autoReview) {
        if (!testResult || testResult.overall !== "PASS") {
          state.reviewStage = "failed";
          state.autoMode = false;
          state.autoReview = true;
          state.workflowId = null;
          persistWorkflowState(pi, "testing-failed");
          ctx.ui.notify(
            "loop-agent: 테스트를 통과하지 못해 easy-goal 워크플로를 완료로 처리하지 않습니다.",
            "error",
          );
          return;
        }
        state.reviewStage = "reviewed";
        state.autoMode = false;
        state.autoReview = true;
        state.workflowId = null;
        persistWorkflowState(pi, "completed-without-review");
        ctx.ui.notify(
          "loop-agent: 테스트 단계까지 완료했고 독립 검수 자동 반복은 생략합니다.",
          "info",
        );
        return;
      }

      const reviewRun = await reviewPromise!;
      if (!reviewRun.ok) throw reviewRun.error;
      const { report: rawReviewReport, result: rawReviewResult } =
        reviewRun.value;
      if (!isCurrentWorkflow(workflowId)) return;
      const report = buildMergedReviewReport(rawReviewReport, testResult);
      const result = mergeVerificationResults(rawReviewResult, testResult);
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
        state.autoReview = true;
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
        state.autoReview = true;
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
        ctx.cwd,
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
    state.autoReview = true;
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
      state.reviewStage = "idle";
      state.checklist = null;
      state.improvementRound = 0;
      state.autoMode = false;
      state.autoReview = true;
      state.workflowId = null;
      // 상태만 리셋하면 이미 spawn된 자식 에이전트는 보이지 않는 채 계속
      // 실행되므로(부하), clear는 자식 프로세스까지 함께 회수해야 한다.
      killActiveChildren();
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
      // state만 리셋하면 이전 워크플로의 자식 에이전트가 고아로 남아 보이지
      // 않는 부하가 되므로(가드 isCurrentWorkflow가 결과만 버림), 먼저 회수한다.
      const killed = killActiveChildren();
      if (killed > 0) {
        ctx.ui.notify(
          `loop-agent: 이전 워크플로의 자식 에이전트 ${killed}개를 종료했습니다.`,
          "warning",
        );
      }
      state.reviewStage = "idle";
      state.checklist = null;
      state.improvementRound = 0;
      state.autoMode = false;
      state.autoReview = true;
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
          state.reviewStage === "testing" ||
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
        state.reviewStage === "reviewing")
    ) {
      ctx.ui.notify(
        "loop-agent: 컴팩션 이후 진행 중이던 워크플로를 이어서 실행합니다.",
        "info",
      );
      startExecutionReviewLoop(pi, ctx, state.workflowId);
    }
  });

  // /hard-goal, /easy-goal 명령과 첫 세션 메시지(input 핸들러)가 공유하는 반자동 파이프라인 진입점.
  // 워크플로 상태를 원자적으로 초기화하고 계획 모델을 고른 뒤 계획 프롬프트를
  // 구성해 반환한다. 준비가 실패하면 null을 반환하고 상태를 되돌린다.
  // 실제 입력 주입(sendUserMessage vs input transform)은 호출측이 맡는다.
  async function prepareGoalPipeline(
    ctx: ExtensionContext,
    objective: string,
    // 명시적 /hard-goal, /easy-goal은 전제 누락을 에러로 안내하지만, armed 첫 메시지처럼
    // 암묵적으로 파이프라인에 태우는 경우엔 조용히 원본 입력을 통과시킨다.
    { explicit = true, autoReview = true }: { explicit?: boolean; autoReview?: boolean } = {},
): Promise<string | null> {
  if (!ensureWorkflowWorkspace(ctx, explicit)) return null;

  // 상태를 바꾸기 전에 남은 전제 파일(파이프라인 스킬)을 확인한다. 문서는 위에서
  // 생성했으므로, 여기서 걸리는 건 대개 설치 폴더의 스킬 파일 누락이다. 없으면
  // 워크플로를 시작하지 않고, 암묵적 경로에서는 원본 입력을 그대로 흘려보낸다.
    const missing = findMissingPipelinePrerequisite(ctx.cwd);
    if (missing) {
      if (explicit) {
        ctx.ui.notify(
          `loop-agent: 파이프라인 전제 파일이 없어 목표를 시작할 수 없습니다: ${missing}`,
          "error",
        );
      }
      return null;
    }

    // 새 목표가 이전 작업의 체크리스트나 반복 횟수를 이어받지 않도록
    // 워크플로 상태를 원자적으로 초기화한다.
    state.armed = false;
    state.autoMode = true;
    state.autoReview = autoReview;
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
      state.autoReview = true;
      state.workflowId = null;
      persistWorkflowState(pi, "planning-model-failed");
      return null;
    }

    ctx.ui.notify(
      "loop-agent: 반자동 목표 파이프라인(인터뷰 → to-prd → to-issues → checklist → 자동 구현·검증)을 시작합니다. 1단계 인터뷰는 질문/답변을 주고받습니다.",
      "info",
    );
    try {
      return buildPlanningPipelinePrompt(objective, workflowId, ctx.cwd);
    } catch (error) {
      state.autoMode = false;
      state.autoReview = true;
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

  async function startQuickWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    objective: string,
    explicit: boolean,
    autoReview = true,
  ): Promise<boolean> {
    if (!ensureWorkflowWorkspace(ctx, explicit)) return false;

    const workflowId = randomUUID();
    const { checklist, prompt } = buildDirectCodingPrompt(objective, ctx.cwd);

    state.armed = false;
    state.autoMode = true;
    state.autoReview = autoReview;
    state.reviewStage = "awaiting-execution";
    state.checklist = checklist;
    state.improvementRound = 0;
    state.workflowId = workflowId;
    persistWorkflowState(piApi, "quick-goal-started");

    const modelSelected = await selectModel(
      piApi,
      ctx,
      config.codingModel,
      config.codingThinkingLevel,
      "코드",
    );
    if (!modelSelected) {
      state.autoMode = false;
      state.autoReview = true;
      state.reviewStage = "idle";
      state.checklist = null;
      state.workflowId = null;
      persistWorkflowState(piApi, "quick-goal-model-failed");
      return false;
    }

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
    const prompt = await prepareGoalPipeline(ctx, objective, { autoReview });
    if (prompt) piApi.sendUserMessage(prompt);
  }

  // 첫 메시지 자동 진입과 /easy-goal 명령이 같은 모드 판별(quick/direct/plan)을
  // 공유하도록 묶는다. 명시적 명령은 sendUserMessage로 새 턴을 시작하고, 첫
  // 메시지 입력 핸들러는 같은 판별 결과를 이용하되 prompt 텍스트를 반환해
  // runner 계약(result.text / result.handled)에 맞게 원문을 치환한다.
  async function resolveEasyGoalWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    rawObjective: string,
    explicit: boolean,
  ): Promise<{ handled: boolean; prompt?: string }> {
    const mode = parseGoalMode(rawObjective);
    const objective = mode?.objective ?? rawObjective;

    if (mode?.mode === "direct") {
      return { handled: await startQuickWorkflow(piApi, ctx, objective, true, false) };
    }

    if (!mode && isLikelyQuickTask(objective)) {
      const started = await startQuickWorkflow(piApi, ctx, objective, false, false);
      if (started) return { handled: true };
    }

    const prompt = await prepareGoalPipeline(ctx, objective, {
      explicit,
      autoReview: false,
    });
    if (!prompt) return { handled: false };
    return { handled: true, prompt };
  }

  async function startEasyGoalWorkflow(
    piApi: ExtensionAPI,
    ctx: ExtensionContext,
    rawObjective: string,
    explicit: boolean,
  ): Promise<boolean> {
    const result = await resolveEasyGoalWorkflow(piApi, ctx, rawObjective, explicit);
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

    // 첫 메시지도 /easy-goal과 같은 스타터를 공유한다. 준비 실패(바쁨/이미 진행
    // 중/전제 파일 누락) 시에만 원본을 그대로 통과시킨다.
    const result = await resolveEasyGoalWorkflow(pi, ctx, text, false);
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
        // /hard-goal, /easy-goal 작업은 사용자 승인을 다시 기다리지 않는다. 확장이 별도 코드
        // 프로세스의 종료 코드를 직접 기다리므로 실행 실패도 상태에 반영된다.
        const codingPrompt = [
          "자동 실행 모드입니다. 아래 확정 명세와 구현 계획을 즉시 실행하세요.",
          "목표 체크리스트를 모두 만족하도록 코드를 수정하고 필요한 테스트를 실행하세요.",
          "작업을 중간에 멈추거나 사용자 승인을 다시 요청하지 말고, 완료 후 변경 내용과 검증 근거를 보고하세요.",
          "",
          buildImplementSkillGuidance(),
          "",
          buildTaskTrackingInstructions(ctx.cwd),
          "",
          planningResponse,
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
      "Start a semi-automated workflow that stops after testing and skips independent review repetition. Usage: /easy-goal [plan|direct] <objective>",
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
