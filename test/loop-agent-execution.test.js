const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LOOP_AGENT = path.join(__dirname, "..", "extensions", "loop-agent.ts");

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createFakePiRuntime({ maxRounds = 2, reviewMode = "pass" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-execution-"));
  const agentDir = path.join(root, "agent");
  const binDir = path.join(root, "bin");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      loopAgent: {
        maxImprovementRounds: maxRounds,
        testModel: "fake/test-model",
      },
    }),
  );

  const reviewStatePath = path.join(root, "review-count");
  const fakePiPath = path.join(binDir, "pi");
  writeExecutable(
    fakePiPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const prompt = process.argv.at(-1) || "";
const reviewStatePath = process.env.FAKE_PI_REVIEW_STATE;
const mode = process.env.FAKE_PI_REVIEW_MODE || "pass";
let text = "fake coding agent completed";
if (prompt.includes("실제 테스트를 실행하는 테스트 서브에이전트")) {
  const specBlock = prompt.match(/실행할 검증 명령 목록\\(JSON\\):\\n([\\s\\S]*?)\\n\\n<!-- loop-agent-test-verification:start -->/);
  const specs = JSON.parse(specBlock[1]);
  const results = specs.map((spec) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const completed = spawnSync(spec.program, spec.args, {
      cwd: spec.cwd,
      encoding: "utf8",
      timeout: spec.timeoutMs,
    });
    const timedOut = completed.error?.code === "ETIMEDOUT";
    const spawned = completed.error?.code !== "ENOENT";
    const status = !spawned || completed.error
      ? "UNVERIFIED"
      : timedOut || completed.signal || completed.status !== 0
        ? "FAIL"
        : "PASS";
    return {
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      required: spec.required,
      status,
      spawned,
      exitCode: completed.status,
      signal: completed.signal,
      timeout: timedOut,
      stdout: completed.stdout || "",
      stderr: completed.stderr || "",
      ...(completed.error ? { error: completed.error.message } : {}),
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  });
  text = [
    "fake test subagent executed the verification commands",
    "<!-- loop-agent-test-verification:start -->",
    JSON.stringify({ results }),
    "<!-- loop-agent-test-verification:end -->",
  ].join("\\n");
} else if (prompt.includes("테스트 실패 원인 분석 에이전트")) {
  text = [
    "<!-- grill-review:start -->",
    JSON.stringify({
      overall: "FAIL",
      failedItems: [{
        item: "테스트 서브에이전트 검증 명령",
        reason: "fixture failure requires a code change",
        evidence: "fake Pi runtime",
      }],
    }),
    "<!-- grill-review:end -->",
  ].join("\\n");
} else if (prompt.includes("검수 체크리스트:")) {
  let count = 0;
  if (reviewStatePath) {
    count = Number(fs.existsSync(reviewStatePath) ? fs.readFileSync(reviewStatePath, "utf8") : "0");
    fs.writeFileSync(reviewStatePath, String(count + 1));
  }
  const shouldFail = mode === "always-fail" || (mode === "fail-once" && count === 0);
  text = shouldFail
    ? [
        "<!-- grill-review:start -->",
        JSON.stringify({
          overall: "FAIL",
          failedItems: [{
            item: "fixture checklist",
            reason: "fake review requires an improvement round",
            evidence: "fake Pi runtime",
          }],
        }),
        "<!-- grill-review:end -->",
      ].join("\\n")
    : [
        "<!-- grill-review:start -->",
        JSON.stringify({ overall: "PASS", failedItems: [] }),
        "<!-- grill-review:end -->",
      ].join("\\n");
}
process.stdout.write(JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", content: [{ type: "text", text }] }],
}) + "\\n");
`,
  );

  const entries = [];
  const messages = [];
  const notifications = [];
  const statuses = [];
  const pi = {
    appendEntry(type, payload) {
      entries.push({ type, payload });
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const ctx = {
    cwd: projectRoot,
    isIdle: () => true,
    model: { provider: "fake", id: "fake" },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(label, message) {
        statuses.push({ label, message });
      },
    },
  };

  return {
    root,
    agentDir,
    binDir,
    projectRoot,
    reviewStatePath,
    pi,
    ctx,
    entries,
    messages,
    notifications,
    statuses,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function loadLoopAgent(runtime) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = runtime.agentDir;
  try {
    const imported = await import(`${pathToFileURL(LOOP_AGENT).href}?execution-test=${Math.random()}`);
    return imported.default ?? imported;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

async function runWorkflow(runtime, { verificationScript, reviewMode = "pass", checklist = "fixture checklist" } = {}) {
  const previousPath = process.env.PATH;
  const previousVerification = process.env.PI_VERIFICATION_COMMANDS;
  const previousReviewMode = process.env.FAKE_PI_REVIEW_MODE;
  const previousReviewState = process.env.FAKE_PI_REVIEW_STATE;
  process.env.PATH = `${runtime.binDir}${path.delimiter}${previousPath || ""}`;
  process.env.PI_VERIFICATION_COMMANDS = JSON.stringify([
    {
      program: process.execPath,
      args: [verificationScript],
      cwd: runtime.projectRoot,
      timeoutMs: 5000,
      required: true,
    },
  ]);
  process.env.FAKE_PI_REVIEW_MODE = reviewMode;
  process.env.FAKE_PI_REVIEW_STATE = runtime.reviewStatePath;

  try {
    const module = await loadLoopAgent(runtime);
    const workflowId = module.reserveWorkflow(true, "awaiting-execution", checklist);
    await module.runExecutionReviewLoop(runtime.pi, runtime.ctx, workflowId, "initial coding prompt");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousVerification === undefined) delete process.env.PI_VERIFICATION_COMMANDS;
    else process.env.PI_VERIFICATION_COMMANDS = previousVerification;
    if (previousReviewMode === undefined) delete process.env.FAKE_PI_REVIEW_MODE;
    else process.env.FAKE_PI_REVIEW_MODE = previousReviewMode;
    if (previousReviewState === undefined) delete process.env.FAKE_PI_REVIEW_STATE;
    else process.env.FAKE_PI_REVIEW_STATE = previousReviewState;
  }
}

function createVerificationScript(runtime, mode) {
  const scriptPath = path.join(runtime.projectRoot, "verification.js");
  const attemptsPath = path.join(runtime.root, "verification-attempts");
  fs.writeFileSync(
    scriptPath,
    `const fs = require("node:fs");
const path = ${JSON.stringify(attemptsPath)};
const attempts = Number(fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "0") + 1;
fs.writeFileSync(path, String(attempts));
process.exit(${JSON.stringify(mode)} === "fail-once" && attempts === 1 ? 1 : 0);
`,
  );
  return scriptPath;
}

function stateReasons(runtime) {
  return runtime.entries
    .filter((entry) => entry.type === "loop-agent-state")
    .map((entry) => entry.payload.reason);
}

function messageTypes(runtime) {
  return runtime.messages.map(({ message }) => message.customType).filter(Boolean);
}

test("planning checklist boundaries are strict but unwrapped checkbox output is repairable", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const workflowId = "6309f46f-a840-4a5d-9a0c-cd6ab30b8480";
    const unwrapped = [
      "<!-- loop-agent-implementation-summary:end -->",
      `<!-- loop-agent-workflow:${workflowId} -->`,
      "최종 목표 체크리스트",
      "- [ ] 첫 번째 완료 조건",
      "- [ ] 두 번째 완료 조건",
    ].join("\n");

    assert.equal(module.extractChecklist(unwrapped), null);
    assert.match(
      module.extractUnwrappedChecklist(unwrapped),
      /첫 번째 완료 조건/,
    );
    assert.match(
      module.extractUnwrappedChecklist(unwrapped),
      /SQLite에서 검색한 아키텍처 문서/,
    );
    assert.match(
      module.buildChecklistFormatRepairPrompt(workflowId),
      /<!-- grill-checklist:start -->[\s\S]*<!-- grill-checklist:end -->/,
    );
  } finally {
    runtime.cleanup();
  }
});

test("grilling gate requires an interview turn, a user response, and one completion marker", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const baseState = {
      grillingRequired: true,
      grillingQuestionCount: 1,
      grillingUserResponseCount: 1,
    };
    const marker = "<!-- loop-agent-grilling:complete -->";

    assert.equal(module.hasGrillingCompletionEvidence(baseState, "final plan"), false);
    assert.equal(
      module.hasGrillingCompletionEvidence(baseState, `final plan\n${marker}`),
      true,
    );
    assert.equal(
      module.hasGrillingCompletionEvidence(baseState, `final plan\n${marker}\n${marker}`),
      false,
    );
    assert.equal(
      module.hasGrillingCompletionEvidence(
        { ...baseState, grillingQuestionCount: 0 },
        `final plan\n${marker}`,
      ),
      false,
    );
    assert.equal(
      module.hasGrillingCompletionEvidence(
        { ...baseState, grillingRequired: false },
        "L0 direct plan",
      ),
      true,
    );
  } finally {
    runtime.cleanup();
  }
});

test("grilling recovery carries the next user input without injecting a concurrent turn", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const prompt = module.buildGrillingResumePrompt(
      "workflow-grilling",
      "계속 진행해",
    );

    assert.match(prompt, /workflow-grilling/);
    assert.match(prompt, /계속 진행해/);
    assert.match(prompt, /그 응답에서는 체크리스트 경계를 출력하지 마세요/);
    assert.match(prompt, /loop-agent-grilling:complete/);
    assert.equal(runtime.messages.length, 0);
  } finally {
    runtime.cleanup();
  }
});

test("architecture guidance routes every durable document to SQLite", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const guidance = module.buildArchitectureReadGuidance(runtime.projectRoot);

    assert.match(guidance, /put-adr/);
    assert.match(guidance, /put-document/);
    assert.match(guidance, /PRD·이슈는 issue-store의 create\/get\/update-status/);
    assert.match(guidance, /프로젝트 Markdown 파일을 생성·수정하지 말고/);
  } finally {
    runtime.cleanup();
  }
});

test("coding handoff keeps only the bounded implementation summary and selected task summaries", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const planningResponse = [
      "long planning preamble that must not reach the coding agent",
      "x".repeat(5000),
      "<!-- loop-agent-implementation-summary:start -->",
      "- Edit the settings flow.",
      "- Run the focused test.",
      "<!-- loop-agent-implementation-summary:end -->",
      "<!-- grill-checklist:start -->",
      "- [ ] focused checklist",
      "<!-- grill-checklist:end -->",
    ].join("\n");

    const handoff = module.buildCodingHandoffContext(
      planningResponse,
      "- [ ] focused checklist",
      [{ id: "T-201", title: "Settings flow", summary: "Keep this task summary" }],
    );

    assert.match(handoff, /Edit the settings flow/);
    assert.match(handoff, /T-201: Settings flow/);
    assert.match(handoff, /Keep this task summary/);
    assert.doesNotMatch(handoff, /long planning preamble/);
    assert.doesNotMatch(handoff, /x{1000}/);
  } finally {
    runtime.cleanup();
  }
});

test("review parser rejects contradictory PASS results", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    assert.throws(
      () =>
        module.extractReviewResult(
          [
            "<!-- grill-review:start -->",
            JSON.stringify({
              overall: "PASS",
              failedItems: [
                { item: "fixture", reason: "still failing", evidence: "test" },
              ],
            }),
            "<!-- grill-review:end -->",
          ].join("\n"),
        ),
      /PASS 판정에 실패 항목이 포함되어 있습니다/,
    );
  } finally {
    runtime.cleanup();
  }
});

test("snapshot filtering excludes common credential files", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    assert.equal(module.shouldSkipSnapshotPath(".env.local"), true);
    assert.equal(module.shouldSkipSnapshotPath(".mcp.json"), true);
    assert.equal(module.shouldSkipSnapshotPath("certs/client.pem"), true);
    assert.equal(module.shouldSkipSnapshotPath("ios/Pods/Manifest.lock"), true);
    assert.equal(module.shouldSkipSnapshotPath("android/.gradle/cache.bin"), true);
    assert.equal(module.shouldSkipSnapshotPath("src/auth.ts"), false);
  } finally {
    runtime.cleanup();
  }
});

test("resume restores a persisted coding prompt instead of skipping coding", async () => {
  const runtime = createFakePiRuntime();
  const previousPath = process.env.PATH;
  const previousVerification = process.env.PI_VERIFICATION_COMMANDS;
  try {
    const module = await loadLoopAgent(runtime);
    const verificationScript = createVerificationScript(runtime, "pass");
    process.env.PATH = `${runtime.binDir}${path.delimiter}${previousPath || ""}`;
    process.env.PI_VERIFICATION_COMMANDS = JSON.stringify([
      {
        program: process.execPath,
        args: [verificationScript],
        cwd: runtime.projectRoot,
        timeoutMs: 5000,
        required: true,
      },
    ]);
    const workflowId = "resume-workflow";
    const restored = module.restoreWorkflowState({
      ...runtime.ctx,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "loop-agent-state",
            data: {
              snapshot: {
                reviewStage: "awaiting-execution",
                checklist: "resume checklist",
                pendingCodingPrompt: "resume coding prompt",
                lastFailure: {
                  source: "review",
                  items: [
                    { item: "fixture", reason: "failed", evidence: "saved" },
                  ],
                },
                improvementRound: 1,
                autoMode: true,
                autoReview: false,
                workflowId,
              },
            },
          },
        ],
      },
    });
    assert.equal(restored, true);

    await module.runExecutionReviewLoop(runtime.pi, runtime.ctx, workflowId);

    assert.equal(
      runtime.entries.filter((entry) => entry.type === "loop-agent-coding-result").length,
      1,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousVerification === undefined) delete process.env.PI_VERIFICATION_COMMANDS;
    else process.env.PI_VERIFICATION_COMMANDS = previousVerification;
    runtime.cleanup();
  }
});

test("fake Pi runtime traverses coding, testing, review, and completion stages", async () => {
  const runtime = createFakePiRuntime();
  try {
    const verificationScript = createVerificationScript(runtime, "pass");
    await runWorkflow(runtime, { verificationScript });

    assert.deepEqual(stateReasons(runtime), [
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "completed",
    ]);
    assert.deepEqual(messageTypes(runtime), [
      "loop-agent-coding-result",
      "loop-agent-test-result",
      "loop-agent-review",
    ]);
    assert.equal(runtime.entries.filter((entry) => entry.type === "loop-agent-review").length, 1);
    assert.equal(runtime.entries.at(-1).payload.snapshot.workflowId, null);
  } finally {
    runtime.cleanup();
  }
});

test("fake Pi runtime schedules a review failure for one improvement round", async () => {
  const runtime = createFakePiRuntime({ reviewMode: "fail-once", maxRounds: 2 });
  try {
    const verificationScript = createVerificationScript(runtime, "pass");
    await runWorkflow(runtime, { verificationScript, reviewMode: "fail-once" });

    assert.deepEqual(stateReasons(runtime), [
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "improvement-scheduled",
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "completed",
    ]);
    const reviews = runtime.entries.filter((entry) => entry.type === "loop-agent-review");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].payload.result.overall, "FAIL");
    assert.equal(reviews[1].payload.result.overall, "PASS");
    const scheduled = runtime.entries.find(
      (entry) =>
        entry.type === "loop-agent-state" &&
        entry.payload.reason === "improvement-scheduled",
    );
    assert.match(scheduled.payload.snapshot.pendingCodingPrompt, /자동 개선/);
    assert.equal(scheduled.payload.snapshot.lastFailure.source, "review");
  } finally {
    runtime.cleanup();
  }
});

test("fake Pi runtime stops when the review reaches the maximum round", async () => {
  const runtime = createFakePiRuntime({ reviewMode: "always-fail" });
  try {
    const verificationScript = createVerificationScript(runtime, "pass");
    await runWorkflow(runtime, { verificationScript, reviewMode: "always-fail" });

    assert.deepEqual(stateReasons(runtime), [
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "improvement-scheduled",
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "improvement-scheduled",
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "max-rounds-reached",
    ]);
    assert.equal(runtime.entries.filter((entry) => entry.type === "loop-agent-coding-result").length, 3);
    assert.equal(runtime.entries.at(-1).payload.snapshot.workflowId, null);
  } finally {
    runtime.cleanup();
  }
});

test("fake Pi runtime diagnoses a test failure and resumes from recovery", async () => {
  const runtime = createFakePiRuntime({ maxRounds: 1 });
  try {
    const verificationScript = createVerificationScript(runtime, "fail-once");
    await runWorkflow(runtime, { verificationScript });

    assert.deepEqual(stateReasons(runtime), [
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "test-failure-diagnosis-started",
      "test-failure-improvement-scheduled",
      "coding-started",
      "coding-completed",
      "testing-started",
      "testing-completed",
      "review-started",
      "completed",
    ]);
    assert.equal(
      runtime.entries.filter((entry) => entry.type === "loop-agent-test-result").length,
      2,
    );
    assert.equal(
      runtime.entries.filter((entry) => entry.type === "loop-agent-test-failure-diagnosis").length,
      1,
    );
    assert.match(
      runtime.notifications.map((item) => item.message).join("\n"),
      /테스트 실패 원인을 planningModel로 분석합니다/,
    );
  } finally {
    runtime.cleanup();
  }
});

test("stale workflow IDs never enter the fake Pi runtime", async () => {
  const runtime = createFakePiRuntime();
  try {
    const module = await loadLoopAgent(runtime);
    const staleWorkflowId = module.reserveWorkflow(true, "awaiting-execution", "stale checklist");
    module.reserveWorkflow(true, "awaiting-execution", "current checklist");
    await module.runExecutionReviewLoop(runtime.pi, runtime.ctx, staleWorkflowId, "stale prompt");

    assert.deepEqual(runtime.entries, []);
    assert.deepEqual(runtime.messages, []);
  } finally {
    runtime.cleanup();
  }
});
