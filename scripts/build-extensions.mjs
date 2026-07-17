#!/usr/bin/env node

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDirectory = join(packageRoot, "extensions");
const externalPiPackage = "@earendil-works/pi-coding-agent";

function printUsage() {
  console.log(`Usage: node scripts/build-extensions.mjs [options]

Options:
  --builder <auto|esbuild|bun>  Select the compiler (default: auto).
  --out-dir <path>              Keep build output in this directory.
  --keep                        Keep the temporary output directory.
  --help                        Show this help.
`);
}

function parseArguments(argv) {
  let builder = "auto";
  let outDirectory;
  let keep = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }
    if (argument === "--keep") {
      keep = true;
      continue;
    }
    if (argument === "--builder" || argument.startsWith("--builder=")) {
      const value = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argv[++index];
      if (!value || !["auto", "esbuild", "bun"].includes(value)) {
        throw new Error("--builder must be auto, esbuild, or bun");
      }
      builder = value;
      continue;
    }
    if (argument === "--out-dir" || argument.startsWith("--out-dir=")) {
      const value = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argv[++index];
      if (!value) throw new Error("--out-dir requires a path");
      outDirectory = resolve(process.cwd(), value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { builder, keep, outDirectory };
}

function executableOnPath(name) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [name, `${name}.cmd`] : [name];

  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

function localExecutable(name) {
  const candidate = join(
    packageRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  return existsSync(candidate) ? candidate : undefined;
}

function resolveBuilder(requested) {
  const localEsbuild = localExecutable("esbuild");
  const bun = executableOnPath("bun");
  const npx = executableOnPath("npx");

  if (requested === "esbuild" || (requested === "auto" && localEsbuild)) {
    if (localEsbuild) {
      return { command: localEsbuild, kind: "esbuild", label: "local esbuild", prefix: [] };
    }
    if (npx) {
      return { command: npx, kind: "esbuild", label: "npx esbuild", prefix: ["--yes", "esbuild"] };
    }
    throw new Error("esbuild was requested, but neither local esbuild nor npx is available");
  }

  if (requested === "bun" || (requested === "auto" && bun)) {
    if (bun) return { command: bun, kind: "bun", label: "bun build", prefix: [] };
    throw new Error("bun was requested, but bun is not available on PATH");
  }

  if (requested === "auto" && npx) {
    return { command: npx, kind: "esbuild", label: "npx esbuild", prefix: ["--yes", "esbuild"] };
  }

  throw new Error("No supported builder found. Install esbuild, install bun, or provide npx.");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function findExtensionEntrypoints() {
  return readdirSync(extensionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(extensionsDirectory, entry.name))
    .sort();
}

function buildArguments(builder, source, output) {
  if (builder.kind === "bun") {
    return [
      ...builder.prefix,
      "build",
      source,
      `--outfile=${output}`,
      "--target=node",
      "--format=esm",
      `--external:${externalPiPackage}`,
    ];
  }

  return [
    ...builder.prefix,
    source,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    `--external:${externalPiPackage}`,
    `--outfile=${output}`,
  ];
}

function main() {
  const { builder: requestedBuilder, keep, outDirectory } = parseArguments(
    process.argv.slice(2),
  );
  const entrypoints = findExtensionEntrypoints();
  if (entrypoints.length === 0) throw new Error("No extensions/*.ts entrypoints found");

  const builder = resolveBuilder(requestedBuilder);
  const temporaryDirectory = outDirectory === undefined;
  const outputDirectory = outDirectory ?? mkdtempSync(join(tmpdir(), "tiny-agent-extensions-"));
  mkdirSync(outputDirectory, { recursive: true });

  try {
    console.log(
      `build-extensions: compiling ${entrypoints.length} entrypoints with ${builder.label}`,
    );
    const outputs = [];

    for (const source of entrypoints) {
      const output = join(outputDirectory, `${source.slice(extensionsDirectory.length + 1, -3)}.mjs`);
      outputs.push(output);
      run(builder.command, buildArguments(builder, source, output));
    }

    for (const output of outputs) {
      if (!existsSync(output) || statSync(output).size === 0) {
        throw new Error(`Builder did not produce a non-empty output: ${output}`);
      }
      run(process.execPath, ["--check", output]);
    }

    console.log(`build-extensions: PASS (${outputs.length} bundles, syntax checked)`);
    if (temporaryDirectory && keep) {
      console.log(`build-extensions: output kept at ${outputDirectory}`);
    }
  } finally {
    if (temporaryDirectory && !keep) {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`build-extensions: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
