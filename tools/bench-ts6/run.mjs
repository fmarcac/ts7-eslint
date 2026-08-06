// Benchmark runner: the current stack, @typescript-eslint 8.66.0 on typescript 6.0.3.
//
// The two stacks cannot share a process, since each needs `typescript` to resolve to a
// different version and the TS 7 side installs a global resolution hook. So each runs
// standalone and prints a JSON report, and the driver compares them.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import ts from "typescript";
import { report, ruleSet } from "./shared.mjs";

const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");

const [tsconfigPath, rootDir, listFile] = process.argv.slice(2);
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);

// With --parse-only the rule set is empty, which isolates parse, convert and scope
// analysis from rule execution.
const rules = process.argv.includes("--parse-only") ? {} : ruleSet(plugin);
const linter = new Linter();
const config = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser, parserOptions: { project: tsconfigPath, tsconfigRootDir: rootDir } },
    plugins: { "@typescript-eslint": plugin },
    rules,
  },
];

const started = performance.now();
const findings = [];
const crashes = [];
let firstFileMs = 0;
for (const [index, file] of files.entries()) {
  const fileStarted = performance.now();
  // A rule that throws must not abort the run: record it and carry on, so one pass
  // enumerates every gap instead of surfacing them one at a time.
  let messages;
  try {
    messages = linter.verify(readFileSync(file, "utf8"), config, file);
  } catch (error) {
    messages = [];
    crashes.push(String(error.message).split("\n")[0].slice(0, 100));
  }
  if (index === 0) {
    firstFileMs = performance.now() - fileStarted;
  }
  for (const message of messages) {
    findings.push(
      `${relative(rootDir, file)}:${message.line}:${message.column} ${message.ruleId ?? "(fatal)"} ${message.messageId ?? message.message.slice(0, 40)}`,
    );
  }
}

report({
  stack: `typescript ${ts.version} + @typescript-eslint 8.66.0`,
  files: files.length,
  ruleCount: Object.keys(rules).length,
  firstFileMs,
  totalMs: performance.now() - started,
  findings,
  crashes,
});
