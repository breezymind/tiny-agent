import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 그래프 인덱스(codegraph) 상태를 조회하는 공통 헬퍼.
// auto-index.ts(자동 인덱싱 트리거)와 graph-gate.ts(그래프 우선 게이트)가
// 서로 다른 판단을 내리지 않도록 이 모듈 하나만 상태 판정의 진실 소스로 쓴다.
//
// 여기 있는 함수들은 모두 조회 전용(side-effect 없음)이다. 인덱싱을 실제로
// 트리거하거나 lock을 잡는 로직은 auto-index.ts에 남아 있다.

export type McpServerConfig = {
  command?: string;
  args?: unknown[];
};

export type McpConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type CommandInvocation = {
  command: string;
  argsPrefix: string[];
};

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const MCP_CONFIG_PATH = join(AGENT_DIR, "mcp.json");
export const COMMAND_TIMEOUT_MS = 10_000;
const CODEGRAPH_DIR_NAME = ".codegraph";
const CODEGRAPH_DB_NAME = "codegraph.db";

// 실제 등록된 MCP 실행 파일을 그대로 사용하기 위해 mcp.json을 읽는다.
// 설정 파일이 없거나 JSON이 깨졌다면 빈 설정을 반환해 호출부가 조용히 건너뛰게 한다.
export function readMcpConfig(): McpConfig {
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")) as McpConfig;
  } catch {
    return {};
  }
}

// 심볼릭 링크나 상대 경로 차이 때문에 같은 프로젝트를 서로 다른 경로로
// 판단하지 않도록 비교 전에 가능한 한 실제 절대 경로로 정규화한다.
export function canonicalPath(path: string): string {
  const resolved = resolve(path);

  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// 프로젝트 루트 안에 이미 만들어진 CodeGraph 인덱스가 있는지 직접 확인한다.
// MCP 설정이 비어 있어도 로컬 인덱스 파일이 있으면 그래프는 사용할 수 있어야 한다.
export function hasLocalCodegraphIndex(projectRoot: string): boolean {
  return existsSync(join(projectRoot, CODEGRAPH_DIR_NAME, CODEGRAPH_DB_NAME));
}

// 하위 디렉터리에서 Pi를 실행해도 저장소 전체를 하나의 프로젝트로 다루도록
// 현재 cwd가 속한 Git 최상위 디렉터리를 찾는다. Git 저장소가 아니면 undefined.
export async function findGitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
  });

  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root.length > 0 ? canonicalPath(root) : undefined;
}

// CLI의 stderr/진행 로그가 stdout과 섞이는 환경도 고려해
// 뒤에서부터 유효한 JSON 객체 한 줄을 찾아 반환한다.
export function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").reverse();

  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // CLI 로그가 섞일 수 있으므로 JSON 객체인 줄만 사용한다.
    }
  }

  return undefined;
}

// MCP 서버 진입점과 CodeGraph CLI 진입점은 같은 것이 아니다. 플러그인 번들은
// `node .../serve.js`를 MCP 서버로 등록하지만 serve.js는 `status`/`init` 같은 CLI
// 명령을 처리하지 않는다. 이 구성에서는 등록된 Node 실행 파일과 같은 bin 디렉터리의
// `codegraph` 실행 파일을 사용한다. npm-shim처럼 CLI를 겸하는 기존 구성은 유지한다.
export function resolveCodegraphCli(config: McpConfig): CommandInvocation | undefined {
  const server = config.mcpServers?.codegraph;
  const command = server?.command;
  const scriptPath = server?.args?.find(
    (arg): arg is string => typeof arg === "string" && arg.endsWith(".js"),
  );
  if (typeof command !== "string") return undefined;

  if (scriptPath !== undefined && basename(scriptPath) !== "serve.js") {
    return { command, argsPrefix: [scriptPath] };
  }

  const executableName = process.platform === "win32" ? "codegraph.cmd" : "codegraph";
  const adjacentCli = join(dirname(command), executableName);
  if (existsSync(adjacentCli)) {
    return { command: adjacentCli, argsPrefix: [] };
  }

  return undefined;
}

// projectRoot 안에 이미 생성된 CodeGraph 인덱스가 있으면 즉시 true를 반환한다.
// 로컬 인덱스가 없을 때만 MCP 설정에서 실제 CodeGraph CLI 실행 방법을 구해
// projectRoot의 초기화 상태를 확인한다. 실행 방법을 찾지 못하거나 상태 조회가
// 실패하면 false(fail open).
export async function checkCodegraphIndexed(
  pi: ExtensionAPI,
  projectRoot: string,
  config: McpConfig,
): Promise<boolean> {
  if (hasLocalCodegraphIndex(projectRoot)) {
    return true;
  }

  const invocation = resolveCodegraphCli(config);
  if (invocation === undefined) return false;

  try {
    const statusResult = await pi.exec(
      invocation.command,
      [...invocation.argsPrefix, "status", "--json"],
      { cwd: projectRoot, timeout: COMMAND_TIMEOUT_MS },
    );

    if (statusResult.code !== 0) return false;

    const status = parseJsonObject(statusResult.stdout);
    return status?.initialized === true;
  } catch {
    return false;
  }
}

// codegraph가 projectRoot를 인덱싱하고 있으면 그래프 도구를 쓸 수 있다고 본다.
// projectRoot가 없으면(git 저장소 밖 등) 그래프를 쓸 수 없는 것으로 간주한다.
export async function isGraphAvailable(
  pi: ExtensionAPI,
  projectRoot: string | undefined,
  config: McpConfig = readMcpConfig(),
): Promise<boolean> {
  if (projectRoot === undefined) return false;

  return checkCodegraphIndexed(pi, projectRoot, config);
}
