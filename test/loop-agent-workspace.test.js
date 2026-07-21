const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const WORKSPACE_MODULE = path.join(
  __dirname,
  "..",
  "extensions",
  "lib",
  "loop-agent-workspace.ts",
);

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
}

async function loadWorkspaceModule() {
  const imported = await import(
    `${pathToFileURL(WORKSPACE_MODULE).href}?workspace-test=${Math.random()}`,
  );
  return imported.default ?? imported;
}

function createGitProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-worktree-test-"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    [
      "runtime.txt",
      ".venv/",
      "sessions/",
      ".codegraph/",
      "docs/issues.sqlite*",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(root, "deleted.txt"), "delete me\n");
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["add", "tracked.txt", "deleted.txt", ".gitignore"]);
  runGit(root, [
    "-c",
    "user.name=loop-agent-test",
    "-c",
    "user.email=loop-agent-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return root;
}

test("clean Git projects use an isolated worktree and clean it up", async () => {
  const root = createGitProject();
  try {
    fs.writeFileSync(path.join(root, "runtime.txt"), "runtime\n");
    const { createParallelWorkspace } = await loadWorkspaceModule();
    let copied = false;
    const workspace = await createParallelWorkspace(root, "T-101", async () => {
      copied = true;
    }, (sourceRoot, worktreeRoot) => {
      fs.copyFileSync(
        path.join(sourceRoot, "runtime.txt"),
        path.join(worktreeRoot, "runtime.txt"),
      );
    });

    assert.equal(workspace.kind, "worktree");
    assert.equal(copied, false);
    assert.notEqual(workspace.root, root);
    assert.equal(fs.readFileSync(path.join(workspace.root, "tracked.txt"), "utf8"), "base\n");
    assert.equal(fs.readFileSync(path.join(workspace.root, "runtime.txt"), "utf8"), "runtime\n");

    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "worker\n");
    workspace.cleanup();
    assert.equal(fs.existsSync(workspace.root), false);
    assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "base\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dirty Git projects use the snapshot fallback", async () => {
  const root = createGitProject();
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty\n");
    const { createParallelWorkspace } = await loadWorkspaceModule();
    let copied = false;
    const workspace = await createParallelWorkspace(root, "T-102", async (sourceRoot, snapshotRoot) => {
      copied = true;
      fs.mkdirSync(snapshotRoot, { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, "tracked.txt"), path.join(snapshotRoot, "tracked.txt"));
    });

    assert.equal(workspace.kind, "snapshot");
    assert.equal(workspace.fallbackReason, "dirty");
    assert.equal(copied, true);
    assert.equal(fs.readFileSync(path.join(workspace.root, "tracked.txt"), "utf8"), "dirty\n");
    workspace.cleanup();
    assert.equal(fs.existsSync(workspace.root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clean worktrees expose only Git changes", async () => {
  const root = createGitProject();
  try {
    const { createParallelWorkspace, listGitWorktreeChanges } =
      await loadWorkspaceModule();
    const workspace = await createParallelWorkspace(root, "T-103", async () => {
      throw new Error("snapshot fallback should not be used");
    });

    assert.equal(workspace.kind, "worktree");
    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "worker\n");
    fs.writeFileSync(path.join(workspace.root, "added.txt"), "added\n");
    fs.rmSync(path.join(workspace.root, "deleted.txt"));

    assert.deepEqual(listGitWorktreeChanges(workspace.root), [
      { relativePath: "added.txt", kind: "add" },
      { relativePath: "deleted.txt", kind: "delete" },
      { relativePath: "tracked.txt", kind: "modify" },
    ]);
    workspace.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree runtime overlay copies only the explicit database allowlist", async () => {
  const root = createGitProject();
  try {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "issues.sqlite"), "db\n");
    fs.mkdirSync(path.join(root, ".venv"), { recursive: true });
    fs.writeFileSync(path.join(root, ".venv", "marker"), "large env\n");
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "old.jsonl"), "session\n");
    fs.mkdirSync(path.join(root, ".codegraph"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codegraph", "index"), "graph\n");

    const { copyWorktreeRuntimeFiles, createParallelWorkspace } =
      await loadWorkspaceModule();
    const workspace = await createParallelWorkspace(
      root,
      "T-104",
      async () => {
        throw new Error("snapshot fallback should not be used");
      },
      (sourceRoot, worktreeRoot) =>
        copyWorktreeRuntimeFiles(sourceRoot, worktreeRoot),
    );

    assert.equal(workspace.kind, "worktree");
    assert.equal(
      fs.readFileSync(
        path.join(workspace.root, "docs", "issues.sqlite"),
        "utf8",
      ),
      "db\n",
    );
    assert.equal(fs.existsSync(path.join(workspace.root, ".venv")), false);
    assert.equal(fs.existsSync(path.join(workspace.root, "sessions")), false);
    assert.equal(fs.existsSync(path.join(workspace.root, ".codegraph")), false);
    workspace.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
