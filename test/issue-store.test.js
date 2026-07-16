const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "issue-store.js");
const { parseArgs } = require(CLI);

function runCli(cwd, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ISSUE_STORE_DB_PATH: path.join(cwd, "docs", "issues.sqlite"),
      ...(globalThis.issueStoreTestEnv || {}),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("issue-store progress diagnostics stay on stderr", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-progress-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ISSUE_STORE_DB_PATH: path.join(root, "docs", "issues.sqlite"),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /SQLite 저장소를 엽니다/);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("hyphenated CLI options map to the camelCase embedding and blocker fields", () => {
  const options = parseArgs([
    "create",
    "--embedding-command",
    "python3 scripts/issue-embedding.py",
    "--blocked-by",
    "T-100,T-101",
  ]);

  assert.equal(options.embeddingCommand, "python3 scripts/issue-embedding.py");
  assert.equal(options["embedding-command"], options.embeddingCommand);
  assert.equal(options.blockedBy, "T-100,T-101");
});

test("init creates an idempotent sqlite-vector issue store schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-init-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });

  const first = runCli(root, "init");
  const second = runCli(root, "init");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(fs.existsSync(path.join(root, "docs", "issues.sqlite")), true);
  assert.match(first.vector.version, /^\d+\.\d+\.\d+$/);
  assert.equal(first.vector.dimension, 1024);
  assert.deepEqual(first.schema, ["issues", "issue_blockers"]);
  assert.deepEqual(second.schema, first.schema);
});

test("migrate imports Markdown issue blocks once and preserves relationships", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-migrate-"));
  fs.mkdirSync(path.join(root, "docs", "tasks", "archive"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "tasks", "backlog.md"),
    [
      "# Backlog",
      "",
      "### T-100 [ready-for-agent] Parent issue (PRD)",
      "",
      "**Status:** backlog",
      "",
      "## Parent",
      "",
      "- None - can start immediately",
      "",
      "## What to build",
      "",
      "The parent body.",
      "",
      "### T-101 [ready-for-agent] Child issue",
      "",
      "**Status:** backlog",
      "",
      "## Parent",
      "",
      "- T-100",
      "",
      "## Blocked by",
      "",
      "- T-100",
      "",
      "## What to build",
      "",
      "The child body.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "docs", "tasks", "archive", "2026-06.md"),
    [
      "# Done",
      "",
      "### T-099 [ready-for-agent] Completed issue",
      "",
      "**Status:** done",
      "",
      "Completed body.",
      "",
    ].join("\n"),
  );
  const fake = path.join(root, "fake-embedding.js");
  fs.writeFileSync(
    fake,
    "let input = '';\n" +
      "process.stdin.on('data', (chunk) => { input += chunk; });\n" +
      "process.stdin.on('end', () => {\n" +
      "  const count = input.trim().split(/\\r?\\n/).filter(Boolean).length;\n" +
      "  process.stdout.write(Array.from({ length: count }, () => JSON.stringify({ embedding: Array(1024).fill(0.25) })).join('\\n') + '\\n');\n" +
      "});\n",
  );
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${fake}` };

  const first = runCli(root, "migrate");
  const second = runCli(root, "migrate");
  const list = runCli(root, "list");
  const created = runCli(root, "create", "--title", "Next issue", "--body", "Created body", "--label", "ready-for-agent");
  const child = runCli(root, "get", "T-101");

  delete globalThis.issueStoreTestEnv;
  assert.equal(first.count, 3);
  assert.equal(second.count, 0);
  assert.equal(list.count, 3);
  assert.equal(list.issues.find((issue) => issue.issue_id === "T-099").status, "done");
  assert.deepEqual(child.issue.blockedBy, ["T-100"]);
  assert.equal(child.issue.parent, "T-100");
  assert.match(child.issue.body, /The child body/);
  assert.equal(created.issue_id, "T-102");
  assert.equal(created.embedding_status, "ready");
});

test("migrate fails before writing when any embedding fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-migrate-fail-"));
  fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "tasks", "backlog.md"),
    "# Backlog\n\n### T-100 [ready-for-agent] Must embed\n\n**Status:** backlog\n\nBody.\n",
  );
  const failingEmbedding = path.join(root, "failing-embedding.js");
  fs.writeFileSync(failingEmbedding, "process.exit(7);\n");

  const result = spawnSync(process.execPath, [CLI, "migrate"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ISSUE_STORE_DB_PATH: path.join(root, "docs", "issues.sqlite"),
      ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${failingEmbedding}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(JSON.parse(result.stdout).error, /T-100/);
  assert.equal(fs.existsSync(path.join(root, "docs", "issues.sqlite")), false);
  assert.match(fs.readFileSync(path.join(root, "docs", "tasks", "backlog.md"), "utf8"), /T-100/);
});

test("CRUD and vector search return stable issue metadata and ready-only results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-crud-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const fake = path.join(root, "fake-embedding.js");
  fs.writeFileSync(
    fake,
    "process.stdin.resume();\n" +
      "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ embedding: Array(1024).fill(0.1) }) + '\\n'));\n",
  );
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${fake}` };

  const parent = runCli(root, "create", "--title", "Searchable parent (PRD)", "--body", "Parent PRD document", "--label", "ready-for-agent");
  const child = runCli(root, "create", "--title", "Searchable child", "--body", "Child document", "--label", "ready-for-agent", "--parent", parent.issue_id);
  runCli(root, "update-status", child.issue_id, "current");
  const filtered = runCli(root, "list", "--status", "current", "--label", "ready-for-agent", "--parent", parent.issue_id);
  const search = runCli(root, "search", "semantic query", "--limit", "10");
  const fetched = runCli(root, "get", child.issue_id);

  delete globalThis.issueStoreTestEnv;
  assert.equal(filtered.count, 1);
  assert.equal(filtered.issues[0].issue_id, child.issue_id);
  assert.equal(fetched.issue.status, "current");
  assert.equal(fetched.issue.parent, parent.issue_id);
  assert.equal(search.results.length, 2);
  assert.ok(search.results.every((issue) => issue.embedding_status === "ready"));
  assert.ok(search.results.every((issue) => issue.issue_id !== "T-999"));
});

test("create keeps source text when embedding fails and reembed-failed repairs it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-reembed-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: "/bin/sh -c 'exit 7'" };

  const failed = runCli(root, "create", "--title", "Unembedded issue", "--body", "Keep this source text");
  assert.equal(failed.embedding_status, "failed");
  assert.match(failed.body, /Keep this source text/);
  assert.match(failed.embedding_error, /실패했습니다/);

  const fake = path.join(root, "fake-embedding.js");
  fs.writeFileSync(
    fake,
    "process.stdin.resume();\n" +
      "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ embedding: Array(1024).fill(0.5) }) + '\\n'));\n",
  );
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${fake}` };
  const retried = runCli(root, "reembed-failed");
  const repaired = runCli(root, "get", failed.issue_id);

  delete globalThis.issueStoreTestEnv;
  assert.equal(retried.count, 1);
  assert.equal(retried.issues[0].embedding_status, "ready");
  assert.equal(repaired.issue.embedding_status, "ready");
  assert.equal(repaired.issue.embedding_bytes, 4096);
  assert.equal(repaired.issue.body, "Keep this source text");
});
