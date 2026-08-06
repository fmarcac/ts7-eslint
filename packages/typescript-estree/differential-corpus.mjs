// The fixture differential, pointed at a real codebase.
//
// Fixtures only cover syntax somebody thought to write down. This compares our AST
// against upstream's for every file in a real project, which is where the interesting
// gaps actually live.
//
//   node packages/typescript-estree/differential-corpus.mjs <tsconfig> <rootDir> [excludeRegex]

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseReference, referenceTypeScriptVersion } from "@ts7-eslint/reference";
import { clearProgramServices, getProgramService } from "@ts7-eslint/ts-api";
import { convertProgram } from "./convert.mjs";

const [tsconfigArg, rootArg, excludeArg] = process.argv.slice(2);
const tsconfigPath = resolve(tsconfigArg);
const rootDir = resolve(rootArg);
const exclude = excludeArg ? new RegExp(excludeArg) : undefined;

function collect(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        found.push(...collect(full));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

function normalize(value) {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value instanceof RegExp) {
    return `RegExp(/${value.source}/${value.flags})`;
  }
  if (typeof value === "bigint") {
    return `BigInt(${value})`;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "parent" || inner === undefined) {
        continue;
      }
      out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

function brief(value) {
  const text = JSON.stringify(value);
  return text === undefined ? "(absent)" : text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function firstDifference(expected, actual, path, out) {
  if (out.length > 0) {
    return;
  }
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    Array.isArray(expected) === Array.isArray(actual);

  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push(`${path}\n      upstream: ${brief(expected)}\n      ours:     ${brief(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      out.push(`${path}: ${expected.length} items upstream, ${actual.length} ours`);
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      firstDifference(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return;
  }
  for (const key of [...new Set(["type", ...Object.keys(expected), ...Object.keys(actual)])]) {
    if (key in expected || key in actual) {
      firstDifference(expected[key], actual[key], `${path}.${key}`, out);
    }
  }
}

const files = collect(rootDir)
  .filter((file) => !exclude?.test(file))
  .sort();
const service = getProgramService({ cwd: rootDir, tsconfigPath });

console.log(`reference: typescript-estree 8.66.0 on typescript ${referenceTypeScriptVersion}`);
console.log(`corpus:    ${files.length} files\n`);

let matched = 0;
const mismatches = [];

for (const file of files) {
  const sourceFile = service.getSourceFile(file);
  if (!sourceFile) {
    mismatches.push({ file: relative(rootDir, file), detail: "not part of the program" });
    continue;
  }
  const code = readFileSync(file, "utf8");
  const { comments: _c, tokens: _t, ...upstream } = parseReference(code, { jsx: false });
  const { ast } = convertProgram(sourceFile);

  const out = [];
  firstDifference(normalize(upstream), normalize(ast), "Program", out);
  if (out.length === 0) {
    matched++;
  } else {
    mismatches.push({ file: relative(rootDir, file), detail: out[0] });
  }
}

clearProgramServices();

console.log(`AST matches upstream: ${matched}/${files.length} files`);
if (mismatches.length > 0) {
  console.log(`\nfirst difference per failing file (showing up to 10):`);
  for (const { detail, file } of mismatches.slice(0, 10)) {
    console.log(`  ${file}\n    ${detail}`);
  }
}
process.exit(mismatches.length === 0 ? 0 : 1);
