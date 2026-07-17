const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "issue-store.js");
const { parseArgs, defaultEmbeddingPythonCandidates } = require(CLI);

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

function createFakeEmbedding(root, value = 0.25) {
  const fake = path.join(root, "fake-embedding.js");
  fs.writeFileSync(
    fake,
    "process.stdin.resume();\n" +
      `process.stdin.on('end', () => process.stdout.write(JSON.stringify({ embedding: Array(1024).fill(${value}) }) + '\\n'));\n`,
  );
  return fake;
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

test("default embedding python lookup checks the installed agent venv", () => {
  const root = path.join(os.tmpdir(), "target-project");
  const scriptDirectory = path.join(os.homedir(), ".pi", "agent", "scripts");
  const candidates = defaultEmbeddingPythonCandidates(root, scriptDirectory);

  assert.ok(candidates.includes(path.join(root, ".venv", "bin", "python")));
  assert.ok(candidates.includes(path.join(os.homedir(), ".pi", "agent", ".venv", "bin", "python")));
  assert.equal(candidates.includes(path.join(scriptDirectory, ".venv", "bin", "python")), false);
});

test("init creates an idempotent sqlite-vector issue and document store schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-init-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });

  const first = runCli(root, "init");
  const second = runCli(root, "init");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(fs.existsSync(path.join(root, "docs", "issues.sqlite")), true);
  assert.match(first.vector.version, /^\d+\.\d+\.\d+$/);
  assert.equal(first.vector.dimension, 1024);
  assert.deepEqual(first.schema, ["issues", "issue_blockers", "architecture_documents", "change_log"]);
  assert.deepEqual(second.schema, first.schema);
});

test("stores, updates, searches, and deletes architecture documents in SQLite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-architecture-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const fake = createFakeEmbedding(root);
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${fake}` };

  const context = runCli(
    root,
    "put-architecture",
    "--source-path",
    "context",
    "--doc-type",
    "context",
    "--heading",
    "Source of truth",
    "--body",
    "SQLite is authoritative.",
  );
  const adr = runCli(
    root,
    "put-adr",
    "--source-path",
    "adr/0001",
    "--heading",
    "Decision",
    "--body",
    "Use a local SQLite boundary.",
  );
  const document = runCli(
    root,
    "put-document",
    "--source-path",
    "research/image-composition",
    "--heading",
    "Image composition pattern",
    "--body",
    "Keep the image composition pattern in the SQLite document store.",
  );
  const updated = runCli(
    root,
    "put-architecture",
    "--source-path",
    "context",
    "--doc-type",
    "context",
    "--heading",
    "Source of truth",
    "--body",
    "SQLite is the only source of truth.",
  );
  const listed = runCli(root, "list-architecture");
  const listedAdrs = runCli(root, "list-architecture", "--doc-type", "adr");
  const listedDocs = runCli(root, "list-architecture", "--doc-type", "doc");
  const fetched = runCli(root, "get-architecture", "context", "0");
  const searched = runCli(root, "search-architecture", "source of truth", "--limit", "10");
  const deleted = runCli(root, "delete-architecture", "adr/0001", "0");

  delete globalThis.issueStoreTestEnv;
  assert.equal(context.document.doc_type, "context");
  assert.equal(adr.document.doc_type, "adr");
  assert.equal(document.document.doc_type, "doc");
  assert.equal(updated.document.body, "SQLite is the only source of truth.");
  assert.equal(listed.count, 3);
  assert.equal(listedAdrs.count, 1);
  assert.equal(listedDocs.count, 1);
  assert.equal(fetched.document.body, updated.document.body);
  assert.ok(searched.results.some((document) => document.source_path === "context"));
  assert.equal(deleted.deleted, true);
  assert.equal(runCli(root, "list-architecture").count, 2);
});

test("records and lists change history in SQLite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-changes-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const fake = createFakeEmbedding(root, 0.1);
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: `${process.execPath} ${fake}` };

  const issue = runCli(root, "create", "--title", "Tracked issue", "--body", "Issue body");
  const change = runCli(
    root,
    "record-change",
    "--date",
    "2026-07-17",
    "--summary",
    "SQLite change log 기록",
    "--issue",
    issue.issue_id,
  );
  const changes = runCli(root, "list-changes", "--issue", issue.issue_id);

  delete globalThis.issueStoreTestEnv;
  assert.equal(change.change.issue_id, issue.issue_id);
  assert.equal(change.change.change_date, "2026-07-17");
  assert.equal(changes.count, 1);
  assert.equal(changes.changes[0].summary, "SQLite change log 기록");
});

test("CRUD and vector search return stable issue metadata and ready-only results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-crud-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const fake = createFakeEmbedding(root, 0.1);
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
});

test("create keeps source text when embedding fails and reembed-failed repairs it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-store-reembed-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  globalThis.issueStoreTestEnv = { ISSUE_EMBEDDING_COMMAND: "/bin/sh -c 'exit 7'" };

  const failed = runCli(root, "create", "--title", "Unembedded issue", "--body", "Keep this source text");
  assert.equal(failed.embedding_status, "failed");
  assert.match(failed.body, /Keep this source text/);
  assert.match(failed.embedding_error, /실패했습니다/);

  const fake = createFakeEmbedding(root, 0.5);
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
