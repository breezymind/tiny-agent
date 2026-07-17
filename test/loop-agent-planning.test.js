const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDirectCodingPrompt,
  buildPlanningPipelinePrompt,
  findMissingPipelinePrerequisite,
  preparePlanningPipeline,
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
