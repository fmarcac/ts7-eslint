// Node-kind coverage over a real codebase.
//
// The fixture differential proves the converter is correct on what it covers. It says
// nothing about what it does not cover, and a hand-written corpus only exercises syntax
// somebody thought to write down. Pointing this at a real project reports every
// TypeScript node kind the converter does not handle, and how often it occurs.
//
//   node packages/typescript-estree/coverage.mjs <tsconfig> <rootDir> [excludeRegex]

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

const files = collect(rootDir)
  .filter((file) => !exclude?.test(file))
  .sort();

const service = getProgramService({ cwd: rootDir, tsconfigPath });
const totals = new Map();
const examples = new Map();
let converted = 0;
let failed = 0;

for (const file of files) {
  const sourceFile = service.getSourceFile(file);
  if (!sourceFile) {
    failed++;
    continue;
  }
  const { unsupported } = convertProgram(sourceFile);
  converted++;
  for (const [kind, count] of unsupported) {
    totals.set(kind, (totals.get(kind) ?? 0) + count);
    if (!examples.has(kind)) {
      examples.set(kind, relative(rootDir, file));
    }
  }
}

clearProgramServices();

console.log(`converted ${converted}/${files.length} files${failed > 0 ? `, ${failed} not in the program` : ""}`);
if (totals.size === 0) {
  console.log("every node kind in this codebase is handled");
} else {
  console.log(`\nunhandled node kinds (${totals.size}):`);
  for (const [kind, count] of [...totals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}x ${kind.padEnd(28)} first seen in ${examples.get(kind)}`);
  }
}
process.exit(totals.size === 0 ? 0 : 1);
