import { randomUUID } from "node:crypto";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type WorkflowConfig = {
  planningModel: string | null;
  codingModel: string | null;
  verifyingModel: string | null;
  testModel: string | null;
  planningThinkingLevel: ThinkingLevel | null;
  codingThinkingLevel: ThinkingLevel | null;
  verifyingThinkingLevel: ThinkingLevel | null;
  testThinkingLevel: ThinkingLevel | null;
  maxImprovementRounds: number;
};

export type ReviewStage =
  | "idle"
  | "awaiting-execution"
  | "testing"
  | "diagnosing"
  | "reviewing"
  | "reviewed"
  | "failed";

export type GateState = {
  enabled: boolean;
  armed: boolean;
  reviewStage: ReviewStage;
  checklist: string | null;
  improvementRound: number;
  autoMode: boolean;
  autoReview: boolean;
  workflowId: string | null;
  processingWorkflowId: string | null;
  lengthContinueCount: number;
};

export type PersistedWorkflowState = Pick<
  GateState,
  "reviewStage" | "checklist" | "improvementRound" | "autoMode" | "autoReview" | "workflowId"
>;

export function createInitialGateState(): GateState {
  return {
    enabled: true,
    armed: false,
    reviewStage: "idle",
    checklist: null,
    improvementRound: 0,
    autoMode: false,
    autoReview: true,
    workflowId: null,
    processingWorkflowId: null,
    lengthContinueCount: 0,
  };
}

export function isCurrentWorkflow(state: GateState, workflowId: string): boolean {
  return state.workflowId === workflowId;
}

export function reserveWorkflow(
  state: GateState,
  autoReview: boolean,
  reviewStage: ReviewStage,
  checklist: string | null,
): string {
  const workflowId = randomUUID();
  state.armed = false;
  state.autoMode = true;
  state.autoReview = autoReview;
  state.reviewStage = reviewStage;
  state.checklist = checklist;
  state.improvementRound = 0;
  state.workflowId = workflowId;
  state.processingWorkflowId = null;
  return workflowId;
}

export function releaseWorkflow(state: GateState): void {
  state.reviewStage = "idle";
  state.checklist = null;
  state.improvementRound = 0;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
}

export function resetForFreshSession(state: GateState): void {
  state.reviewStage = "idle";
  state.checklist = null;
  state.improvementRound = 0;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
  state.lengthContinueCount = 0;
}

export function markTesting(state: GateState): void {
  state.reviewStage = "testing";
}

export function markAwaitingExecution(state: GateState): void {
  state.reviewStage = "awaiting-execution";
}

export function markDiagnosing(state: GateState): void {
  state.reviewStage = "diagnosing";
}

export function markReviewing(state: GateState): void {
  state.reviewStage = "reviewing";
}

export function completeWorkflow(state: GateState): void {
  state.reviewStage = "reviewed";
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
}

export function failWorkflow(state: GateState): void {
  state.reviewStage = "failed";
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
}

export function scheduleImprovement(state: GateState): number {
  state.improvementRound += 1;
  state.reviewStage = "awaiting-execution";
  return state.improvementRound;
}
