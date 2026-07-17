const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInitialGateState,
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
});

test("failure transition clears execution ownership without touching the checklist", () => {
  const state = createInitialGateState();
  reserveWorkflow(state, true, "testing", "preserve me");
  state.processingWorkflowId = state.workflowId;

  failWorkflow(state);

  assert.equal(state.reviewStage, "failed");
  assert.equal(state.checklist, "preserve me");
  assert.equal(state.workflowId, null);
  assert.equal(state.processingWorkflowId, null);
  assert.equal(state.autoReview, true);
});
