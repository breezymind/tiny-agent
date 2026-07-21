const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "auto-index-agent-"));
const FAKE_CLI = path.join(AGENT_DIR, "fake-codegraph.js");
const AUTO_INDEX = path.join(__dirname, "..", "extensions", "auto-index.ts");
const LOCK_STALE_MS = 30 * 60 * 1000;
let autoIndexExtensionPromise;

fs.writeFileSync(
  FAKE_CLI,
  [
    "const fs = require('node:fs');",
    "const action = process.argv[2];",
    "if (action === 'init') {",
    "  fs.appendFileSync(process.env.AUTO_INDEX_TEST_LOG, 'init\\n');",
    "  setTimeout(() => process.exit(0), 400);",
    "}",
  ].join("\n") + "\n",
);
fs.writeFileSync(
  path.join(AGENT_DIR, ".mcp.json"),
  JSON.stringify({
    mcpServers: {
      codegraph: {
        command: process.execPath,
        args: [FAKE_CLI],
      },
    },
  }),
);

async function loadAutoIndexExtension() {
  if (!autoIndexExtensionPromise) {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
    autoIndexExtensionPromise = import(AUTO_INDEX).then(
      (module) => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        return module.default?.default ?? module.default;
      },
      (error) => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        throw error;
      },
    );
  }
  return autoIndexExtensionPromise;
}

function lockPathFor(projectRoot) {
  const key = crypto
    .createHash("sha256")
    .update(`codegraph:${fs.realpathSync(projectRoot)}`)
    .digest("hex")
    .slice(0, 20);
  return path.join(AGENT_DIR, ".auto-index", `${key}.lock`);
}

function readInitCount(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line === "init").length;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function createHarness(projectRoot) {
  const handlers = new Map();
  const notifications = [];
  const statuses = [];
  const execCalls = [];
  const pi = {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    async exec(command, args) {
      execCalls.push({ command, args });
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: '{"initialized":false}\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx = {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(name, value) {
        statuses.push({ name, value });
      },
    },
  };

  return {
    async install() {
      const autoIndexExtension = await loadAutoIndexExtension();
      autoIndexExtension(pi);
    },
    async start() {
      await handlers.get("session_start")({}, ctx);
    },
    handlers,
    notifications,
    statuses,
    execCalls,
  };
}

async function withLog(logPath, callback) {
  const previous = process.env.AUTO_INDEX_TEST_LOG;
  process.env.AUTO_INDEX_TEST_LOG = logPath;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.AUTO_INDEX_TEST_LOG;
    else process.env.AUTO_INDEX_TEST_LOG = previous;
  }
}

test("same project sessions start at most one auto-index process", async () => {
  const previousChildFlag = process.env.LOOP_AGENT_CHILD;
  delete process.env.LOOP_AGENT_CHILD;
  try {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-index-project-"));
    const logPath = path.join(projectRoot, "index.log");
    const harness = createHarness(projectRoot);
    await harness.install();

    await withLog(logPath, async () => {
      await Promise.all([harness.start(), harness.start()]);
      await waitFor(() => readInitCount(logPath) === 1, "the first index process did not start");
      assert.equal(readInitCount(logPath), 1);
      await waitFor(
        () => !fs.existsSync(lockPathFor(projectRoot)),
        "the auto-index lock was not released after the process exited",
      );
    });
  } finally {
    if (previousChildFlag === undefined) delete process.env.LOOP_AGENT_CHILD;
    else process.env.LOOP_AGENT_CHILD = previousChildFlag;
  }
});

test("a fresh lock remains authoritative and blocks a duplicate index", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-index-fresh-"));
  const logPath = path.join(projectRoot, "index.log");
  const lockPath = lockPathFor(projectRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "held");
  const freshTime = new Date(Date.now() - LOCK_STALE_MS + 1000);
  fs.utimesSync(lockPath, freshTime, freshTime);

  const harness = createHarness(projectRoot);
  await harness.install();
  await withLog(logPath, async () => {
    await harness.start();
    assert.equal(readInitCount(logPath), 0);
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test("a lock older than the stale threshold is reclaimed for indexing", async () => {
  const previousChildFlag = process.env.LOOP_AGENT_CHILD;
  delete process.env.LOOP_AGENT_CHILD;
  try {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-index-stale-"));
    const logPath = path.join(projectRoot, "index.log");
    const lockPath = lockPathFor(projectRoot);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "stale");
    const staleTime = new Date(Date.now() - LOCK_STALE_MS - 1000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const harness = createHarness(projectRoot);
    await harness.install();
    await withLog(logPath, async () => {
      await harness.start();
      await waitFor(() => readInitCount(logPath) === 1, "the stale lock was not reclaimed");
      assert.equal(readInitCount(logPath), 1);
      assert.equal(fs.readFileSync(lockPath, "utf8"), "");
      await waitFor(
        () => !fs.existsSync(lockPath),
        "the reclaimed auto-index lock was not released after the process exited",
      );
    });
  } finally {
    if (previousChildFlag === undefined) delete process.env.LOOP_AGENT_CHILD;
    else process.env.LOOP_AGENT_CHILD = previousChildFlag;
  }
});

test("coding child sessions skip automatic indexing", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-index-child-"));
  const harness = createHarness(projectRoot);
  await harness.install();

  const previousChildFlag = process.env.LOOP_AGENT_CHILD;
  process.env.LOOP_AGENT_CHILD = "1";
  try {
    await harness.start();
    assert.equal(harness.execCalls.length, 0);
    assert.equal(harness.notifications.length, 0);
  } finally {
    if (previousChildFlag === undefined) delete process.env.LOOP_AGENT_CHILD;
    else process.env.LOOP_AGENT_CHILD = previousChildFlag;
  }
});
