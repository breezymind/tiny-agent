#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFiles = [
  ".mcp.json",
  "settings.json",
  "models-store.json",
  "trust.json",
  "docs/issues.sqlite",
];
const sourceRoots = [
  ".github/",
  "extensions/",
  "scripts/",
  "skills/",
  "test/",
  "templates/",
  "docs/",
  "README.md",
  "AGENT.md",
  "CONTEXT.md",
  ".gitignore",
  "package.json",
  "package-lock.json",
];

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function parseArguments(argv) {
  const strict = argv.includes("--strict");
  const unknown = argv.filter((argument) => argument !== "--strict");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  return { strict };
}

function changedPaths() {
  return runGit(["status", "--porcelain=v1"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => {
      const renameSeparator = line.indexOf(" -> ");
      return renameSeparator >= 0 ? line.slice(renameSeparator + 4) : line;
    });
}

function trackedRuntimeFiles() {
  return runGit(["ls-files", "--", ...runtimeFiles])
    .split(/\r?\n/)
    .filter(Boolean);
}

function ignoredRuntimeFiles() {
  return runtimeFiles.filter((file) => {
    const result = spawnSync("git", ["check-ignore", "-q", "--", file], {
      cwd: packageRoot,
    });
    return result.status === 0;
  });
}

function isSourcePath(file) {
  return sourceRoots.some((root) => file === root || file.startsWith(root));
}

function assertPackageBoundary() {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const files = Array.isArray(packageJson.files) ? packageJson.files : [];
  const leakedRuntimeFiles = runtimeFiles.filter((runtimeFile) =>
    files.some((entry) => runtimeFile === entry || runtimeFile.startsWith(`${entry}/`)),
  );
  if (leakedRuntimeFiles.length > 0) {
    throw new Error(`Package files include runtime state: ${leakedRuntimeFiles.join(", ")}`);
  }
}

function main() {
  const { strict } = parseArguments(process.argv.slice(2));
  const tracked = trackedRuntimeFiles();
  const ignored = ignoredRuntimeFiles();
  if (tracked.length > 0) {
    throw new Error(`Runtime files are still tracked by Git: ${tracked.join(", ")}`);
  }
  if (ignored.length !== runtimeFiles.length) {
    const missing = runtimeFiles.filter((file) => !ignored.includes(file));
    throw new Error(`Runtime files are not ignored: ${missing.join(", ")}`);
  }
  assertPackageBoundary();

  const changed = changedPaths();
  const unexpected = changed.filter((file) => !isSourcePath(file) && !runtimeFiles.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`Changes fall outside the declared source boundary: ${unexpected.join(", ")}`);
  }
  if (strict && changed.length > 0) {
    throw new Error(`Strict release check requires a clean worktree (${changed.length} changed paths)`);
  }

  console.log(
    `worktree-check: PASS (runtime files ignored, package boundary sealed${
      strict ? ", clean worktree" : ""
    })`,
  );
  if (!strict && changed.length > 0) {
    console.log(`worktree-check: INFO (${changed.length} source changes present; use --strict before release)`);
  }
}

try {
  main();
} catch (error) {
  console.error(`worktree-check: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
