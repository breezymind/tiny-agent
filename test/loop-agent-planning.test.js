const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDirectCodingPrompt,
  buildPlanningPipelinePrompt,
  findMissingPipelinePrerequisite,
  preparePlanningPipeline,
  runRequiredSemanticSearch,
} = require("../extensions/lib/loop-agent-planning.ts");

const semanticContext = {
  query: "add feature",
  results: [{ issue_id: "T-1", title: "existing issue", status: "ready" }],
  architectureResults: [
    { source_path: "docs/adr/001.md", heading: "Boundary", doc_type: "adr" },
  ],
};

test("planning prompt builders preserve checklist, architecture, and workflow markers", () => {
  const promptDependencies = {
    skillPath: (name) => `/agent/skills/${name}/SKILL.md`,
    buildArchitectureReadGuidance: (root) => `architecture:${root}`,
    buildImplementSkillGuidance: (root) => `implement:${root}`,
    buildTaskTrackingInstructions: (root) => `tracking:${root}`,
    shortenStatusLine: (text, maxLength) => text.slice(0, maxLength),
  };

  const direct = buildDirectCodingPrompt(
    "add feature",
    "/project",
    promptDependencies,
    semanticContext,
  );
  const planning = buildPlanningPipelinePrompt(
    "add feature",
    "workflow-1",
    "/project",
    semanticContext,
    promptDependencies,
  );

  assert.match(direct.checklist, /아키텍처/);
  assert.match(direct.prompt, /existing issue/);
  assert.match(planning, /loop-agent-workflow:workflow-1/);
  assert.match(planning, /grill-checklist/);
  assert.match(planning, /docs\/adr\/001\.md/);
});

test("L0 direct prompts omit search results and issue tracking context", () => {
  const promptDependencies = {
    skillPath: (name) => `/agent/skills/${name}/SKILL.md`,
    buildArchitectureReadGuidance: (root) => `architecture:${root}`,
    buildImplementSkillGuidance: () => "full implement guidance",
    buildMinimalImplementSkillGuidance: () => "minimal implement guidance",
    buildTaskTrackingInstructions: () => "tracking guidance",
    shortenStatusLine: (text, maxLength) => text.slice(0, maxLength),
  };

  const direct = buildDirectCodingPrompt(
    "설정에서 피드백쓰기 메뉴를 제거해",
    "/project",
    promptDependencies,
    semanticContext,
    { complexity: "L0" },
  );

  assert.match(direct.prompt, /<loop-agent-context tier="L0">/);
  assert.match(direct.prompt, /minimal implement guidance/);
  assert.doesNotMatch(direct.prompt, /existing issue/);
  assert.doesNotMatch(direct.prompt, /tracking guidance/);
  assert.doesNotMatch(direct.prompt, /loop-agent-semantic-context/);
});

test("L1 planning prompts use focused context without full pipeline skills", () => {
  const prompt = buildPlanningPipelinePrompt(
    "설정 화면의 국소 UI를 조정한다",
    "workflow-1",
    "/project",
    { query: "설정 화면의 국소 UI를 조정한다", results: [], architectureResults: [] },
    {
      skillPath: (name) => `/agent/skills/${name}/SKILL.md`,
      buildArchitectureReadGuidance: (root) => `architecture:${root}`,
    },
    "L1",
  );

  assert.match(prompt, /grill-checklist/);
  assert.doesNotMatch(prompt, /to-prd/);
  assert.doesNotMatch(prompt, /to-issues/);
  assert.doesNotMatch(prompt, /loop-agent-semantic-context/);
  assert.doesNotMatch(prompt, /architecture-search-gate/);
});

test("planning prerequisite lookup and controller orchestration are dependency-injected", async () => {
  const checked = [];
  const missing = findMissingPipelinePrerequisite(
    (name) => `/skills/${name}`,
    ["grill-with-docs", "to-prd"],
    (filePath) => {
      checked.push(filePath);
      if (filePath === "/skills/to-prd") throw new Error("missing");
    },
  );
  assert.equal(missing, "/skills/to-prd");
  assert.deepEqual(checked, [
    "/skills/grilling",
    "/skills/domain-modeling",
    "/skills/grill-with-docs",
    "/skills/to-prd",
  ]);

  const calls = [];
  const ctx = {
    cwd: "/project",
    ui: { notify: (message) => calls.push(`notify:${message}`) },
  };
  const pi = {};
  const result = await preparePlanningPipeline(
    pi,
    ctx,
    "add feature",
    { explicit: true, autoReview: true },
    {
      ensureWorkflowWorkspace: () => true,
      findMissingPipelinePrerequisite: () => null,
      reserveWorkflow: () => {
        calls.push("reserve");
        return "workflow-1";
      },
      runRequiredSemanticSearch: async () => {
        calls.push("search");
        return semanticContext;
      },
      isCurrentWorkflow: () => true,
      persistWorkflowState: (_pi, reason) => calls.push(`persist:${reason}`),
      releaseWorkflowIfCurrent: (_pi, _workflowId, reason) => calls.push(`release:${reason}`),
      selectModel: async () => {
        calls.push("select-model");
        return true;
      },
      workflowConfig: { planningModel: null, planningThinkingLevel: null },
      buildPlanningPipelinePrompt: () => "planning prompt",
    },
    { skillPath: () => "/skill.md", buildArchitectureReadGuidance: () => "arch" },
  );

  assert.deepEqual(result, { prompt: "planning prompt" });
  assert.deepEqual(calls, [
    "reserve",
    "search",
    "persist:goal-started",
    "select-model",
    "notify:loop-agent: 반자동 목표 파이프라인(인터뷰 → to-prd → to-issues → checklist → 자동 구현·검증)을 시작합니다. 1단계 인터뷰는 질문/답변을 주고받습니다.",
  ]);
});

test("semantic and architecture searches start concurrently after issue-store setup", async () => {
  const started = [];
  let semanticFinished = false;
  let architectureStartedBeforeSemanticFinished = false;
  const result = await runRequiredSemanticSearch(
    { cwd: "/project", ui: { notify: () => {} } },
    "parallel search",
    {
      ensureIssueStore: async () => true,
      runIssueStoreCliAsync: async (_root, args) => {
        started.push(args[0]);
        if (args[0] === "search") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          semanticFinished = true;
          return { ok: true, results: [{ issue_id: "T-1" }] };
        }
        architectureStartedBeforeSemanticFinished = !semanticFinished;
        return {
          ok: true,
          results: [{ source_path: "docs/adr/001.md" }],
        };
      },
    },
  );

  assert.deepEqual(started.sort(), ["search", "search-architecture"]);
  assert.equal(architectureStartedBeforeSemanticFinished, true);
  assert.deepEqual(result, {
    query: "parallel search",
    results: [{ issue_id: "T-1" }],
    architectureResults: [{ source_path: "docs/adr/001.md" }],
  });
});

test("semantic search failure reports a block without consuming the source request", async () => {
  const notifications = [];
  const result = await preparePlanningPipeline(
    {},
    { cwd: "/project", ui: { notify: (message) => notifications.push(message) } },
    "search failure",
    { explicit: false, autoReview: false },
    {
      ensureWorkflowWorkspace: () => true,
      findMissingPipelinePrerequisite: () => null,
      reserveWorkflow: () => "workflow-search-failure",
      runRequiredSemanticSearch: async () => null,
      isCurrentWorkflow: () => true,
      persistWorkflowState: () => {},
      releaseWorkflowIfCurrent: () => {},
      selectModel: async () => true,
      workflowConfig: { planningModel: null, planningThinkingLevel: null },
      buildPlanningPipelinePrompt: () => "unreachable",
    },
    { skillPath: () => "/skill.md", buildArchitectureReadGuidance: () => "arch" },
  );

  assert.deepEqual(result, {
    blocked: true,
    reason: "semantic-search-failed",
  });
  assert.deepEqual(notifications, []);
});

test("L1 planning skips semantic search and only checks focused prerequisites", async () => {
  const calls = [];
  const result = await preparePlanningPipeline(
    {},
    { cwd: "/project", ui: { notify: (message) => calls.push(`notify:${message}`) } },
    "설정 화면의 국소 UI를 조정한다",
    { explicit: true, autoReview: true, complexity: "L1" },
    {
      ensureWorkflowWorkspace: () => true,
      findMissingPipelinePrerequisite: (_root, names) => {
        calls.push(`prerequisites:${names.join(",")}`);
        return null;
      },
      reserveWorkflow: () => "workflow-focused",
      runRequiredSemanticSearch: async () => {
        calls.push("search");
        throw new Error("L1 must not search");
      },
      isCurrentWorkflow: () => true,
      persistWorkflowState: (_pi, reason) => calls.push(`persist:${reason}`),
      releaseWorkflowIfCurrent: () => {},
      selectModel: async () => true,
      workflowConfig: { planningModel: null, planningThinkingLevel: null },
      buildPlanningPipelinePrompt: (_objective, _workflowId, _root, _context, complexity) => {
        calls.push(`complexity:${complexity}`);
        return "focused planning prompt";
      },
    },
    { skillPath: () => "/skill.md", buildArchitectureReadGuidance: () => "arch" },
  );

  assert.deepEqual(result, { prompt: "focused planning prompt" });
  assert.ok(calls.includes("prerequisites:grill-checklist"));
  assert.ok(calls.includes("complexity:L1"));
  assert.ok(!calls.includes("search"));
});
