import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ParallelWorkspaceKind = "worktree" | "snapshot";

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

let gitWorktreeMutationTail: Promise<void> = Promise.resolve();

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

async function withGitWorktreeMutation<T>(operation: () => T): Promise<T> {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = gitWorktreeMutationTail;
  gitWorktreeMutationTail = previous.then(() => turn);
  await previous;
  try {
    return operation();
  } finally {
    release();
  }
}

async function createGitWorktree(
  sourceRoot: string,
  workspaceRoot: string,
): Promise<boolean> {
  const result = await withGitWorktreeMutation(() =>
    runGit(sourceRoot, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      workspaceRoot,
      "HEAD",
    ]),
  );
  if (result.status === 0) return true;

  // A failed add can leave a directory behind, but must not be treated as a
  // usable worktree. The caller will use the snapshot fallback instead.
  removeTemporaryWorkspace(workspaceRoot);
  return false;
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
  const result = runGit(sourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (result.status !== 0) return "not-git";
  return result.stdout.trim() === "" ? "clean" : "dirty";
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
