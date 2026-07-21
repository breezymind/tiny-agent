import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ParallelWorkspaceKind = "worktree" | "snapshot";

export type ParallelWorkspaceChange = {
  relativePath: string;
  kind: "add" | "modify" | "delete";
};

// Pi 자식 프로세스는 PI_CODING_AGENT_DIR를 통해 전역 runtime 파일을 직접
// 읽는다. worktree 안에서 별도로 필요한 프로젝트 로컬 상태는 issue-store DB
// 뿐이므로, 여기에 없는 ignored 파일(.venv, sessions, .codegraph 등)은
// worktree로 복사하지 않는다.
export const WORKTREE_RUNTIME_FILES = [
  "docs/issues.sqlite",
  "docs/issues.sqlite-wal",
  "docs/issues.sqlite-shm",
  "docs/issues.sqlite-journal",
] as const;

export type ParallelWorkspace = {
  root: string;
  kind: ParallelWorkspaceKind;
  fallbackReason?: "dirty" | "not-git" | "worktree-unavailable";
  cleanup: () => void;
};

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

// 동시 git worktree add는 같은 .git 디렉터리 lock과 경합하므로
// 한 번에 하나만 허용한다. 대기하지 않고 즉시 snapshot으로 fallback.
let gitWorktreeInProgress = false;

function runGit(sourceRoot: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function readGitStatus(sourceRoot: string): string | null {
  const result = runGit(sourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return result.status === 0 ? result.stdout : null;
}

export function listGitWorktreeChanges(
  worktreeRoot: string,
): ParallelWorkspaceChange[] {
  const status = readGitStatus(worktreeRoot);
  if (status === null) {
    throw new Error(`Git 변경 목록을 읽을 수 없습니다: ${worktreeRoot}`);
  }

  const changes = new Map<string, ParallelWorkspaceChange>();
  const addChange = (
    relativePath: string,
    kind: ParallelWorkspaceChange["kind"],
  ): void => {
    if (!relativePath) return;
    changes.set(relativePath, { relativePath, kind });
  };

  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const statusCode = line.slice(0, 2);
    const rawPath = line.slice(3);
    const renameSeparator = rawPath.indexOf(" -> ");
    if (renameSeparator >= 0) {
      addChange(rawPath.slice(0, renameSeparator), "delete");
      addChange(rawPath.slice(renameSeparator + 4), "add");
      continue;
    }

    const kind: ParallelWorkspaceChange["kind"] =
      statusCode.includes("D")
        ? "delete"
        : statusCode.includes("A") || statusCode === "??"
          ? "add"
          : "modify";
    addChange(rawPath, kind);
  }

  return Array.from(changes.values()).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

export function copyWorktreeRuntimeFiles(
  sourceRoot: string,
  worktreeRoot: string,
): void {
  for (const relativePath of WORKTREE_RUNTIME_FILES) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) continue;

    const destinationPath = path.join(worktreeRoot, relativePath);
    if (fs.existsSync(destinationPath)) continue;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function temporaryWorkspacePath(taskId: string): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]+/g, "-") || "task";
  return path.join(
    os.tmpdir(),
    `loop-agent-${safeTaskId}-${randomUUID()}`,
  );
}

function removeTemporaryWorkspace(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

async function createGitWorktree(
  sourceRoot: string,
  workspaceRoot: string,
): Promise<boolean> {
  // 동시 git worktree add는 .git 내부 lock 충돌을 일으키므로,
  // 이미 진행 중이면 대기 없이 즉시 false를 반환해 snapshot으로 fallback한다.
  if (gitWorktreeInProgress) return false;
  gitWorktreeInProgress = true;
  try {
    const result = runGit(sourceRoot, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      workspaceRoot,
      "HEAD",
    ]);
    if (result.status === 0) return true;

    // A failed add can leave a directory behind, but must not be treated as a
    // usable worktree. The caller will use the snapshot fallback instead.
    removeTemporaryWorkspace(workspaceRoot);
    return false;
  } finally {
    gitWorktreeInProgress = false;
  }
}

function cleanupGitWorktree(sourceRoot: string, workspaceRoot: string): void {
  const result = runGit(sourceRoot, [
    "worktree",
    "remove",
    "--force",
    "--quiet",
    workspaceRoot,
  ]);
  if (result.status !== 0) {
    // Cleanup is best effort for an exact, newly-created temporary path. The
    // worktree registration may remain and will be pruned by Git later.
    removeTemporaryWorkspace(workspaceRoot);
  }
}

function getGitWorktreeStatus(sourceRoot: string): "clean" | "dirty" | "not-git" {
  const status = readGitStatus(sourceRoot);
  if (status === null) return "not-git";
  return status.trim() === "" ? "clean" : "dirty";
}

export async function createParallelWorkspace(
  sourceRoot: string,
  taskId: string,
  copySnapshot: (sourceRoot: string, snapshotRoot: string) => Promise<void>,
  prepareWorktree: (
    sourceRoot: string,
    worktreeRoot: string,
  ) => Promise<void> | void = () => undefined,
): Promise<ParallelWorkspace> {
  const workspaceRoot = temporaryWorkspacePath(taskId);
  const gitStatus = getGitWorktreeStatus(sourceRoot);

  if (gitStatus === "clean") {
    if (await createGitWorktree(sourceRoot, workspaceRoot)) {
      try {
        await prepareWorktree(sourceRoot, workspaceRoot);
        return {
          root: workspaceRoot,
          kind: "worktree",
          cleanup: () => cleanupGitWorktree(sourceRoot, workspaceRoot),
        };
      } catch {
        cleanupGitWorktree(sourceRoot, workspaceRoot);
      }
    }
  }

  const fallbackReason =
    gitStatus === "dirty"
      ? "dirty"
      : gitStatus === "not-git"
        ? "not-git"
        : "worktree-unavailable";
  try {
    await copySnapshot(sourceRoot, workspaceRoot);
  } catch (error) {
    removeTemporaryWorkspace(workspaceRoot);
    throw error;
  }

  return {
    root: workspaceRoot,
    kind: "snapshot",
    fallbackReason,
    cleanup: () => removeTemporaryWorkspace(workspaceRoot),
  };
}
