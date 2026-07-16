const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseParallelCodingTasksFromIssues } = require("../extensions/lib/issue-task-selection.js");

test("parallel candidates come from SQLite-shaped records and honor ready/blocker/parent rules", () => {
  const records = [
    { issue_id: "T-201", title: "A", triage_label: "ready-for-agent", status: "backlog", parent: "T-200", blockedBy: [], body: "A" },
    { issue_id: "T-202", title: "B", triage_label: "ready-for-agent", status: "current", parent: "T-200", blockedBy: [], body: "B" },
    { issue_id: "T-203", title: "Done", triage_label: "ready-for-agent", status: "done", parent: "T-200", blockedBy: [], body: "Done" },
    { issue_id: "T-204", title: "Blocked", triage_label: "ready-for-agent", status: "backlog", parent: "T-200", blockedBy: ["T-199"], body: "Blocked" },
    { issue_id: "T-205", title: "Other parent", triage_label: "ready-for-agent", status: "backlog", parent: "T-999", blockedBy: [], body: "Other" },
  ];
  const planningResponse = [
    "<!-- loop-agent-parallel-tasks:start -->",
    "T-201",
    "T-202",
    "T-203",
    "T-204",
    "T-205",
    "<!-- loop-agent-parallel-tasks:end -->",
  ].join("\n");

  const selected = chooseParallelCodingTasksFromIssues(records, planningResponse);
  assert.deepEqual(selected.map((task) => task.id), ["T-201", "T-202"]);
  assert.ok(selected.every((task) => task.sourcePath === "docs/issues.sqlite"));
});
