export type OrchestratorPendingOperation = {
  kind: "execution" | "length-continue";
  workflowId: string | null;
};

export type WorkflowExecutionOperation = {
  workflowId: string;
  initialCodingPrompt?: string;
  isIdle: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs: number;
  pollMs: number;
  runExecution: (workflowId: string, initialCodingPrompt?: string) => Promise<void>;
  onExecutionTimeout: (workflowId: string) => void;
  isCurrentWorkflow: (workflowId: string) => boolean;
};

export type LengthContinuationOperation = {
  workflowId: string | null;
  isIdle: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs: number;
  pollMs: number;
  sendContinuation: () => void;
  onTimeout: () => void;
  isCurrentWorkflow: (workflowId: string) => boolean;
};

export type WorkflowOrchestrator = {
  startExecution: (operation: WorkflowExecutionOperation) => boolean;
  scheduleLengthContinuation: (operation: LengthContinuationOperation) => boolean;
  getPendingOperation: () => OrchestratorPendingOperation | null;
};

/**
 * Owns only the asynchronous hand-off around Pi's idle boundary.
 * The stage implementation remains injectable, so this module can be tested
 * without loading the real Pi extension or spawning a child process.
 */
export function createWorkflowOrchestrator(): WorkflowOrchestrator {
  let pending: OrchestratorPendingOperation | null = null;

  async function waitForIdle(operation: {
    isIdle: () => boolean;
    sleep: (milliseconds: number) => Promise<void>;
    now?: () => number;
    timeoutMs: number;
    pollMs: number;
  }): Promise<boolean> {
    const now = operation.now ?? Date.now;
    const deadline = now() + operation.timeoutMs;
    while (!operation.isIdle() && now() < deadline) {
      await operation.sleep(operation.pollMs);
    }
    return operation.isIdle();
  }

  function ownsPending(kind: OrchestratorPendingOperation["kind"], workflowId: string | null): boolean {
    return pending?.kind === kind && pending.workflowId === workflowId;
  }

  function startExecution(operation: WorkflowExecutionOperation): boolean {
    const { workflowId } = operation;
    if (pending !== null) return false;
    pending = { kind: "execution", workflowId };

    void (async () => {
      try {
        if (!(await waitForIdle(operation))) {
          operation.onExecutionTimeout(workflowId);
          return;
        }
        if (!operation.isCurrentWorkflow(workflowId)) return;
        await operation.runExecution(workflowId, operation.initialCodingPrompt);
      } finally {
        if (ownsPending("execution", workflowId)) pending = null;
      }
    })();
    return true;
  }

  function scheduleLengthContinuation(operation: LengthContinuationOperation): boolean {
    const { workflowId } = operation;
    if (pending !== null) return false;
    pending = { kind: "length-continue", workflowId };

    void (async () => {
      try {
        if (!(await waitForIdle(operation))) {
          operation.onTimeout();
          return;
        }
        if (workflowId && !operation.isCurrentWorkflow(workflowId)) return;
        operation.sendContinuation();
      } finally {
        if (ownsPending("length-continue", workflowId)) pending = null;
      }
    })();
    return true;
  }

  return {
    startExecution,
    scheduleLengthContinuation,
    getPendingOperation: () => pending,
  };
}
