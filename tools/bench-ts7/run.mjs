// Benchmark runner: this project's stack, @typescript-eslint 8.66.0 on typescript 7.0.2.
//
// Deliberately the same shape as the TS 6 runner: same file list, same rules, same
// message normalisation. The only difference is which parser and compiler are in play.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { assertNotAlreadyLoaded, installResolutionHook } from "@tseslint7/resolution-hook";
import { batchStats, programTiming, shortcutAudit, unansweredQueries } from "@tseslint7/ts-api";
import { report, ruleSet } from "./shared.mjs";

assertNotAlreadyLoaded();
installResolutionHook();

const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");
const { Linter } = await import("eslint");
const parser = (await import("@tseslint7/parser")).default;
const { version } = require("typescript");

const [tsconfigPath, rootDir, listFile] = process.argv.slice(2);
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);

// With --parse-only the rule set is empty, which isolates parse, convert and scope
// analysis from rule execution.
const rules = process.argv.includes("--parse-only") ? {} : ruleSet(plugin);
const verbose = process.argv.includes("--verbose");
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
  if (verbose) {
    const elapsed = (performance.now() - fileStarted).toFixed(0).padStart(8);
    process.stderr.write(`${elapsed} ms  ${relative(rootDir, file)}\n`);
  }
  for (const message of messages) {
    findings.push(
      `${relative(rootDir, file)}:${message.line}:${message.column} ${message.ruleId ?? "(fatal)"} ${message.messageId ?? message.message.slice(0, 40)}`,
    );
  }
}

report({
  stack: `typescript ${version} + @tseslint7 parser`,
  files: files.length,
  ruleCount: Object.keys(rules).length,
  firstFileMs,
  totalMs: performance.now() - started,
  findings,
  crashes,
  unanswered: unansweredQueries(),
  timing: programTiming(),
  batches: batchStats(),
  shortcuts: shortcutAudit(),
});
