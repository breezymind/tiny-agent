const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const {
  loadRolePersona,
  resolvePersonaPath,
  withRolePersona,
} = require("../extensions/lib/loop-agent-persona.ts");

test("role persona loader reads the exact role and supported aliases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-persona-"));
  const personaPath = path.join(root, "persona.json");
  try {
    fs.writeFileSync(
      personaPath,
      JSON.stringify({
        planning: { instructions: "planning persona" },
        review: { instructions: "review persona" },
        tester: { instructions: "test persona" },
      }),
    );

    assert.equal(loadRolePersona("planning", personaPath), "planning persona");
    assert.equal(loadRolePersona("verifying", personaPath), "review persona");
    assert.equal(loadRolePersona("test", personaPath), "test persona");
    assert.match(
      withRolePersona("coding", "base coding prompt", personaPath),
      /^base coding prompt$/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("role persona wraps an active persona without changing the base prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-persona-"));
  const personaPath = path.join(root, "persona.json");
  try {
    fs.writeFileSync(
      personaPath,
      JSON.stringify({ coding: { instructions: "minimal changes only" } }),
    );

    const prompt = withRolePersona("coding", "base prompt", personaPath);
    assert.match(prompt, /<loop-agent-persona role="coding">/);
    assert.match(prompt, /minimal changes only/);
    assert.match(prompt, /base prompt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persona path follows the Pi coding agent directory", () => {
  assert.equal(
    resolvePersonaPath("/tmp/pi-agent"),
    path.join("/tmp/pi-agent", "persona.json"),
  );
});

test("configured testModel receives the test persona and executes the declared verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-persona-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "persona.json"),
    JSON.stringify({ test: { instructions: "test persona from persona.json" } }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousVerification = process.env.PI_VERIFICATION_COMMANDS;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_VERIFICATION_COMMANDS = JSON.stringify([
      {
        program: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: projectRoot,
        required: true,
      },
    ]);

    const imported = await import(
      `${pathToFileURL(path.join(__dirname, "..", "extensions", "loop-agent.ts")).href}?persona-test=${Math.random()}`
    );
    const module = imported.default ?? imported;
    let capturedArgs;
    const result = await module.runValidatedTestAgent(
      { sendMessage: () => {} },
      {
        cwd: projectRoot,
        isIdle: () => true,
        ui: {
          notify: () => {},
          setStatus: () => {},
        },
      },
      "test checklist",
      {
        planningModel: null,
        codingModel: null,
        verifyingModel: null,
        testModel: "fake/test-model",
        planningThinkingLevel: null,
        codingThinkingLevel: null,
        verifyingThinkingLevel: null,
        testThinkingLevel: "high",
        maxImprovementRounds: 1,
      },
      {
        runPiCommandWithProgress: async (_pi, _cwd, _ui, _label, args) => {
          capturedArgs = args;
          return {
            code: 0,
            finalText: [
              "test agent executed the verification",
              "<!-- loop-agent-test-verification:start -->",
              JSON.stringify({
                results: [
                  {
                    program: process.execPath,
                    args: ["-e", "process.exit(0)"],
                    cwd: projectRoot,
                    timeoutMs: 15 * 60 * 1000,
                    required: true,
                    status: "PASS",
                    spawned: true,
                    exitCode: 0,
                    signal: null,
                    timeout: false,
                    stdout: "",
                    stderr: "",
                    startedAt: new Date().toISOString(),
                    endedAt: new Date().toISOString(),
                    durationMs: 1,
                  },
                ],
              }),
              "<!-- loop-agent-test-verification:end -->",
            ].join("\n"),
            stderr: "",
          };
        },
        killActiveChildren: () => 0,
      },
    );

    assert.equal(result.result.overall, "PASS");
    assert.match(capturedArgs.at(-1), /test persona from persona\.json/);
    assert.match(capturedArgs.join("\n"), /bash,read,grep,find,ls/);
    assert.match(result.report, /test agent executed the verification/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousVerification === undefined) delete process.env.PI_VERIFICATION_COMMANDS;
    else process.env.PI_VERIFICATION_COMMANDS = previousVerification;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
