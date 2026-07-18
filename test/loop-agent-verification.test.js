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

function createTestAgentRuntime(root, { status, exitCode, stdout = "", stderr = "" }) {
  return {
    runPiCommandWithProgress: async (_pi, _cwd, _ui, _label, args) => {
      const prompt = args.at(-1);
      assert.match(prompt, /실제 테스트를 실행하는 테스트 서브에이전트/);
      return {
        code: 0,
        finalText: [
          "테스트 서브에이전트 실행 보고",
          "<!-- loop-agent-test-verification:start -->",
          JSON.stringify({
            results: [
              {
                program: "npm",
                args: ["test"],
                cwd: root,
                timeoutMs: 15 * 60 * 1000,
                required: true,
                status,
                spawned: true,
                exitCode,
                signal: null,
                timeout: false,
                stdout,
                stderr,
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: 2,
              },
            ],
          }),
          "<!-- loop-agent-test-verification:end -->",
        ].join("\n"),
        stderr: "",
      };
    },
    killActiveChildren: () => 0,
  };
}

function testAgentConfig() {
  return {
    planningModel: null,
    codingModel: null,
    verifyingModel: null,
    testModel: "fake/test-model",
    planningThinkingLevel: null,
    codingThinkingLevel: null,
    verifyingThinkingLevel: null,
    testThinkingLevel: "high",
    maxImprovementRounds: 1,
  };
}

function testAgentContext(root) {
  return {
    cwd: root,
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
  };
}

test("loop-agent PASS follows the test subagent's structured exit result", async () => {
  const root = createProject("process.stdout.write('real test ran');\n");
  const module = await loadLoopAgent();
  const result = await module.runValidatedTestAgent(
    {},
    testAgentContext(root),
    "fixture checklist",
    testAgentConfig(),
    createTestAgentRuntime(root, {
      status: "PASS",
      exitCode: 0,
      stdout: "real test ran",
    }),
  );

  assert.equal(result.verification.status, "PASS");
  assert.equal(result.verification.requiredExecutedCount, 1);
  assert.equal(result.result.overall, "PASS");
  assert.match(result.report, /테스트 서브에이전트 실행 보고/);
  assert.match(result.report, /npm test: PASS/);
});

test("loop-agent cannot report PASS when the test subagent reports a non-zero exit", async () => {
  const root = createProject("process.stderr.write('real failure'); process.exit(3);\n");
  const module = await loadLoopAgent();
  const result = await module.runValidatedTestAgent(
    {},
    testAgentContext(root),
    "fixture checklist",
    testAgentConfig(),
    createTestAgentRuntime(root, {
      status: "FAIL",
      exitCode: 3,
      stderr: "real failure",
    }),
  );

  assert.equal(result.verification.status, "FAIL");
  assert.equal(result.verification.results[0].exitCode, 3);
  assert.equal(result.result.overall, "FAIL");
  assert.match(result.result.failedCommands[0].evidence, /real failure/);
});
