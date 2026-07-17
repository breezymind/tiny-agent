#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printUsage() {
  console.log(`Usage: node scripts/package-smoke.mjs [--keep] [--skip-install]

Creates an npm package archive, verifies that it exists, and checks that the
runtime extension files and core package files are included in the archive.
It then installs the archive in an isolated directory and runs the packaged
issue-store CLI against a temporary project root.
`);
}

function parseArguments(argv) {
  let keep = false;
  let skipInstall = false;
  for (const argument of argv) {
    if (argument === "--keep") {
      keep = true;
    } else if (argument === "--skip-install") {
      skipInstall = true;
    } else if (argument === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { keep, skipInstall };
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("npm pack did not return JSON metadata");
    return JSON.parse(stdout.slice(start, end + 1));
  }
}

function runNpmPack(destination) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", destination],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`npm pack failed (status ${result.status}):\n${details}`);
  }
  return parseJsonOutput(result.stdout);
}

function archiveFileSet(archive) {
  const result = spawnSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar could not inspect ${archive}: ${result.stderr.trim()}`);
  }

  const files = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const normalized = line.replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized) continue;
    files.add(normalized.startsWith("package/") ? normalized.slice("package/".length) : normalized);
  }
  return files;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}${details ? `:\n${details}` : ""}`);
  }
  return result;
}

function installArchive(archive, installDirectory) {
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      installDirectory,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    {
      env: {
        ...process.env,
        npm_config_loglevel: "error",
      },
      stdio: "inherit",
    },
  );
}

function runInstalledRuntimeSmoke(packageDirectory, runtimeRoot) {
  const issueStorePath = join(packageDirectory, "scripts", "issue-store.js");
  if (!existsSync(issueStorePath)) {
    throw new Error(`Installed package is missing the issue-store CLI: ${issueStorePath}`);
  }

  const result = run(process.execPath, [issueStorePath, "init", "--root", runtimeRoot]);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Installed issue-store did not return JSON: ${result.stdout}`);
  }
  if (payload?.ok !== true || payload?.command !== "init" || payload?.vector?.loaded !== true) {
    throw new Error(`Installed issue-store runtime smoke returned an invalid payload: ${result.stdout}`);
  }
}

function requiredPackageFiles() {
  const extensionDirectory = join(packageRoot, "extensions");
  const extensionFiles = walkFiles(extensionDirectory).map((path) =>
    relative(packageRoot, path),
  );

  return [
    "README.md",
    "package.json",
    "scripts/ai.js",
    "scripts/issue-embedding.py",
    "scripts/issue-store.js",
    "skills/code-review/SKILL.md",
    "skills/skills-lock.json",
    ...extensionFiles,
  ];
}

function main() {
  const { keep, skipInstall } = parseArguments(process.argv.slice(2));
  const destination = mkdtempSync(join(tmpdir(), "tiny-agent-package-"));
  const installDirectory = mkdtempSync(join(tmpdir(), "tiny-agent-package-install-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "tiny-agent-package-runtime-"));

  try {
    const metadata = runNpmPack(destination);
    if (!Array.isArray(metadata) || metadata.length === 0 || !metadata[0]?.filename) {
      throw new Error("npm pack returned no package metadata");
    }

    const packageInfo = metadata[0];
    const archive = resolve(destination, packageInfo.filename);
    if (!existsSync(archive) || statSync(archive).size === 0) {
      throw new Error(`npm pack did not create a non-empty archive: ${archive}`);
    }

    const archiveFiles = archiveFileSet(archive);
    const required = [...new Set(requiredPackageFiles())];
    const missing = required.filter((path) => !archiveFiles.has(path));
    if (missing.length > 0) {
      throw new Error(`Package archive is missing required files:\n- ${missing.join("\n- ")}`);
    }

    if (!skipInstall) {
      installArchive(archive, installDirectory);
      const packageDirectory = join(installDirectory, "node_modules", packageInfo.name);
      runInstalledRuntimeSmoke(packageDirectory, runtimeRoot);
      console.log("package-smoke: installed runtime smoke PASS");
    }

    console.log(`package-smoke: PASS (${packageInfo.filename}, ${statSync(archive).size} bytes)`);
    console.log(`package-smoke: verified ${required.length} core/runtime files in the archive`);
    if (keep) console.log(`package-smoke: archive kept at ${archive}`);
  } finally {
    if (!keep) rmSync(destination, { recursive: true, force: true });
    rmSync(installDirectory, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`package-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
