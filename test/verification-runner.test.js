const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runVerificationCommand,
  runVerification,
} = require("../extensions/lib/verification-runner.ts");

const nodeCommand = (script, ...args) => ({
  program: process.execPath,
  args: ["-e", script, ...args],
  cwd: process.cwd(),
  timeoutMs: 1_000,
  required: true,
});

test("runs a successful command with separated arguments and captures its result", async () => {
  const result = await runVerificationCommand(
    nodeCommand(
      "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic');",
      "argument; not shell syntax",
    ),
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.spawned, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timeout, false);
  assert.equal(result.stdout, "argument; not shell syntax");
  assert.equal(result.stderr, "diagnostic");
  assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(result.durationMs >= 0);

  const aggregate = await runVerification([nodeCommand("process.exit(0);")]);
  assert.equal(aggregate.status, "PASS");
  assert.equal(aggregate.requiredCount, 1);
  assert.equal(aggregate.requiredExecutedCount, 1);
});

test("returns FAIL and captures stdout/stderr for exit code 1", async () => {
  const result = await runVerificationCommand(
    nodeCommand("process.stdout.write('partial'); process.stderr.write('failed'); process.exit(1);"),
  );

  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.timeout, false);
  assert.equal(result.stdout, "partial");
  assert.equal(result.stderr, "failed");
});

test("terminates a timed-out process and returns FAIL", async () => {
  const result = await runVerificationCommand({
    ...nodeCommand("setInterval(() => {}, 1_000);"),
    timeoutMs: 40,
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.timeout, true);
  assert.equal(result.timedOut, true);
  assert.ok(result.exitCode === null || result.exitCode !== 0);
  assert.ok(result.durationMs < 1_000);
});

test("marks a missing command and missing required coverage as UNVERIFIED", async () => {
  const missingSpec = {
    program: "/definitely/not/a/real/verification-command",
    args: [],
    cwd: process.cwd(),
    timeoutMs: 100,
    required: true,
  };
  const missing = await runVerificationCommand(missingSpec);

  assert.equal(missing.status, "UNVERIFIED");
  assert.equal(missing.spawned, false);
  assert.equal(missing.exitCode, null);
  assert.equal(missing.errorCode, "ENOENT");

  const noRequired = await runVerification([
    {
      ...nodeCommand("process.stdout.write('optional');"),
      required: false,
    },
  ]);
  assert.equal(noRequired.status, "UNVERIFIED");
  assert.equal(noRequired.overall, "UNVERIFIED");
  assert.equal(noRequired.requiredCount, 0);
  assert.equal(noRequired.requiredExecutedCount, 0);
  assert.match(noRequired.reason, /No required/);

  const requiredMissing = await runVerification([missingSpec]);
  assert.equal(requiredMissing.status, "UNVERIFIED");
  assert.equal(requiredMissing.requiredCount, 1);
  assert.equal(requiredMissing.requiredExecutedCount, 0);
  assert.equal(requiredMissing.requiredMissingCount, 1);
});
