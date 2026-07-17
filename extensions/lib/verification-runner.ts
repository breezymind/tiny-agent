import { spawn } from "node:child_process";

export type VerificationStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type VerificationCommandSpec = {
  program: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  required?: boolean;
  /** Run concurrently by default; set false for commands sharing mutable resources. */
  parallel?: boolean;
};

export type VerificationCommandResult = {
  program: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  status: VerificationStatus;
  spawned: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeout: boolean;
  // `timedOut` is kept as a readable alias for callers that prefer a verb.
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  errorCode?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export type VerificationResult = {
  status: VerificationStatus;
  // `overall` makes the aggregate result convenient to consume next to a command result.
  overall: VerificationStatus;
  results: VerificationCommandResult[];
  requiredCount: number;
  requiredExecutedCount: number;
  requiredMissingCount: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reason?: string;
};

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
  spawned: boolean;
  timeout: boolean;
};

const FORCE_KILL_GRACE_MS = 100;
const DEFAULT_PARALLEL_VERIFICATION_CONCURRENCY = 2;

export type VerificationOptions = {
  maxConcurrency?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidSpecError(spec: Partial<VerificationCommandSpec>): string | undefined {
  if (typeof spec.program !== "string" || spec.program.length === 0) {
    return "Verification command program must be a non-empty string.";
  }

  if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === "string")) {
    return "Verification command args must be an array of strings.";
  }

  if (typeof spec.timeoutMs !== "number" || !Number.isFinite(spec.timeoutMs) || spec.timeoutMs < 0) {
    return "Verification command timeoutMs must be a finite non-negative number.";
  }

  if (spec.cwd !== undefined && typeof spec.cwd !== "string") {
    return "Verification command cwd must be a string when provided.";
  }

  return undefined;
}

function executeProcess(spec: VerificationCommandSpec): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let timeout = false;
    let settled = false;
    let spawnError: (Error & { code?: string }) | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve({
        exitCode: spawnError === undefined ? exitCode : null,
        signal: spawnError === undefined ? signal : null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        ...(spawnError === undefined ? {} : { error: spawnError }),
        spawned: spawnError === undefined,
        timeout,
      });
    };

    try {
      // Keep program and args separate. In particular, do not pass a shell command string.
      child = spawn(spec.program, [...spec.args], {
        cwd: spec.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = Object.assign(new Error(errorMessage(error)), {
        code: (error as { code?: string })?.code,
      });
      finish(null, null);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const timer = setTimeout(() => {
      timeout = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, FORCE_KILL_GRACE_MS);
    }, spec.timeoutMs);

    child.once("error", (error: Error & { code?: string }) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      finish(exitCode, signal);
    });
  });
}

export async function runVerificationCommand(
  spec: VerificationCommandSpec,
): Promise<VerificationCommandResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const cwd = spec.cwd ?? process.cwd();
  const required = spec.required === true;
  const args = Array.isArray(spec.args) ? [...spec.args] : [];
  const timeoutMs = spec.timeoutMs;
  const validationError = invalidSpecError(spec);

  if (validationError !== undefined) {
    const endedAtMs = Date.now();
    return {
      program: typeof spec.program === "string" ? spec.program : String(spec.program ?? ""),
      args,
      cwd,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 0,
      required,
      status: "UNVERIFIED",
      spawned: false,
      exitCode: null,
      signal: null,
      timeout: false,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: validationError,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
    };
  }

  const outcome = await executeProcess({
    program: spec.program,
    args,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    required,
  });
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const status: VerificationStatus =
    outcome.error !== undefined
      ? "UNVERIFIED"
      : outcome.timeout || outcome.signal !== null || outcome.exitCode !== 0
        ? "FAIL"
        : "PASS";

  return {
    program: spec.program,
    args,
    cwd,
    timeoutMs: spec.timeoutMs,
    required,
    status,
    spawned: outcome.spawned,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timeout: outcome.timeout,
    timedOut: outcome.timeout,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    ...(outcome.error === undefined ? {} : { error: outcome.error.message, errorCode: outcome.error.code }),
    startedAt,
    endedAt,
    durationMs: endedAtMs - startedAtMs,
  };
}

export async function runVerification(
  specs: readonly VerificationCommandSpec[],
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const results = new Array<VerificationCommandResult>(specs.length);
  const requestedConcurrency = options.maxConcurrency ?? DEFAULT_PARALLEL_VERIFICATION_CONCURRENCY;
  const maxConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : DEFAULT_PARALLEL_VERIFICATION_CONCURRENCY;

  // Commands run concurrently by default. A command must explicitly opt out
  // when it shares ports, caches, or databases with another verification.
  let index = 0;
  while (index < specs.length) {
    if (specs[index]?.parallel === false) {
      results[index] = await runVerificationCommand(specs[index]);
      index += 1;
      continue;
    }

    const groupStart = index;
    while (index < specs.length && specs[index]?.parallel !== false) index += 1;
    const group = specs.slice(groupStart, index);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < group.length) {
        const groupIndex = next;
        next += 1;
        results[groupStart + groupIndex] = await runVerificationCommand(
          group[groupIndex],
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrency, group.length) },
        () => worker(),
      ),
    );
  }

  const requiredResults = results.filter((result) => result.required);
  const requiredExecutedCount = requiredResults.filter((result) => result.spawned).length;
  const requiredMissingCount = requiredResults.length - requiredExecutedCount;
  const hasFailure = results.some((result) => result.status === "FAIL");
  const hasUnverified = results.some((result) => result.status === "UNVERIFIED");

  let status: VerificationStatus;
  let reason: string | undefined;
  if (hasFailure) {
    status = "FAIL";
    reason = "One or more verification commands failed.";
  } else if (requiredResults.length === 0) {
    status = "UNVERIFIED";
    reason = "No required verification commands were specified.";
  } else if (requiredMissingCount > 0) {
    status = "UNVERIFIED";
    reason = "One or more required verification commands were not executed.";
  } else if (hasUnverified) {
    status = "UNVERIFIED";
    reason = "One or more verification commands could not be verified.";
  } else {
    status = "PASS";
  }

  const endedAtMs = Date.now();
  return {
    status,
    overall: status,
    results,
    requiredCount: requiredResults.length,
    requiredExecutedCount,
    requiredMissingCount,
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    ...(reason === undefined ? {} : { reason }),
  };
}

export const runVerificationSuite = runVerification;

export default {
  runVerificationCommand,
  runVerification,
  runVerificationSuite,
};
