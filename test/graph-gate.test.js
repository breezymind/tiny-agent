const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GRAPH_GATE = path.join(__dirname, "..", "extensions", "graph-gate.ts");
const GRAPH_STATUS = path.join(__dirname, "..", "extensions", "lib", "graph-status.ts");
let graphFirstGatePromise;
let graphStatusPromise;

async function loadGraphFirstGate() {
  graphFirstGatePromise ??= import(GRAPH_GATE).then(
    (module) => module.default?.default ?? module.default,
  );
  return graphFirstGatePromise;
}

async function loadGraphStatus() {
  graphStatusPromise ??= import(GRAPH_STATUS).then(
    (module) => module.default?.default ?? module.default ?? module,
  );
  return graphStatusPromise;
}

function createPiHarness({ graphAvailable }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graph-gate-project-"));
  if (graphAvailable) {
    fs.mkdirSync(path.join(projectRoot, ".codegraph"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".codegraph", "codegraph.db"), "");
  }

  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const execCalls = [];
  const ui = {
    notify(message, level) {
      notifications.push({ message, level });
    },
  };
  const ctx = {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui,
  };
  const pi = {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    registerCommand(commandName, definition) {
      commands.set(commandName, definition);
    },
    async exec(command, args) {
      execCalls.push({ command, args });

      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }

      if (args[0] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({ initialized: graphAvailable }) + "\n",
          stderr: "",
        };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  };

  return {
    async start() {
      const graphFirstGate = await loadGraphFirstGate();
      graphFirstGate(pi);
      await handlers.get("session_start")({}, ctx);
    },
    async input(text = "inspect source") {
      return handlers.get("input")({ source: "user", text });
    },
    async toolCall(toolName, input = {}) {
      return handlers.get("tool_call")({ toolName, input }, ctx);
    },
    async command(args) {
      return commands.get("graph-gate").handler(args, ctx);
    },
    notifications,
    execCalls,
    projectRoot,
  };
}

test("graph discovery unlocks source search for the rest of the turn", async () => {
  const harness = createPiHarness({ graphAvailable: true });
  await harness.start();
  await harness.input();

  const beforeDiscovery = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(beforeDiscovery.block, true);

  await harness.toolCall("server__codegraph_explore", { query: "graph gate" });
  const afterDiscovery = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(afterDiscovery, undefined);
});

test("checking graph status does not unlock source search", async () => {
  const harness = createPiHarness({ graphAvailable: true });
  await harness.start();
  await harness.input();

  const statusResult = await harness.toolCall("codegraph_status");
  assert.equal(statusResult, undefined);

  const blocked = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /codegraph_status는 상태 확인만/);
});

test("strict mode blocks repeated source searches until discovery is attempted", async () => {
  const harness = createPiHarness({ graphAvailable: true });
  await harness.start();
  await harness.input();

  const first = await harness.toolCall("bash", { command: "grep -n graph extensions/graph-gate.ts" });
  const second = await harness.toolCall("bash", { command: "grep -n graph extensions/graph-gate.ts" });
  assert.equal(first.block, true);
  assert.equal(second.block, true);

  await harness.toolCall("codegraph_node", { name: "graphFirstGate" });
  const afterDiscovery = await harness.toolCall("bash", { command: "grep -n graph extensions/graph-gate.ts" });
  assert.equal(afterDiscovery, undefined);
});

test("permissive mode blocks the first search and permits fallback afterward", async () => {
  const harness = createPiHarness({ graphAvailable: true });
  await harness.start();
  await harness.command("permissive");
  await harness.input();

  const first = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  const fallback = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(first.block, true);
  assert.equal(fallback, undefined);

  await harness.command("strict");
  await harness.input();
  const strictFirst = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  const strictSecond = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(strictFirst.block, true);
  assert.equal(strictSecond.block, true);
});

test("without a graph index the gate fails open and allows source search", async () => {
  const harness = createPiHarness({ graphAvailable: false });
  await harness.start();
  await harness.input();

  const result = await harness.toolCall("bash", { command: "rg graph-first extensions" });
  assert.equal(result, undefined);
  assert.ok(
    harness.notifications.some(({ message }) =>
      message.includes("No graph index found for this project"),
    ),
  );
});

test("PATH-based CodeGraph MCP commands remain portable", async () => {
  const { resolveCodegraphCli } = await loadGraphStatus();
  assert.deepEqual(
    resolveCodegraphCli({
      mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } },
    }),
    { command: "codegraph", argsPrefix: [] },
  );
});
