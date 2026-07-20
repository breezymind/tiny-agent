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
  const widgets = [];
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
    {
      setStatus: (_label, message) => statuses.push(message),
      setWidget: (key, content, options) => widgets.push({ key, content, options }),
    },
    "fake Pi",
    ["--mode", "json", "prompt"],
  );

  assert.equal(result.code, 0);
  assert.equal(result.finalText, "completed");
  assert.equal(messages.length, 0);
  assert.ok(widgets.length >= 2);
  assert.ok(widgets.every((widget) => widget.key === "loop-agent-progress"));
  assert.ok(widgets.some((widget) => widget.content?.some((line) => line.includes("read: x"))));
  assert.deepEqual(widgets.at(-1), {
    key: "loop-agent-progress",
    content: undefined,
    options: { placement: "aboveEditor" },
  });
  assert.equal(statuses.at(-1), undefined);
  assert.equal(runtime.killActiveChildren(), 0);
});

test("parallel Pi children share one replaceable progress widget", async () => {
  const children = [];
  const widgets = [];
  const runtime = createPiProcessRuntime({
    registerExitHandler: false,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });
  const ui = {
    setStatus: () => {},
    setWidget: (key, content, options) => widgets.push({ key, content, options }),
  };

  const first = runtime.runPiCommandWithProgress(
    { sendMessage: () => {} },
    process.cwd(),
    ui,
    "첫 번째 에이전트",
    ["prompt"],
  );
  const second = runtime.runPiCommandWithProgress(
    { sendMessage: () => {} },
    process.cwd(),
    ui,
    "두 번째 에이전트",
    ["prompt"],
  );

  assert.equal(children.length, 2);
  assert.ok(
    widgets.some(
      (widget) =>
        widget.content?.some((line) => line.includes("첫 번째 에이전트")) &&
        widget.content?.some((line) => line.includes("두 번째 에이전트")),
    ),
  );

  for (const [child, text] of children.map((child, index) => [child, `완료 ${index + 1}`])) {
    child.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      })}\n`,
    );
    child.stdout.end();
    child.emit("close", 0, null);
  }

  await Promise.all([first, second]);
  assert.deepEqual(widgets.at(-1), {
    key: "loop-agent-progress",
    content: undefined,
    options: { placement: "aboveEditor" },
  });
});

test("Pi process runtime terminates a timed-out child", async () => {
  const killedSignals = [];
  const runtime = createPiProcessRuntime({
    registerExitHandler: false,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        killedSignals.push(signal);
        process.nextTick(() => child.emit("close", null, signal));
        return true;
      };
      return child;
    },
  });

  await assert.rejects(
    runtime.runPiCommandWithProgress(
      { sendMessage: () => {} },
      process.cwd(),
      { setStatus: () => {}, setWidget: () => {} },
      "timed-out Pi",
      ["prompt"],
      10,
    ),
    /제한을 넘겨 종료되었습니다/,
  );
  assert.deepEqual(killedSignals, ["SIGTERM"]);
});
