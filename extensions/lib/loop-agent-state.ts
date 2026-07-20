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
  | "grilling"
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
  pendingCodingPrompt: string | null;
  lastFailure: WorkflowFailure | null;
  improvementRound: number;
  autoMode: boolean;
  autoReview: boolean;
  workflowId: string | null;
  processingWorkflowId: string | null;
  grillingRequired: boolean;
  grillingRepairPending: boolean;
  grillingQuestionCount: number;
  grillingUserResponseCount: number;
  lengthContinueCount: number;
  checklistFormatRetryCount: number;
};

export type WorkflowFailureItem = {
  item: string;
  reason: string;
  evidence: string;
};

export type WorkflowFailure = {
  source: "review" | "testing";
  items: WorkflowFailureItem[];
};

export type PersistedWorkflowState = Pick<
  GateState,
  | "reviewStage"
  | "checklist"
  | "pendingCodingPrompt"
  | "lastFailure"
  | "improvementRound"
  | "autoMode"
  | "autoReview"
  | "workflowId"
  | "processingWorkflowId"
  | "grillingRequired"
  | "grillingRepairPending"
  | "grillingQuestionCount"
  | "grillingUserResponseCount"
  | "checklistFormatRetryCount"
> & {
  stateVersion: 1;
};

export function createInitialGateState(): GateState {
  return {
    enabled: true,
    armed: false,
    reviewStage: "idle",
    checklist: null,
    pendingCodingPrompt: null,
    lastFailure: null,
    improvementRound: 0,
    autoMode: false,
    autoReview: true,
    workflowId: null,
    processingWorkflowId: null,
    grillingRequired: false,
    grillingRepairPending: false,
    grillingQuestionCount: 0,
    grillingUserResponseCount: 0,
    lengthContinueCount: 0,
    checklistFormatRetryCount: 0,
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
  state.pendingCodingPrompt = null;
  state.lastFailure = null;
  state.improvementRound = 0;
  state.workflowId = workflowId;
  state.processingWorkflowId = null;
  state.grillingRequired = false;
  state.grillingRepairPending = false;
  state.grillingQuestionCount = 0;
  state.grillingUserResponseCount = 0;
  state.checklistFormatRetryCount = 0;
  return workflowId;
}

export function releaseWorkflow(state: GateState): void {
  state.reviewStage = "idle";
  state.checklist = null;
  state.pendingCodingPrompt = null;
  state.lastFailure = null;
  state.improvementRound = 0;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
  state.grillingRequired = false;
  state.grillingRepairPending = false;
  state.grillingQuestionCount = 0;
  state.grillingUserResponseCount = 0;
  state.checklistFormatRetryCount = 0;
}

export function resetForFreshSession(state: GateState): void {
  state.reviewStage = "idle";
  state.checklist = null;
  state.pendingCodingPrompt = null;
  state.lastFailure = null;
  state.improvementRound = 0;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
  state.grillingRequired = false;
  state.grillingRepairPending = false;
  state.grillingQuestionCount = 0;
  state.grillingUserResponseCount = 0;
  state.lengthContinueCount = 0;
  state.checklistFormatRetryCount = 0;
}

export function markTesting(state: GateState): void {
  state.reviewStage = "testing";
}

export function markGrilling(state: GateState): void {
  state.reviewStage = "grilling";
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
  state.pendingCodingPrompt = null;
  state.lastFailure = null;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
  state.grillingRequired = false;
  state.grillingRepairPending = false;
  state.grillingQuestionCount = 0;
  state.grillingUserResponseCount = 0;
  state.checklistFormatRetryCount = 0;
}

export function failWorkflow(state: GateState): void {
  state.reviewStage = "failed";
  state.pendingCodingPrompt = null;
  state.autoMode = false;
  state.autoReview = true;
  state.workflowId = null;
  state.processingWorkflowId = null;
  state.grillingRequired = false;
  state.grillingRepairPending = false;
  state.grillingQuestionCount = 0;
  state.grillingUserResponseCount = 0;
  state.checklistFormatRetryCount = 0;
}

export function scheduleImprovement(state: GateState): number {
  state.improvementRound += 1;
  state.reviewStage = "awaiting-execution";
  return state.improvementRound;
}
