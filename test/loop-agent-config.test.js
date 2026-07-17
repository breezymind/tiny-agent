const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadWorkflowConfig,
  saveWorkflowConfig,
} = require("../extensions/lib/loop-agent-config.ts");

test("workflow config reads and writes an injected settings path without losing other Pi settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-config-"));
  const settingsPath = path.join(root, "settings.json");
  try {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", loopAgent: { maxImprovementRounds: 1 } }),
    );

    const config = loadWorkflowConfig(settingsPath);
    assert.equal(config.maxImprovementRounds, 1);
    assert.equal(config.planningModel, null);

    saveWorkflowConfig(settingsPath, {
      ...config,
      codingModel: "fake/model",
      maxImprovementRounds: 4,
    });

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(saved.theme, "dark");
    assert.equal(saved.loopAgent.codingModel, "fake/model");
    assert.equal(saved.loopAgent.maxImprovementRounds, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
