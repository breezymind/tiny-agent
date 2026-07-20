import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

/**
 * Pi event parsing is kept independent from workflow policy. This prevents
 * changes to the event payload shape from being mixed with state transitions.
 */
export function getLastAssistantText(event: AgentEndEvent): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };

    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";

    return message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }

  return "";
}

export function getLastAssistantStopReason(event: AgentEndEvent): string | null {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index] as {
      role?: string;
      stopReason?: string;
    };
    if (message.role !== "assistant") continue;
    return message.stopReason ?? null;
  }
  return null;
}

export function extractWorkflowId(text: string): string | null {
  const pattern = /<!-- loop-agent-workflow:([0-9a-f-]{36}) -->/i;
  return text.match(pattern)?.[1] ?? null;
}
