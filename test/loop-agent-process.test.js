const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  createPiProcessRuntime,
  handleJsonEvent,
} = require("../extensions/lib/loop-agent-process.ts");

test("event parser tracks tools and final assistant text without the workflow module", () => {
  const state = {
    finalText: "",
    toolNames: new Map(),
    assistantBuffer: "",
    errorMessage: null,
  };

  const started = handleJsonEvent(
    { type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "README.md" } },
    state,
  );
  handleJsonEvent(
    { type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "ok" }] } },
    state,
  );
  handleJsonEvent(
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
    state,
  );

  assert.match(started.log, /read: README\.md/);
  assert.equal(state.finalText, "done");
  assert.equal(state.toolNames.get("call-1"), "read");
});

test("injected Pi process runtime parses NDJSON and reports progress", async () => {
  const messages = [];
  const statuses = [];
  const runtime = createPiProcessRuntime({
    registerExitHandler: false,
    spawnProcess(_program, args) {
      assert.equal(args[args.indexOf("--mode") + 1], "json");
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "1", args: { path: "x" } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "completed" }] }] })}\n`);
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await runtime.runPiCommandWithProgress(
    { sendMessage: (message) => messages.push(message) },
    process.cwd(),
    { setStatus: (_label, message) => statuses.push(message) },
    "fake Pi",
    ["--mode", "json", "prompt"],
  );

  assert.equal(result.code, 0);
  assert.equal(result.finalText, "completed");
  assert.ok(messages.some((message) => message.customType === "loop-agent-progress"));
  assert.equal(statuses.at(-1), undefined);
  assert.equal(runtime.killActiveChildren(), 0);
});
