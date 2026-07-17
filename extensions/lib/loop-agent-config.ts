import fs from "node:fs";
import type { ThinkingLevel, WorkflowConfig } from "./loop-agent-state.ts";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

type SettingsFile = {
  loopAgent?: Partial<WorkflowConfig>;
  [key: string]: unknown;
};

const DEFAULT_CONFIG: WorkflowConfig = {
  planningModel: null,
  codingModel: null,
  verifyingModel: null,
  testModel: null,
  planningThinkingLevel: null,
  codingThinkingLevel: null,
  verifyingThinkingLevel: null,
  testThinkingLevel: null,
  maxImprovementRounds: 3,
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as string[]).includes(value);
}

export function loadWorkflowConfig(configPath: string): WorkflowConfig {
  try {
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8")) as SettingsFile;
    const parsed = settings.loopAgent ?? {};
    return {
      planningModel: typeof parsed.planningModel === "string" ? parsed.planningModel : null,
      codingModel: typeof parsed.codingModel === "string" ? parsed.codingModel : null,
      verifyingModel: typeof parsed.verifyingModel === "string" ? parsed.verifyingModel : null,
      testModel: typeof parsed.testModel === "string" ? parsed.testModel : null,
      planningThinkingLevel: isThinkingLevel(parsed.planningThinkingLevel)
        ? parsed.planningThinkingLevel
        : null,
      codingThinkingLevel: isThinkingLevel(parsed.codingThinkingLevel)
        ? parsed.codingThinkingLevel
        : null,
      verifyingThinkingLevel: isThinkingLevel(parsed.verifyingThinkingLevel)
        ? parsed.verifyingThinkingLevel
        : null,
      testThinkingLevel: isThinkingLevel(parsed.testThinkingLevel)
        ? parsed.testThinkingLevel
        : null,
      maxImprovementRounds:
        Number.isInteger(parsed.maxImprovementRounds) &&
        Number(parsed.maxImprovementRounds) >= 0 &&
        Number(parsed.maxImprovementRounds) <= 20
          ? Number(parsed.maxImprovementRounds)
          : DEFAULT_CONFIG.maxImprovementRounds,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveWorkflowConfig(
  configPath: string,
  workflowConfig: WorkflowConfig,
): void {
  const settings = JSON.parse(fs.readFileSync(configPath, "utf8")) as SettingsFile;
  settings.loopAgent = { ...workflowConfig };
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}
