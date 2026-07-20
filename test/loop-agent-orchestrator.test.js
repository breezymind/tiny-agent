const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorkflowOrchestrator } = require("../extensions/lib/loop-agent-orchestrator.ts");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("execution timeout fails closed and releases the pending operation", async () => {
  let currentTime = 0;
  let timedOut = 0;
  let executed = 0;
  const orchestrator = createWorkflowOrchestrator();

  assert.equal(
    orchestrator.startExecution({
      workflowId: "workflow-timeout",
      isIdle: () => false,
      sleep: async () => {
        currentTime += 10;
      },
      now: () => currentTime,
      timeoutMs: 20,
      pollMs: 10,
      runExecution: async () => {
        executed += 1;
      },
      isCurrentWorkflow: () => true,
      onExecutionTimeout: () => {
        timedOut += 1;
      },
    }),
    true,
  );

  await flush();
  await flush();

  assert.equal(timedOut, 1);
  assert.equal(executed, 0);
  assert.equal(orchestrator.getPendingOperation(), null);
});

test("workflow identity prevents stale execution and duplicate scheduling", async () => {
  let executed = 0;
  let released = false;
  const orchestrator = createWorkflowOrchestrator();
  const operation = {
    workflowId: "workflow-current",
    isIdle: () => true,
    sleep: async () => {},
    timeoutMs: 20,
    pollMs: 1,
    runExecution: async () => {
      executed += 1;
    },
    isCurrentWorkflow: () => false,
    onExecutionTimeout: () => {},
  };

  assert.equal(orchestrator.startExecution(operation), true);
  assert.equal(orchestrator.startExecution(operation), false);
  await flush();

  assert.equal(executed, 0);
  assert.equal(orchestrator.getPendingOperation(), null);

  assert.equal(
    orchestrator.scheduleLengthContinuation({
      workflowId: null,
      isIdle: () => true,
      sleep: async () => {},
      timeoutMs: 20,
      pollMs: 1,
      sendContinuation: () => {
        released = true;
      },
      onTimeout: () => {},
      isCurrentWorkflow: () => true,
    }),
    true,
  );
  await flush();
  assert.equal(released, true);
});
