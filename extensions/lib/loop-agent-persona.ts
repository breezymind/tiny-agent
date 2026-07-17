import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LoopAgentRole = "planning" | "coding" | "verifying" | "test";

type PersonaDefinition = {
  instructions?: unknown;
};

type PersonaFile = Record<string, unknown>;

const PERSONA_NAMES: Record<LoopAgentRole, readonly string[]> = {
  planning: ["planning", "plan", "architect"],
  coding: ["coding", "implement", "builder"],
  verifying: ["verifying", "verify", "review", "reviewer"],
  test: ["test", "testing", "tester"],
};

export function resolvePersonaPath(agentDir?: string): string {
  return path.join(
    agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      path.join(os.homedir(), ".pi", "agent"),
    "persona.json",
  );
}

function readPersonas(personaPath: string): PersonaFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(personaPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as PersonaFile;
  } catch {
    return null;
  }
}

export function loadRolePersona(
  role: LoopAgentRole,
  personaPath = resolvePersonaPath(),
): string | null {
  const personas = readPersonas(personaPath);
  if (!personas) return null;

  for (const personaName of PERSONA_NAMES[role]) {
    const persona = personas[personaName];
    if (!persona || typeof persona !== "object" || Array.isArray(persona)) {
      continue;
    }

    const instructions = (persona as PersonaDefinition).instructions;
    if (typeof instructions === "string" && instructions.trim()) {
      return instructions.trim();
    }
  }

  return null;
}

export function withRolePersona(
  role: LoopAgentRole,
  prompt: string,
  personaPath?: string,
): string {
  const persona = loadRolePersona(role, personaPath);
  if (!persona) return prompt;

  return [
    `<loop-agent-persona role="${role}">`,
    persona,
    "</loop-agent-persona>",
    "",
    prompt,
  ].join("\n");
}
