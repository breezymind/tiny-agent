import {
  type GateState,
  type PersistedWorkflowState,
  type WorkflowFailure,
} from "./loop-agent-state.ts";

export const WORKFLOW_STATE_VERSION = 1 as const;

export function createPersistedWorkflowSnapshot(
  workflowState: GateState,
): PersistedWorkflowState {
  return {
    stateVersion: WORKFLOW_STATE_VERSION,
    reviewStage: workflowState.reviewStage,
    checklist: workflowState.checklist,
    pendingCodingPrompt: workflowState.pendingCodingPrompt,
    lastFailure: workflowState.lastFailure,
    improvementRound: workflowState.improvementRound,
    autoMode: workflowState.autoMode,
    autoReview: workflowState.autoReview,
    workflowId: workflowState.workflowId,
    processingWorkflowId: workflowState.processingWorkflowId,
    grillingRequired: workflowState.grillingRequired,
    grillingRepairPending: workflowState.grillingRepairPending,
    grillingQuestionCount: workflowState.grillingQuestionCount,
    grillingUserResponseCount: workflowState.grillingUserResponseCount,
    checklistFormatRetryCount: workflowState.checklistFormatRetryCount,
  };
}

function isWorkflowFailure(value: unknown): value is WorkflowFailure {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { source?: unknown; items?: unknown };
  if (candidate.source !== "review" && candidate.source !== "testing") return false;
  if (!Array.isArray(candidate.items)) return false;
  return candidate.items.every((item) => {
    if (!item || typeof item !== "object") return false;
    const failure = item as Record<string, unknown>;
    return (
      typeof failure.item === "string" &&
      typeof failure.reason === "string" &&
      typeof failure.evidence === "string"
    );
  });
}

export function restorePersistedWorkflowSnapshot(
  state: GateState,
  snapshot: Partial<PersistedWorkflowState>,
): boolean {
  // Snapshots written before the version field are still accepted once. New
  // writes always include the version so future migrations have an explicit
  // boundary.
  if (
    snapshot.stateVersion !== undefined &&
    snapshot.stateVersion !== WORKFLOW_STATE_VERSION
  ) {
    return false;
  }

  state.reviewStage = snapshot.reviewStage ?? "idle";
  state.checklist =
    typeof snapshot.checklist === "string" ? snapshot.checklist : null;
  state.pendingCodingPrompt =
    typeof snapshot.pendingCodingPrompt === "string"
      ? snapshot.pendingCodingPrompt
      : null;
  state.lastFailure = isWorkflowFailure(snapshot.lastFailure)
    ? snapshot.lastFailure
    : null;
  state.improvementRound = Number.isInteger(snapshot.improvementRound)
    ? Number(snapshot.improvementRound)
    : 0;
  state.autoMode = snapshot.autoMode === true;
  state.autoReview = snapshot.autoReview !== false;
  state.workflowId =
    typeof snapshot.workflowId === "string" ? snapshot.workflowId : null;
  state.grillingRequired = snapshot.grillingRequired === true;
  state.grillingRepairPending = snapshot.grillingRepairPending === true;
  state.grillingQuestionCount =
    Number.isInteger(snapshot.grillingQuestionCount) &&
    Number(snapshot.grillingQuestionCount) >= 0
      ? Number(snapshot.grillingQuestionCount)
      : 0;
  state.grillingUserResponseCount =
    Number.isInteger(snapshot.grillingUserResponseCount) &&
    Number(snapshot.grillingUserResponseCount) >= 0
      ? Number(snapshot.grillingUserResponseCount)
      : 0;

  // A child process from the previous Pi session cannot still own the new
  // session. Keep the persisted value for diagnostics, but clear the runtime
  // lock so resume can deliberately reacquire ownership.
  state.processingWorkflowId = null;
  state.checklistFormatRetryCount =
    Number.isInteger(snapshot.checklistFormatRetryCount) &&
    Number(snapshot.checklistFormatRetryCount) >= 0
      ? Number(snapshot.checklistFormatRetryCount)
      : 0;

  // Older snapshots could leave a planning workflow as idle after the
  // grilling gate rejected a premature checklist. Keep it resumable and show
  // the actual phase instead of restoring an ambiguous lock.
  if (
    state.reviewStage === "idle" &&
    state.workflowId &&
    state.grillingRequired &&
    !state.checklist
  ) {
    state.reviewStage = "grilling";
  }
  return true;
}
