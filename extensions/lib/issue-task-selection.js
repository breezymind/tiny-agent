"use strict";

const PARALLEL_TASKS_START = "<!-- loop-agent-parallel-tasks:start -->";
const PARALLEL_TASKS_END = "<!-- loop-agent-parallel-tasks:end -->";
const DEFAULT_MAX_TASKS = 4;

function extractParallelTaskIds(text) {
  const start = text.indexOf(PARALLEL_TASKS_START);
  const end = text.indexOf(PARALLEL_TASKS_END, start + PARALLEL_TASKS_START.length);
  if (start < 0 || end < 0) return [];
  return Array.from(
    text.slice(start + PARALLEL_TASKS_START.length, end).matchAll(/\bT-\d{3}\b/g),
  ).map((match) => match[0]);
}

function issueToTask(record) {
  const id = typeof record.issue_id === "string" ? record.issue_id : null;
  const title = typeof record.title === "string" ? record.title : null;
  if (!id || !title) return null;
  const parent = record.parent ?? record.parent_issue_id;
  const blockers = record.blockedBy ?? record.blocked_by;
  return {
    id,
    label: typeof (record.triage_label ?? record.label) === "string"
      ? (record.triage_label ?? record.label)
      : null,
    title,
    status: ["backlog", "current", "done"].includes(record.status) ? record.status : null,
    parentIds: typeof parent === "string" && parent ? [parent] : [],
    blockedByIds: Array.isArray(blockers) ? blockers.filter((value) => typeof value === "string") : [],
    raw: JSON.stringify(record, null, 2),
    sourcePath: "docs/issues.sqlite",
  };
}

function chooseParallelCodingTasksFromIssues(records, planningResponse, maxTasks = DEFAULT_MAX_TASKS) {
  const preferredIds = new Set(extractParallelTaskIds(planningResponse));
  if (preferredIds.size === 0) return [];
  const preferred = records
    .map(issueToTask)
    .filter((task) => task && preferredIds.has(task.id));
  const eligible = preferred.filter(
    (task) => task.label === "ready-for-agent" && task.status !== "done" && task.blockedByIds.length === 0,
  );
  if (eligible.length < 2) return [];

  const grouped = new Map();
  for (const task of eligible) {
    const parentKey = task.parentIds[0] || `__self__:${task.id}`;
    const bucket = grouped.get(parentKey) || [];
    bucket.push(task);
    grouped.set(parentKey, bucket);
  }
  const bestGroup = [...grouped.values()]
    .filter((tasks) => tasks.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  return bestGroup ? bestGroup.slice(0, maxTasks) : [];
}

module.exports = {
  extractParallelTaskIds,
  chooseParallelCodingTasksFromIssues,
};
