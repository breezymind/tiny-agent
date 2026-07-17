const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildComplexityRouterPrompt,
  parseComplexityRouterResult,
} = require("../extensions/lib/loop-agent-complexity.ts");

test("complexity router prompt delegates semantic judgment to an LLM persona", () => {
  const prompt = buildComplexityRouterPrompt("설정에서 피드백쓰기 메뉴를 제거해");

  assert.match(prompt, /complexity-router/);
  assert.match(prompt, /의미와 잠재적 영향 범위/);
  assert.match(prompt, /L0.*L1.*L2.*L3/s);
  assert.match(prompt, /설정에서 피드백쓰기 메뉴를 제거해/);
  assert.doesNotMatch(prompt, /actionMarkers|complexityMarkers/);
});

test("complexity router accepts the last valid JSON decision after progress logs", () => {
  const output = [
    "router started",
    JSON.stringify({ complexity: "L0", reason: "single local menu" }),
  ].join("\n");

  assert.equal(parseComplexityRouterResult(output), "L0");
  assert.equal(parseComplexityRouterResult('{"complexity":"L9"}'), null);
  assert.equal(parseComplexityRouterResult("not json"), null);
});
