const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractWorkflowId,
  getLastAssistantStopReason,
  getLastAssistantText,
} = require("../extensions/lib/loop-agent-events.ts");

test("event adapter reads only the last assistant response", () => {
  const event = {
    messages: [
      { role: "assistant", content: "old response", stopReason: "stop" },
      { role: "user", content: "answer" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "new " },
          { type: "tool_use", text: "ignored" },
          { type: "text", text: "response" },
        ],
        stopReason: "length",
      },
    ],
  };

  assert.equal(getLastAssistantText(event), "new \nresponse");
  assert.equal(getLastAssistantStopReason(event), "length");
});

test("event adapter extracts only a valid workflow marker", () => {
  assert.equal(
    extractWorkflowId(
      "<!-- loop-agent-workflow:123e4567-e89b-12d3-a456-426614174000 -->",
    ),
    "123e4567-e89b-12d3-a456-426614174000",
  );
  assert.equal(extractWorkflowId("no workflow marker"), null);
});
