import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AGENT_DIR,
  checkCodegraphIndexed,
  findGitRoot,
  type McpConfig,
  readMcpConfig,
  resolveCodegraphCli,
} from "./lib/graph-status.ts";

type Lock = {
  path: string;
  release: () => void;
};

// 자동 인덱싱 실행에 필요한 공통 제한값이다. 상태 조회 관련 상수/헬퍼는
// lib/graph-status.ts로 옮겨 graph-gate.ts와 공유한다.
const LOCK_DIR = join(AGENT_DIR, ".auto-index");
const LOCK_STALE_MS = 30 * 60 * 1000;

// 여러 Pi 세션이 같은 신규 프로젝트를 동시에 인덱싱하지 못하도록
// (인덱서, 프로젝트) 조합별 lock 파일을 원자적으로 만든다.
// scope를 키에 포함해 두 인덱서가 같은 프로젝트를 각자 독립적으로 잠글 수 있다.
// 비정상 종료로 남은 lock은 30분 뒤 폐기한다.
function acquireLock(scope: string, projectRoot: string): Lock | undefined {
  mkdirSync(LOCK_DIR, { recursive: true });
  const key = createHash("sha256").update(`${scope}:${projectRoot}`).digest("hex").slice(0, 20);
  const lockPath = join(LOCK_DIR, `${key}.lock`);

  if (existsSync(lockPath)) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
    } catch {
      return undefined;
    }
  }

  try {
    // "wx" 플래그로 이미 존재하면 실패하게 해 생성 자체를 원자적 잠금으로 쓴다.
    closeSync(openSync(lockPath, "wx"));
  } catch {
    return undefined;
  }

  return {
    path: lockPath,
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // 이미 정리된 lock은 무시한다.
      }
    },
  };
}

// 인덱싱은 오래 걸릴 수 있으므로 Pi 세션 시작을 막지 않도록
// 완전히 분리된(detached) 백그라운드 프로세스로 실행한다.
// 프로세스가 끝나거나 실행에 실패하면 반드시 lock을 해제한다.
function spawnDetachedIndexer(
  ctx: ExtensionContext,
  lock: Lock,
  label: string,
  command: string,
  args: string[],
  projectRoot: string,
): void {
  try {
    const child = spawn(command, args, {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", lock.release);
    child.once("exit", lock.release);
    child.unref();
    ctx.ui.notify(`${label} 인덱싱 시작: ${projectRoot}`, "info");
  } catch (error) {
    lock.release();
    ctx.ui.notify(
      `${label} 인덱싱 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
}

// MCP 설정에서 실제 CodeGraph CLI 실행 방법을 구한다. MCP 전용 serve.js가 등록된
// 경우에는 같은 Node bin 디렉터리의 codegraph 실행 파일을 사용한다.
// `status --json`으로 초기화 여부를 확인하고, 미초기화 프로젝트만
// 백그라운드에서 `init`(초기 인덱싱 포함)을 실행한다.
// 상태 확인 자체가 실패해도(=lib/graph-status.ts가 false 반환) 미초기화로 간주하고
// 진행한다. lock과 인덱서 자체의 중복 방지에 기대어 안전하다.
async function ensureCodegraphIndex(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  projectRoot: string,
  config: McpConfig,
): Promise<void> {
  const invocation = resolveCodegraphCli(config);
  if (invocation === undefined) return;

  const alreadyIndexed = await checkCodegraphIndexed(pi, projectRoot, config);
  if (alreadyIndexed) return;

  const lock = acquireLock("codegraph", projectRoot);
  if (lock === undefined) return;

  // init은 초기 인덱스 빌드까지 포함하므로 별도 index 명령은 필요 없다.
  spawnDetachedIndexer(
    ctx,
    lock,
    "CodeGraph",
    invocation.command,
    [...invocation.argsPrefix, "init"],
    projectRoot,
  );
}

// 세션이 시작될 때 신뢰된 Git 프로젝트에 대해서만 codegraph 인덱스를 확인한다.
// 프로젝트 로컬 파일을 읽는 작업이므로 Pi의 프로젝트 신뢰 승인을 우회하지 않는다.
async function autoIndex(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.isProjectTrusted()) return;

  const projectRoot = await findGitRoot(pi, ctx.cwd);
  if (projectRoot === undefined) return;

  const config = readMcpConfig();
  ctx.ui.setStatus("auto-index", "graph index 확인 중");

  try {
    await ensureCodegraphIndex(pi, ctx, projectRoot, config);
  } finally {
    ctx.ui.setStatus("auto-index", undefined);
  }
}

export default function autoIndexExtension(pi: ExtensionAPI) {
  // startup, reload, new, resume, fork 모두 이 이벤트를 거치지만 각 인덱서의
  // 상태 확인과 lock 덕분에 동일 프로젝트가 중복 인덱싱되지는 않는다.
  pi.on("session_start", async (_event, ctx) => {
    await autoIndex(pi, ctx);
  });
}
