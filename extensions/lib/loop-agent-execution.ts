import type { GateState } from "./loop-agent-state.ts";

export type ExecutionTestResult = {
  overall: "PASS" | "FAIL";
  [key: string]: unknown;
};

export type ExecutionTestingResult =
  | { status: "stale" }
  | {
      status: "completed";
      testReport: string | null;
      testResult: ExecutionTestResult | null;
    };

export type ExecutionReviewResult =
  | { status: "stale" | "stopped" | "completed" }
  | { status: "scheduled"; codingPrompt: string };

export type ExecutionLoopDependencies = {
  state: GateState;
  isCurrentWorkflow: (workflowId: string) => boolean;
  runCodingStage: (
    workflowId: string,
    checklist: string,
    codingPrompt?: string,
  ) => Promise<"completed" | "stale">;
  runTestingStage: (
    workflowId: string,
    checklist: string,
  ) => Promise<ExecutionTestingResult>;
  recoverFromTestFailure: (
    workflowId: string,
    testReport: string | null,
    testResult: ExecutionTestResult | null,
  ) => Promise<{ status: "scheduled"; codingPrompt: string } | { status: "stale" | "stopped" }>;
  completeWithoutReview: () => void;
  runReviewStage: (
    workflowId: string,
    checklist: string,
    testReport: string | null,
    testResult: ExecutionTestResult,
  ) => Promise<ExecutionReviewResult>;
  failWorkflow: (state: GateState) => void;
  persistWorkflowState: (reason: string, state: GateState) => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

/**
 * Coordinates stage order and recovery without knowing anything about Pi's
 * event API, child processes, or UI implementation.
 */
export async function runExecutionReviewLoop(
  workflowId: string,
  initialCodingPrompt: string | undefined,
  dependencies: ExecutionLoopDependencies,
): Promise<void> {
  const workflowState = dependencies.state;
  if (
    !workflowState.checklist ||
    !dependencies.isCurrentWorkflow(workflowId)
  ) {
    return;
  }
  if (workflowState.processingWorkflowId) {
    dependencies.notify(
      "loop-agent: 이미 코드 실행 또는 검수가 진행 중입니다.",
      "warning",
    );
    return;
  }

  workflowState.processingWorkflowId = workflowId;
  let codingPrompt =
    initialCodingPrompt ?? workflowState.pendingCodingPrompt ?? undefined;

  try {
    while (
      dependencies.isCurrentWorkflow(workflowId) &&
      workflowState.checklist
    ) {
      const checklist = workflowState.checklist;
      const codingStatus = await dependencies.runCodingStage(
        workflowId,
        checklist,
        codingPrompt,
      );
      if (codingStatus === "stale") return;

      const testing = await dependencies.runTestingStage(workflowId, checklist);
      if (testing.status === "stale") return;
      if (!testing.testResult || testing.testResult.overall !== "PASS") {
        const recovery = await dependencies.recoverFromTestFailure(
          workflowId,
          testing.testReport,
          testing.testResult,
        );
        if (recovery.status === "stale" || recovery.status === "stopped") return;
        codingPrompt = recovery.codingPrompt;
        continue;
      }

      if (!workflowState.autoReview) {
        dependencies.completeWithoutReview();
        return;
      }

      const review = await dependencies.runReviewStage(
        workflowId,
        checklist,
        testing.testReport,
        testing.testResult,
      );
      if (review.status !== "scheduled") return;
      codingPrompt = review.codingPrompt;
    }
  } catch (error) {
    if (!dependencies.isCurrentWorkflow(workflowId)) return;
    dependencies.failWorkflow(workflowState);
    dependencies.persistWorkflowState("execution-failed", workflowState);
    dependencies.notify(
      `loop-agent: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    if (workflowState.processingWorkflowId === workflowId) {
      workflowState.processingWorkflowId = null;
    }
  }
}
