import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findGitRoot, isGraphAvailable, readMcpConfig, type McpConfig } from "./lib/graph-status.ts";

// 그래프 우선(graph-first) 게이트:
// 에이전트가 grep/read 같은 원시 소스 검색·읽기를 하기 전에
// CodeGraph 도구를 먼저 시도하도록 강제한다.
// - strict(인덱스가 있으면 기본): graph discovery를 시도하기 전까지 계속 차단한다.
// - permissive: 턴마다 첫 위반만 차단하고, 이후 fallback 검색은 허용한다.
// /graph-gate 명령으로 세션 중에 모드를 바꾸거나 상태를 확인할 수 있다.
//
// 게이트는 실제로 그래프 도구를 쓸 수 있을 때만 적용된다: codegraph가
// 해당 프로젝트를 인덱싱하고 있을 때만 "graph discovery 가능"으로 판단해
// 게이트를 작동시킨다(lib/graph-status.ts 참고). ~/.pi처럼 인덱싱할 수 없는
// (코드가 없거나 git 저장소가 아닌) 신규 프로젝트처럼 인덱스가 없는 경우에는
// 근거가 없으므로 게이트가 자동으로 비활성화된다. 인덱스 없음(확인 실패 포함)은
// strict 모드보다 항상 우선한다(fail open): 존재하지 않는 그래프를 강제할 수는 없다.

type GateState = {
  enabled: boolean;
  strict: boolean;
  // 이번 턴에 graph discovery 도구를 한 번이라도 호출했는지 여부.
  graphAttempted: boolean;
  // permissive 모드에서 이번 턴에 이미 한 번 차단했는지 여부.
  blockedOnceInTurn: boolean;
  // 디버깅용: 마지막 사용자 입력을 상태 출력에 요약해 보여준다.
  lastInput: string;
  // 현재 세션의 cwd가 속한 Git 최상위 디렉터리. session_start에서 한 번만
  // 계산해 캐싱한다. Git 프로젝트가 아니면 undefined이고, 그럴 경우
  // 그래프 인덱스도 있을 수 없다.
  projectRoot: string | undefined;
  // session_start에서 한 번 확인해놓은 상태 확인 결과(참고용 기본값).
  sessionGraphAvailable: boolean;
  // 이번 턴에 "차단 직전 재확인"을 한 번이라도 수행했는지 여부와 그 결과.
  // 턴 단위로 사용(Q8)해 불필요한 재확인 서브프로세스 스폰을 막는다.
  turnGraphAvailableChecked: boolean;
  turnGraphAvailable: boolean;
};

type ToolCallLike = {
  toolName?: string;
  input?: Record<string, unknown>;
};

const state: GateState = {
  enabled: true,
  strict: false,
  graphAttempted: false,
  blockedOnceInTurn: false,
  lastInput: "",
  projectRoot: undefined,
  sessionGraphAvailable: false,
  turnGraphAvailableChecked: false,
  turnGraphAvailable: false,
};

// 그래프 도구(codegraph)를 지금 실제로 쓸 수 있는지 판단한다.
// 이번 턴에 이미 재확인했다면(state.turnGraphAvailableChecked) 새 프로세스 없이
// 그 결과를 재사용한다(Q8: 턴 단위 캐싱). 아직 이번 턴에서 확인한 적이 없다면 새로
// 확인해 캐싱한다(Q4: 차단 직전 재확인). projectRoot가 없으면 곧바로 false를 반환한다.
async function checkGraphAvailableForBlocking(
  pi: ExtensionAPI,
  config: McpConfig,
): Promise<boolean> {
  if (state.turnGraphAvailableChecked) return state.turnGraphAvailable;

  const available = await isGraphAvailable(pi, state.projectRoot, config);
  state.turnGraphAvailableChecked = true;
  state.turnGraphAvailable = available;
  return available;
}

// 이 도구들 중 하나라도 호출하면 "graph discovery를 시도했다"고 보고
// 같은 턴의 후속 소스 검색·읽기를 허용한다.
// MCP 어댑터에 따라 접두어가 붙을 수 있어 toolNameMatches에서 접미사 매칭도 지원한다.
const GRAPH_DISCOVERY_TOOLS = [
  "codegraph_search",
  "codegraph_node",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_explore",
] as const;

// 상태 확인·인덱싱 도구는 실제 탐색이 아니므로 잠금 해제로 치지 않는다.
const GRAPH_STATUS_TOOLS = [
  "codegraph_status",
] as const;

const DOCUMENT_READ_PREFIXES = [
  "skills/",
  ".claude/",
] as const;

const DOCUMENT_READ_NAMES = new Set([
  "AGENT.md",
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
  "settings.json",
  "settings.local.json",
  ".mcp.json",
  "skills-lock.json",
  "auth.json",
  "trust.json",
]);

const SHELL_TOOL_NAMES = ["bash", "shell", "exec", "command", "rtk"] as const;
const FILE_READ_TOOL_NAMES = ["read"] as const;

function normalizeArgs(args: unknown): string {
  if (Array.isArray(args)) return args.join(" ").trim();
  if (typeof args === "string") return args.trim();
  if (args == null) return "";
  return String(args).trim();
}

// MCP 어댑터가 "server.tool", "server__tool", "server_tool" 형태로 접두어를 붙이는
// 경우까지 커버하도록 정확 일치 외에 접미사 일치도 허용한다.
function toolNameMatches(toolName: string, candidates: readonly string[]): boolean {
  const normalizedToolName = toolName.toLowerCase();

  return candidates.some(
    (candidate) =>
      normalizedToolName === candidate ||
      normalizedToolName.endsWith(`.${candidate}`) ||
      normalizedToolName.endsWith(`__${candidate}`) ||
      normalizedToolName.endsWith(`_${candidate}`),
  );
}

function isGraphDiscoveryTool(toolName: string): boolean {
  return toolNameMatches(toolName, GRAPH_DISCOVERY_TOOLS);
}

function isGraphStatusTool(toolName: string): boolean {
  return toolNameMatches(toolName, GRAPH_STATUS_TOOLS);
}

function isShellTool(toolName: string): boolean {
  return toolNameMatches(toolName, SHELL_TOOL_NAMES);
}

function isFileReadTool(toolName: string): boolean {
  return toolNameMatches(toolName, FILE_READ_TOOL_NAMES);
}

function normalizePathLike(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function isAllowlistedDocumentPath(path: string): boolean {
  const normalized = normalizePathLike(path);
  if (!normalized) return false;

  if (
    DOCUMENT_READ_PREFIXES.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
    )
  ) {
    return true;
  }

  const baseName = normalized.split("/").pop() ?? normalized;
  if (DOCUMENT_READ_NAMES.has(baseName)) return true;

  return false;
}

function isAllowlistedDocumentCommandSegment(segment: string): boolean {
  const tokens = stripKnownWrappers(tokenizeCommand(segment));
  const [verb, ...args] = tokens;

  if (!verb || args.length === 0) return false;

  if (verb === "cat" || verb === "read") {
    return args.every(isAllowlistedDocumentPath);
  }

  return false;
}

// tool input에서 실제 명령으로 쓸 수 있는 문자열 필드만 모은다.
// path/query 같은 값은 오탐을 늘리기 쉬워서 여기서는 제외한다.
function collectTextFragments(input: Record<string, unknown>): string[] {
  const fragments: string[] = [];

  for (const key of ["command", "cmd", "shellCommand", "args", "argv"] as const) {
    const value = input[key];

    if (typeof value === "string") {
      fragments.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      fragments.push(value.map(String).join(" "));
    }
  }

  return fragments;
}

function extractReadTarget(input: Record<string, unknown>): string | undefined {
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "target",
    "targetPath",
    "file",
    "filename",
  ] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

// read 계열 도구는 별도 명령 문자열이 없을 수 있으므로 이름만으로도 판정할 수 있게 한다.
function extractCommand(event: ToolCallLike): string {
  const toolName = event.toolName ?? "";

  if (isFileReadTool(toolName)) {
    return toolName;
  }

  if (!isShellTool(toolName)) {
    return "";
  }

  return collectTextFragments(event.input ?? {}).join(" ").trim();
}

// 토큰 앞뒤의 따옴표를 벗겨 "'rg'"와 rg를 같은 명령으로 취급한다.
function normalizeToken(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, "");
}

// 파이프(|)·체인(&&, ||, ;, &)으로 연결된 복합 명령을 세그먼트 단위로 나눈다.
// 각 세그먼트를 따로 검사해야 "ls && rg foo" 같은 우회를 잡을 수 있다.
function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|[|;&])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenizeCommand(command: string): string[] {
  return command
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

// rtk, rtk proxy, bash -c/-lc 같은 래퍼를 제거해 실제 실행 토큰만 남긴다.
// 래퍼가 중첩될 수 있으므로(예: rtk proxy bash -lc "rg ...") 반복해서 벗긴다.
function stripKnownWrappers(tokens: readonly string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (token === "rtk") {
      index += 1;

      if (nextToken === "proxy") {
        index += 1;
      }

      continue;
    }

    if (
      (token === "bash" || token === "sh" || token === "zsh") &&
      (nextToken === "-c" || nextToken === "-lc")
    ) {
      index += 2;
      continue;
    }

    break;
  }

  return tokens.slice(index);
}

// 저장소 상태 파악용 git 하위 명령은 코드 내용 검색이 아니므로 허용한다.
// git diff는 --stat/--name-only처럼 목록만 보는 경우에만 안전으로 본다.
function isSafeGitSubcommand(tokens: readonly string[]): boolean {
  const [subcommand, ...args] = tokens;

  if (!subcommand) return false;

  switch (subcommand) {
    case "status":
    case "ls-files":
    case "branch":
    case "rev-parse":
    case "log":
      return true;
    case "diff":
      return args.includes("--stat") || args.includes("--name-only");
    default:
      return false;
  }
}

// 명령 자체가 안전한지 먼저 본다.
// 세그먼트가 여러 개인 경우에는 파이프/체인 중 하나라도 검색·읽기면 차단할 수 있게 별도 검사한다.
function isSafeCommandSegment(segment: string): boolean {
  const tokens = stripKnownWrappers(tokenizeCommand(segment));
  const [verb, ...args] = tokens;

  if (!verb) return false;

  if (verb === "pwd" || verb === "ls") {
    return true;
  }

  if (verb === "git") {
    return isSafeGitSubcommand(args);
  }

  return false;
}

// 소스 검색(rg/grep/fd/...)이나 파일 내용 읽기(cat/head/...)에 해당하는
// 세그먼트인지 판정한다. graph discovery 전에는 이 명령들을 차단한다.
function isBlockedCommandSegment(segment: string): boolean {
  const tokens = stripKnownWrappers(tokenizeCommand(segment));
  const [verb, secondToken] = tokens;

  if (!verb) return false;

  if (
    verb === "rg" ||
    verb === "grep" ||
    verb === "fd" ||
    verb === "find" ||
    verb === "ag" ||
    verb === "ack" ||
    verb === "cat" ||
    verb === "head" ||
    verb === "tail" ||
    verb === "more" ||
    verb === "tac" ||
    verb === "less" ||
    verb === "awk" ||
    verb === "read"
  ) {
    return true;
  }

  if (verb === "git" && secondToken === "grep") {
    return true;
  }

  // sed는 편집 용도도 있으므로 출력 전용(-n) 사용만 읽기로 간주한다.
  if (verb === "sed") {
    return secondToken === "-n" || secondToken?.startsWith("-n") === true;
  }

  // nl -ba는 파일에 줄 번호를 붙여 읽는 전형적인 패턴이다.
  if (verb === "nl") {
    return secondToken === "-ba" || secondToken?.startsWith("-ba") === true;
  }

  return false;
}

function isBlockedSearchCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  if (!normalized) return false;

  const segments = splitCommandSegments(normalized);

  // 안전한 단일 명령은 허용한다.
  // 다만 파이프/체인으로 연결된 경우에는 각 세그먼트를 따로 봐야 한다.
  if (segments.length === 1 && isSafeCommandSegment(segments[0])) {
    return false;
  }

  if (segments.every(isAllowlistedDocumentCommandSegment)) {
    return false;
  }

  return segments.some(isBlockedCommandSegment);
}

function summarizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120) || "(empty)";
}

// 차단 사유 메시지. 허용 도구 목록은 GRAPH_DISCOVERY_TOOLS에서 파생해
// 목록이 바뀌어도 메시지를 따로 고칠 필요가 없게 한다.
function getBlockReason(command: string): string {
  const modeHint = state.strict
    ? "현재 strict 모드이므로 graph discovery 전의 source search/read는 계속 차단됩니다."
    : "현재 permissive 모드이므로 첫 차단 뒤 같은 턴의 다음 검색은 허용됩니다.";

  return [
    "Graph-first gate blocked a source search/read command before graph discovery.",
    "",
    "먼저 그래프 계열 도구를 사용하세요:",
    ...GRAPH_DISCOVERY_TOOLS.map((tool) => `- ${tool}`),
    "",
    "주의:",
    "- codegraph_status는 상태 확인만 하며 graph discovery 완료로 보지 않습니다.",
    `- ${modeHint}`,
    "",
    `Blocked command: ${command}`,
  ].join("\n");
}

// 사용자 입력이 새로 들어올 때마다 턴 단위 상태만 초기화한다.
// turnGraphAvailable*도 여기서 함께 초기화해 새 턴마다 차단 직전 재확인(Q4)이
// 다시 수행되게 한다.
function resetTurnState(): void {
  state.graphAttempted = false;
  state.blockedOnceInTurn = false;
  state.turnGraphAvailableChecked = false;
  state.turnGraphAvailable = false;
}

// 세션이 새로 시작될 때는 턴 상태에 더해 입력 기록까지 초기화한다.
function resetSessionState(): void {
  resetTurnState();
  state.lastInput = "";
}

function renderGateStatus(): string {
  return [
    "graph-first-gate status",
    `- enabled: ${state.enabled}`,
    `- strict: ${state.strict}`,
    `- projectRoot: ${state.projectRoot ?? "(none - not a git project)"}`,
    `- sessionGraphAvailable (session_start 확인): ${state.sessionGraphAvailable}`,
    `- turnGraphAvailable (이번 턴 재확인): ${
      state.turnGraphAvailableChecked ? state.turnGraphAvailable : "(미확인)"
    }`,
    `- graphAttempted: ${state.graphAttempted}`,
    `- blockedOnceInTurn: ${state.blockedOnceInTurn}`,
    `- lastInput: ${summarizeInput(state.lastInput)}`,
  ].join("\n");
}

// /graph-gate 하위 명령을 상태에 반영한다. 알 수 없는 명령이면 false를 반환한다.
function applyGateCommand(command: string): boolean {
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
    case "strict":
      state.strict = true;
      return true;
    case "permissive":
      state.strict = false;
      return true;
    case "reset":
      resetSessionState();
      return true;
    case "mark":
      // 수동으로 "graph discovery 완료" 상태를 만든다. 게이트를 잠깐 풀 때 사용.
      state.graphAttempted = true;
      return true;
    default:
      return false;
  }
}

export default function graphFirstGate(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // 세션이 새로 시작되면 이전 턴의 막힘/시도 상태를 지운다.
    resetSessionState();

    state.projectRoot = ctx.isProjectTrusted() ? await findGitRoot(pi, ctx.cwd) : undefined;
    state.sessionGraphAvailable = await isGraphAvailable(pi, state.projectRoot, readMcpConfig());
    state.strict = state.sessionGraphAvailable;

    const scopeHint = state.sessionGraphAvailable
      ? "graph index found"
      : "no graph index found - gate inactive until one appears";
    ctx.ui.notify(
      `graph-first-gate loaded (${state.enabled ? "enabled" : "disabled"}, ${state.strict ? "strict" : "permissive"}, ${scopeHint})`,
      "info",
    );
  });

  pi.on("input", async (event) => {
    // 확장이 주입한 입력(예: 명령 처리 결과)은 새 턴으로 취급하지 않는다.
    if (event.source === "extension") {
      return { action: "continue" };
    }

    // 새 사용자 입력이 들어오면 턴 상태를 초기화한다.
    state.lastInput = event.text ?? "";
    resetTurnState();

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return;

    const toolName = event.toolName;

    // graph discovery 도구를 먼저 사용하면 이후 source search/read를 허용한다.
    if (isGraphDiscoveryTool(toolName)) {
      state.graphAttempted = true;
      ctx.ui.notify(`Graph discovery attempted: ${toolName}`, "info");
      return;
    }

    // 상태 확인 도구는 참고용이므로, 그것만으로는 잠금 해제를 하지 않는다.
    if (isGraphStatusTool(toolName)) {
      ctx.ui.notify(
        `Graph status checked: ${toolName}. This does not unlock source search.`,
        "info",
      );
      return;
    }

    if (isFileReadTool(toolName)) {
      const readTarget = extractReadTarget((event.input ?? {}) as Record<string, unknown>);
      if (readTarget && isAllowlistedDocumentPath(readTarget)) {
        return;
      }
    }

    const command = extractCommand(event);
    if (!command) return;

    if (!isBlockedSearchCommand(command)) return;

    // graph discovery를 이미 시도했다면 같은 턴에서의 source search/read는 허용한다.
    if (state.graphAttempted) return;

    // 차단하기 직전, 그래프 인덱스가 실제로 존재하는지 재확인한다(Q4). 인덱스가
    // 없다면(확인 실패 포함, fail open) strict 모드여도 차단하지 않는다(Q6/Q7) —
    // 존재하지 않는 그래프를 강제할 수는 없다.
    const graphAvailable = await checkGraphAvailableForBlocking(pi, readMcpConfig());
    if (!graphAvailable) {
      ctx.ui.notify(
        "No graph index found for this project. Allowing source search/read without graph discovery.",
        "warning",
      );
      return;
    }

    // permissive 모드에서는 첫 차단만 하고, 같은 턴의 후속 fallback 검색은 허용한다.
    if (!state.strict && state.blockedOnceInTurn) {
      return;
    }

    state.blockedOnceInTurn = true;

    return {
      block: true,
      reason: getBlockReason(command),
    };
  });

  pi.registerCommand("graph-gate", {
    description:
      "Control graph-first gate. Usage: /graph-gate status|on|off|strict|permissive|reset|mark",
    handler: async (args, ctx) => {
      const command = normalizeArgs(args).toLowerCase();
      const handled = applyGateCommand(command);

      if (!handled) {
        ctx.ui.notify(
          [
            `Unknown graph-gate command: ${command || "(empty)"}`,
            "",
            "Usage: /graph-gate status|on|off|strict|permissive|reset|mark",
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
