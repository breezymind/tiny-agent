const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOOP_AGENT = path.join(__dirname, "..", "extensions", "loop-agent.ts");
let loopAgentPromise;

async function loadLoopAgent() {
  loopAgentPromise ??= import(LOOP_AGENT).then(
    (module) => module.default ?? module,
  );
  return loopAgentPromise;
}

function createProject(testScript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-verification-"));
  fs.writeFileSync(path.join(root, "verification-script.js"), testScript);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "verification-fixture",
      private: true,
      scripts: { test: "node verification-script.js" },
    }),
  );
  return root;
}

test("loop-agent PASS is based on the real package test exit code", async () => {
  const root = createProject("process.stdout.write('real test ran');\n");
  const module = await loadLoopAgent();
  const result = await module.runValidatedTestAgent({}, { cwd: root }, "fixture checklist");

  assert.equal(result.verification.status, "PASS");
  assert.equal(result.verification.requiredExecutedCount, 1);
  assert.equal(result.result.overall, "PASS");
  assert.match(result.report, /결정적 검증 실행 결과/);
  assert.match(result.report, /npm test: PASS/);
});

test("loop-agent cannot report PASS when the real package test exits non-zero", async () => {
  const root = createProject("process.stderr.write('real failure'); process.exit(3);\n");
  const module = await loadLoopAgent();
  const result = await module.runValidatedTestAgent({}, { cwd: root }, "fixture checklist");

  assert.equal(result.verification.status, "FAIL");
  assert.equal(result.verification.results[0].exitCode, 3);
  assert.equal(result.result.overall, "FAIL");
  assert.match(result.result.failedCommands[0].evidence, /real failure/);
});
