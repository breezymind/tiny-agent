#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const homeDir = process.env.HOME || process.env.USERPROFILE;
if (!process.env.PI_CODING_AGENT_DIR && homeDir) {
  process.env.PI_CODING_AGENT_DIR = path.join(homeDir, ".pi", "agent");
}

const command = process.env.AI_PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi");
const child = spawn(command, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`ai: failed to start ${command}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
