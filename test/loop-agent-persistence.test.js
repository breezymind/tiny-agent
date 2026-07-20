const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInitialGateState,
  reserveWorkflow,
} = require("../extensions/lib/loop-agent-state.ts");
const {
  createPersistedWorkflowSnapshot,
  restorePersistedWorkflowSnapshot,
} = require("../extensions/lib/loop-agent-persistence.ts");

test("workflow snapshots version and preserve interrupted execution ownership", () => {
  const state = createInitialGateState();
  const workflowId = reserveWorkflow(state, true, "testing", "keep this checklist");
  state.pendingCodingPrompt = "resume coding";
  state.processingWorkflowId = workflowId;
  state.grillingRequired = true;
  state.grillingRepairPending = true;
  state.grillingQuestionCount = 2;
  state.grillingUserResponseCount = 1;

  const snapshot = createPersistedWorkflowSnapshot(state);

  assert.equal(snapshot.stateVersion, 1);
  assert.equal(snapshot.workflowId, workflowId);
  assert.equal(snapshot.processingWorkflowId, workflowId);
  assert.equal(snapshot.pendingCodingPrompt, "resume coding");
  assert.equal(snapshot.grillingRequired, true);
  assert.equal(snapshot.grillingRepairPending, true);
  assert.equal(snapshot.grillingQuestionCount, 2);
  assert.equal(snapshot.grillingUserResponseCount, 1);
});

test("restore accepts current snapshots but reacquires execution ownership", () => {
  const source = createInitialGateState();
  const workflowId = reserveWorkflow(source, true, "testing", "resume me");
  source.processingWorkflowId = workflowId;
  source.pendingCodingPrompt = "continue";

  const restored = createInitialGateState();
  assert.equal(
    restorePersistedWorkflowSnapshot(
      restored,
      createPersistedWorkflowSnapshot(source),
    ),
    true,
  );
  assert.equal(restored.workflowId, workflowId);
  assert.equal(restored.pendingCodingPrompt, "continue");
  assert.equal(restored.processingWorkflowId, null);
});

test("restore preserves grilling gate evidence while execution is pending", () => {
  const source = createInitialGateState();
  reserveWorkflow(source, true, "awaiting-execution", "resume me");
  source.grillingRequired = true;
  source.grillingQuestionCount = 1;
  source.grillingUserResponseCount = 1;

  const restored = createInitialGateState();
  assert.equal(
    restorePersistedWorkflowSnapshot(
      restored,
      createPersistedWorkflowSnapshot(source),
    ),
    true,
  );
  assert.equal(restored.grillingRequired, true);
  assert.equal(restored.grillingQuestionCount, 1);
  assert.equal(restored.grillingUserResponseCount, 1);
});

test("restore migrates an old idle grilling workflow to the explicit phase", () => {
  const restored = createInitialGateState();
  assert.equal(
    restorePersistedWorkflowSnapshot(restored, {
      reviewStage: "idle",
      checklist: null,
      autoMode: true,
      grillingRequired: true,
      workflowId: "stale-grilling-workflow",
    }),
    true,
  );

  assert.equal(restored.reviewStage, "grilling");
  assert.equal(restored.workflowId, "stale-grilling-workflow");
  assert.equal(restored.checklist, null);
});

test("restore rejects unknown snapshot versions", () => {
  const state = createInitialGateState();
  assert.equal(
    restorePersistedWorkflowSnapshot(state, { stateVersion: 99 }),
    false,
  );
  assert.equal(state.workflowId, null);
});
