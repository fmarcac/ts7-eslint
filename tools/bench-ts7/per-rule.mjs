// Per-rule timing on this stack: which rule costs what, on which file.
//
//   node tools/bench-ts7/per-rule.mjs <tsconfig> <rootDir> <file> [timeoutMs]
//
// Each rule runs alone, in its own linter pass, so a rule that dominates a file is
// visible instead of hidden in the total. Run from the corpus root.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { assertNotAlreadyLoaded, installResolutionHook } from "@ts7-eslint/resolution-hook";
import { ruleSet } from "./shared.mjs";

assertNotAlreadyLoaded();
installResolutionHook();

const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");
const { Linter } = await import("eslint");
const parser = (await import("@ts7-eslint/parser")).default;

const [tsconfigPath, rootDir, file, budget = "20000"] = process.argv.slice(2);
const code = readFileSync(file, "utf8");
const linter = new Linter();
const rules = ruleSet(plugin);

// Warm the program and the AST once, so the reported times are rule time.
linter.verify(code, [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser, parserOptions: { project: tsconfigPath, tsconfigRootDir: rootDir } },
    plugins: { "@typescript-eslint": plugin },
    rules: {},
  },
], file);

const timings = [];
for (const [id, level] of Object.entries(rules)) {
  const started = performance.now();
  try {
    linter.verify(code, [
      {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: { parser, parserOptions: { project: tsconfigPath, tsconfigRootDir: rootDir } },
        plugins: { "@typescript-eslint": plugin },
        rules: { [id]: level },
      },
    ], file);
  } catch (error) {
    process.stdout.write(`  crash  ${id}: ${String(error.message).split("\n")[0]}\n`);
  }
  const elapsed = performance.now() - started;
  timings.push([id, elapsed]);
  process.stdout.write(`${elapsed.toFixed(0).padStart(9)} ms  ${id}\n`);
  if (elapsed > Number(budget)) {
    process.stdout.write("  over budget, stopping\n");
    break;
  }
}

process.stdout.write(`\n${relative(rootDir, file)}\n`);
for (const [id, elapsed] of timings.sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  process.stdout.write(`${elapsed.toFixed(0).padStart(9)} ms  ${id}\n`);
}
