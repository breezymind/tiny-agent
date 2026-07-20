const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInitialGateState,
  markGrilling,
  reserveWorkflow,
  markTesting,
  markReviewing,
  scheduleImprovement,
  completeWorkflow,
  failWorkflow,
} = require("../extensions/lib/loop-agent-state.ts");

test("state transitions keep workflow identity and terminal cleanup explicit", () => {
  const state = createInitialGateState();
  const workflowId = reserveWorkflow(state, true, "awaiting-execution", "checklist");

  assert.equal(state.workflowId, workflowId);
  assert.equal(state.autoMode, true);
  assert.equal(state.reviewStage, "awaiting-execution");
  assert.equal(state.pendingCodingPrompt, null);
  assert.equal(state.lastFailure, null);

  markTesting(state);
  markReviewing(state);
  assert.equal(state.reviewStage, "reviewing");
  assert.equal(scheduleImprovement(state), 1);
  assert.equal(state.reviewStage, "awaiting-execution");

  completeWorkflow(state);
  assert.equal(state.reviewStage, "reviewed");
  assert.equal(state.workflowId, null);
  assert.equal(state.processingWorkflowId, null);
  assert.equal(state.autoMode, false);
  assert.equal(state.pendingCodingPrompt, null);
  assert.equal(state.lastFailure, null);
});

test("failure transition clears execution ownership without touching the checklist", () => {
  const state = createInitialGateState();
  reserveWorkflow(state, true, "testing", "preserve me");
  state.processingWorkflowId = state.workflowId;
  state.lastFailure = {
    source: "testing",
    items: [{ item: "test", reason: "failed", evidence: "fixture" }],
  };

  failWorkflow(state);

  assert.equal(state.reviewStage, "failed");
  assert.equal(state.checklist, "preserve me");
  assert.equal(state.workflowId, null);
  assert.equal(state.processingWorkflowId, null);
  assert.equal(state.autoReview, true);
  assert.equal(state.lastFailure?.items[0].item, "test");
});

test("grilling recovery remains an explicit resumable phase", () => {
  const state = createInitialGateState();
  const workflowId = reserveWorkflow(state, false, "grilling", null);
  state.grillingRequired = true;
  state.grillingRepairPending = true;

  markGrilling(state);

  assert.equal(state.reviewStage, "grilling");
  assert.equal(state.workflowId, workflowId);
  assert.equal(state.checklist, null);
  assert.equal(state.grillingRepairPending, true);
});
