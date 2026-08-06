// Which rule asks the compiler what. Run from the corpus root:
//   node attribute.mjs <tsconfig> <rootDir> <listFile>
//
// The counters go on the raw checker before installTypeCompat wraps it, so a memo hit is
// not counted and what is left is round trips. Each rule's visitors set a label, so every
// request is attributed to whoever was on the stack.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertNotAlreadyLoaded, installResolutionHook } from "@ts7-eslint/resolution-hook";
import { getProgramService } from "@ts7-eslint/ts-api";
import { ruleSet } from "./shared.mjs";

assertNotAlreadyLoaded();
installResolutionHook();

const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");
const { Linter } = await import("eslint");
const parser = (await import("@ts7-eslint/parser")).default;

const [tsconfigPath, rootDir, listFile] = process.argv.slice(2);
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);

let current = "(outside a rule)";
const counts = new Map();

const service = getProgramService({ cwd: rootDir, tsconfigPath });
const raw = service.project.checker;
for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(raw))) {
  if (name === "constructor" || typeof raw[name] !== "function") {
    continue;
  }
  const original = raw[name];
  Object.defineProperty(raw, name, {
    configurable: true,
    writable: true,
    value(...args) {
      const key = `${current}\t${name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return original.apply(raw, args);
    },
  });
}
// Now let the compat layer install its memos on top of the counters.
void service.checker;

const rules = ruleSet(plugin);
const wrapped = {};
for (const [id, rule] of Object.entries(plugin.rules)) {
  wrapped[id] = {
    ...rule,
    create(context, options) {
      const visitor = rule.create(context, options);
      const out = {};
      for (const [selector, handler] of Object.entries(visitor)) {
        if (typeof handler !== "function") {
          out[selector] = handler;
          continue;
        }
        out[selector] = function (...args) {
          const previous = current;
          current = id;
          try {
            return handler.apply(this, args);
          } finally {
            current = previous;
          }
        };
      }
      return out;
    },
  };
}

const linter = new Linter();
const config = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser, parserOptions: { project: tsconfigPath, tsconfigRootDir: rootDir } },
    plugins: { "@typescript-eslint": { ...plugin, rules: wrapped } },
    rules,
  },
];

for (const file of files) {
  try {
    linter.verify(readFileSync(file, "utf8"), config, file);
  } catch {
    // A rule that throws must not abort the sweep.
  }
}

const byRule = new Map();
const byMethod = new Map();
let total = 0;
for (const [key, count] of counts) {
  const [rule, method] = key.split("\t");
  byRule.set(rule, (byRule.get(rule) ?? 0) + count);
  byMethod.set(method, (byMethod.get(method) ?? 0) + count);
  total += count;
}

console.log(`\ntotal requests: ${total}`);
console.log("\nby rule");
for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(count).padStart(9)}  ${rule}`);
}
console.log("\nby method");
for (const [method, count] of [...byMethod].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(count).padStart(9)}  ${method}`);
}
console.log("\nby rule and method");
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${String(count).padStart(9)}  ${key.replace("\t", "  ")}`);
}
