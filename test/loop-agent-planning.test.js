const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldWaitForPlanningInterview,
} = require("../extensions/lib/loop-agent-planning.js");

test("auto planning waits after an interview response without a workflow marker", () => {
  assert.equal(shouldWaitForPlanningInterview(true, null), true);
  assert.equal(shouldWaitForPlanningInterview(true, undefined), true);
});

test("a workflow marker makes the response terminal even without a checklist", () => {
  assert.equal(
    shouldWaitForPlanningInterview(true, "5b24a939-f746-457b-9bed-bb106e78d1dc"),
    false,
  );
});

test("non-automatic planning never enters the interview wait branch", () => {
  assert.equal(shouldWaitForPlanningInterview(false, null), false);
});
