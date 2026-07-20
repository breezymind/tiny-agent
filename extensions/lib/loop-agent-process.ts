import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type StreamingRunResult = {
  code: number;
  finalText: string;
  stderr: string;
};

type JsonTextContent = { type?: string; text?: string };
type JsonAssistantMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: string | JsonTextContent[];
};

export type ParsedEventLine = {
  log?: string;
  status?: string;
};

export type EventParseState = {
  finalText: string;
  toolNames: Map<string, string>;
  assistantBuffer: string;
  errorMessage: string | null;
};

export type PiProcessRuntime = {
  runPiCommandWithProgress(
    pi: Pick<ExtensionAPI, "sendMessage">,
    cwd: string,
    ui: ProgressUi,
    label: string,
    args: string[],
    timeoutMs?: number,
    isIdle?: () => boolean,
  ): Promise<StreamingRunResult>;
  killActiveChildren(): number;
};

type ProgressUi = Pick<ExtensionContext["ui"], "setStatus"> &
  Partial<Pick<ExtensionContext["ui"], "setWidget">>;

function shortenStatusLine(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function joinAssistantText(message: JsonAssistantMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is JsonTextContent =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function extractFinalTextFromMessages(messages: JsonAssistantMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return joinAssistantText(message).trim();
  }
  return "";
}

function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return shortenStatusLine(args, 60);
  if (typeof args !== "object") return shortenStatusLine(String(args), 60);

  const record = args as Record<string, unknown>;
  for (const key of [
    "command",
    "path",
    "file_path",
    "filePath",
    "pattern",
    "query",
    "url",
    "cmd",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return shortenStatusLine(value, 60);
    }
  }
  try {
    return shortenStatusLine(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

function summarizeToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return shortenStatusLine(result, 60);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter(
          (part): part is JsonTextContent =>
            (part as JsonTextContent)?.type === "text" &&
            typeof (part as JsonTextContent).text === "string",
        )
        .map((part) => part.text as string)
        .join(" ");
      if (text.trim()) return shortenStatusLine(text, 60);
    }
    try {
      return shortenStatusLine(JSON.stringify(result), 60);
    } catch {
      return "";
    }
  }
  return shortenStatusLine(String(result), 60);
}

export function handleJsonEvent(
  event: Record<string, unknown>,
  parse: EventParseState,
): ParsedEventLine {
  const type = typeof event.type === "string" ? event.type : "";

  switch (type) {
    case "tool_execution_start": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (toolCallId) parse.toolNames.set(toolCallId, toolName);
      const argsSummary = summarizeToolArgs(event.args);
      const line = argsSummary
        ? `🔧 ${toolName}: ${argsSummary}`
        : `🔧 ${toolName}`;
      return { log: line, status: line };
    }
    case "tool_execution_update": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      const partial = summarizeToolResult(event.partialResult);
      return partial ? { status: `⏳ ${toolName}: ${partial}` } : {};
    }
    case "tool_execution_end": {
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : "";
      const toolName =
        (typeof event.toolName === "string" && event.toolName) ||
        parse.toolNames.get(toolCallId) ||
        "tool";
      const resultSummary = summarizeToolResult(event.result);
      const line = `${event.isError === true ? "❌" : "✅"} ${toolName}${
        resultSummary ? ` → ${resultSummary}` : ""
      }`;
      return { log: line, status: line };
    }
    case "message_update": {
      const assistantMessageEvent = event.assistantMessageEvent as
        | { type?: string; delta?: string; content?: string; error?: JsonAssistantMessage }
        | undefined;
      if (!assistantMessageEvent || typeof assistantMessageEvent.type !== "string") {
        return {};
      }
      if (
        assistantMessageEvent.type === "text_delta" &&
        typeof assistantMessageEvent.delta === "string"
      ) {
        parse.assistantBuffer += assistantMessageEvent.delta;
        return {
          status: `💬 ${shortenStatusLine(parse.assistantBuffer, 60)}`,
        };
      }
      if (
        assistantMessageEvent.type === "text_end" &&
        typeof assistantMessageEvent.content === "string"
      ) {
        parse.assistantBuffer = "";
        const text = assistantMessageEvent.content.trim();
        return text ? { log: `💬 ${shortenStatusLine(text, 100)}` } : {};
      }
      if (assistantMessageEvent.type === "error") {
        const message = assistantMessageEvent.error?.errorMessage || "요청 오류";
        parse.errorMessage = message;
        return { log: `⚠️ ${shortenStatusLine(message, 100)}` };
      }
      return {};
    }
    case "message_end":
    case "turn_end": {
      const message = (event.message ?? {}) as JsonAssistantMessage;
      if (message.role === "assistant") {
        const text = joinAssistantText(message).trim();
        if (text) parse.finalText = text;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          parse.errorMessage =
            message.errorMessage || `요청이 ${message.stopReason} 상태로 종료됨`;
        }
      }
      return {};
    }
    case "agent_end": {
      const messages = Array.isArray(event.messages)
        ? (event.messages as JsonAssistantMessage[])
        : [];
      const text = extractFinalTextFromMessages(messages);
      if (text) parse.finalText = text;
      return {};
    }
    default:
      return {};
  }
}

function formatProgressMessage(
  label: string,
  stream: "stdout" | "stderr" | "heartbeat",
  transcript: string[],
  details?: string,
  latestStatus?: string,
): string[] {
  const lines = [
    `◈ ${label} 진행 로그`,
    `상태: ${latestStatus || stream} · 누적 ${transcript.length}줄`,
  ];
  if (details) lines.push(`상세: ${details}`);
  lines.push(
    ...(transcript.length > 0
      ? transcript.slice(-8).map((line) => `  ${line}`)
      : ["  (아직 출력 없음)"]),
  );
  return lines;
}

function withJsonMode(args: string[]): string[] {
  const result = [...args];
  const modeIndex = result.indexOf("--mode");
  if (modeIndex >= 0 && modeIndex + 1 < result.length) {
    result[modeIndex + 1] = "json";
    return result;
  }
  return ["--mode", "json", ...result];
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      // Coding agents may spawn shells, MCP servers, or tool subprocesses. The
      // detached child becomes its own process group so cancellation reaches
      // the whole tree instead of only the direct `pi` process.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already have exited; fall back to the direct child.
    }
  }
  child.kill(signal);
}

function scheduleHardKill(child: ChildProcess): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => signalChild(child, "SIGKILL"), 5000);
  timer.unref();
  return timer;
}

export function createPiProcessRuntime({
  spawnProcess = spawn,
  registerExitHandler = true,
}: {
  spawnProcess?: typeof spawn;
  registerExitHandler?: boolean;
} = {}): PiProcessRuntime {
  const activeChildren = new Set<ChildProcess>();
  const activeChildStatuses = new Map<string, { label: string; status: string }>();
  const activeProgresses = new Map<
    string,
    { ui: ProgressUi; lines: string[] }
  >();
  let nextProgressId = 0;

  const renderActiveChildStatuses = (): string | undefined => {
    if (activeChildStatuses.size === 0) return undefined;
    return Array.from(activeChildStatuses.entries())
      .map(([, entry]) => `${entry.label}: ${entry.status}`)
      .join(" | ");
  };

  const setChildStatus = (
    ui: ProgressUi,
    progressId: string,
    label: string,
    status: string,
  ): void => {
    activeChildStatuses.set(progressId, { label, status });
    ui.setStatus("loop-agent", renderActiveChildStatuses());
  };

  const clearChildStatus = (
    ui: ProgressUi,
    progressId: string,
  ): void => {
    activeChildStatuses.delete(progressId);
    ui.setStatus("loop-agent", renderActiveChildStatuses());
  };

  const renderProgressWidget = (
    ui: ProgressUi,
  ): void => {
    if (typeof ui.setWidget !== "function") return;
    const lines = Array.from(activeProgresses.values())
      .filter((entry) => entry.ui === ui)
      .flatMap((entry, index) => (index === 0 ? entry.lines : ["", ...entry.lines]));
    ui.setWidget("loop-agent-progress", lines.length > 0 ? lines : undefined, {
      placement: "aboveEditor",
    });
  };

  const setProgressWidget = (
    ui: ProgressUi,
    progressId: string,
    lines: string[],
  ): void => {
    activeProgresses.set(progressId, { ui, lines });
    renderProgressWidget(ui);
  };

  const clearProgressWidget = (
    ui: ProgressUi,
    progressId: string,
  ): void => {
    activeProgresses.delete(progressId);
    renderProgressWidget(ui);
  };

  const killActiveChildren = (): number => {
    let killed = 0;
    for (const child of activeChildren) {
      signalChild(child, "SIGTERM");
      scheduleHardKill(child);
      killed += 1;
    }
    activeChildren.clear();
    activeChildStatuses.clear();
    const activeUis = new Set(
      Array.from(activeProgresses.values(), (entry) => entry.ui),
    );
    activeProgresses.clear();
    for (const ui of activeUis) renderProgressWidget(ui);
    return killed;
  };

  if (registerExitHandler) {
    process.once("exit", () => {
      for (const child of activeChildren) child.kill("SIGTERM");
    });
  }

  const runPiCommandWithProgress = async (
    _pi: Pick<ExtensionAPI, "sendMessage">,
    cwd: string,
    ui: ProgressUi,
    label: string,
    args: string[],
    timeoutMs?: number,
    _isIdle?: () => boolean,
  ): Promise<StreamingRunResult> => {
    const progressId = `${label}#${++nextProgressId}`;
    setChildStatus(ui, progressId, label, "시작");
    setProgressWidget(
      ui,
      progressId,
      formatProgressMessage(label, "heartbeat", [], "시작", "시작"),
    );

    return await new Promise<StreamingRunResult>((resolve, reject) => {
      const child = spawnProcess("pi", withJsonMode(args), {
        cwd,
        env: { ...process.env, LOOP_AGENT_CHILD: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      activeChildren.add(child);

      let stderr = "";
      const progressTranscript: string[] = [];
      let stdoutRemainder = "";
      let stderrRemainder = "";
      let lastActivity = Date.now();
      let finished = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const parse: EventParseState = {
        finalText: "",
        toolNames: new Map(),
        assistantBuffer: "",
        errorMessage: null,
      };

      let latestStatus = "시작";
      const clearStatus = (): void => {
        clearChildStatus(ui, progressId);
        clearProgressWidget(ui, progressId);
      };
      const finish = (result: StreamingRunResult): void => {
        if (finished) return;
        finished = true;
        activeChildren.delete(child);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        clearStatus();
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (finished) return;
        finished = true;
        activeChildren.delete(child);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        clearStatus();
        reject(error);
      };
      const emit = (
        parsed: ParsedEventLine,
        stream: "stdout" | "stderr" = "stdout",
      ): void => {
        if (parsed.status) {
          latestStatus = parsed.status;
          setChildStatus(ui, progressId, label, parsed.status);
        }
        if (parsed.log) progressTranscript.push(parsed.log);
        if (!parsed.log && !parsed.status) return;
        setProgressWidget(
          ui,
          progressId,
          formatProgressMessage(
            label,
            stream,
            progressTranscript,
            undefined,
            latestStatus,
          ),
        );
      };
      const ingestStdout = (chunk: string): void => {
        lastActivity = Date.now();
        const parts = (stdoutRemainder + chunk).split(/\r?\n/);
        stdoutRemainder = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.trim();
          if (!line) continue;
          try {
            emit(handleJsonEvent(JSON.parse(line) as Record<string, unknown>, parse));
          } catch {
            emit({ log: shortenStatusLine(line, 200) });
          }
        }
      };
      const ingestStderr = (chunk: string): void => {
        lastActivity = Date.now();
        const parts = (stderrRemainder + chunk).split(/\r?\n/);
        stderrRemainder = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.trim();
          if (line) {
            emit({ log: `[stderr] ${shortenStatusLine(line, 200)}` }, "stderr");
          }
        }
      };

      heartbeat = setInterval(() => {
        if (finished) return;
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - lastActivity) / 1000));
        setProgressWidget(
          ui,
          progressId,
          formatProgressMessage(
            label,
            "heartbeat",
            progressTranscript,
            `${elapsedSeconds}초 동안 새 출력 없음`,
            latestStatus,
          ),
        );
      }, 5000);

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          signalChild(child, "SIGTERM");
          killTimer = scheduleHardKill(child);
          latestStatus = "시간 초과, 종료 중";
          setChildStatus(ui, progressId, label, latestStatus);
          setProgressWidget(
            ui,
            progressId,
            formatProgressMessage(label, "heartbeat", progressTranscript, undefined, latestStatus),
          );
        }, timeoutMs);
      }
      child.stdout?.on("data", (chunk: Buffer) => ingestStdout(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        ingestStderr(text);
      });
      child.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code, signal) => {
        if (timedOut) {
          fail(new Error(`${label} 실행이 ${Math.ceil((timeoutMs ?? 0) / 1000)}초 제한을 넘겨 종료되었습니다.`));
          return;
        }
        const stdoutTail = stdoutRemainder.trim();
        if (stdoutTail) {
          try {
            emit(handleJsonEvent(JSON.parse(stdoutTail) as Record<string, unknown>, parse));
          } catch {
            emit({ log: shortenStatusLine(stdoutTail, 200) });
          }
        }
        const stderrTail = stderrRemainder.trim();
        if (stderrTail) emit({ log: `[stderr] ${shortenStatusLine(stderrTail, 200)}` }, "stderr");
        const exitCode = code ?? (signal ? 1 : 0);
        finish({
          code: exitCode !== 0 ? exitCode : parse.errorMessage ? 1 : 0,
          finalText: parse.finalText.trim(),
          stderr: (parse.errorMessage ? `${parse.errorMessage}\n${stderr}` : stderr).trim(),
        });
      });
    });
  };

  return { runPiCommandWithProgress, killActiveChildren };
}
