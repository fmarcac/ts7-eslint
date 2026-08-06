// S2 gate: upstream @typescript-eslint loads and its rules execute against the TS 7
// shim, with no consumer package.json changes.
//
// Type-aware rules are out of scope here; they need the parser from phase 3. What this
// proves is that the redirect works, that upstream survives loading against the shim,
// and that rules needing no type information already run correctly.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertNotAlreadyLoaded, installResolutionHook } from "@tseslint7/resolution-hook";

const redirects = [];
assertNotAlreadyLoaded();
installResolutionHook({ onRedirect: (specifier, from) => redirects.push({ specifier, from }) });

// Only require upstream *after* the hook is installed.
const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");
const shim = require("@tseslint7/ts-compat");
const { Linter } = await import("eslint");

const ruleIds = Object.keys(plugin.rules);
console.log(`shim reports TypeScript ${shim.version} (API contract), backed by ${shim.tsVersion}`);
console.log(`plugin loaded: ${ruleIds.length} rules`);
console.log(`typescript redirected for ${redirects.length} requester(s), first few:`);
for (const { from } of redirects.slice(0, 4)) {
  console.log(`   ${from.split("node_modules/").pop()}`);
}

// A rule needing no type information, run on plain JS through espree. If the shim were
// broken at load time we would not get here; if the rule reached for the compiler it
// would throw.
const linter = new Linter();
const messages = linter.verify("const xs = new Array(1, 2, 3);", {
  plugins: { "@typescript-eslint": plugin },
  rules: { "@typescript-eslint/no-array-constructor": "error" },
});

console.log(`\nno-array-constructor on plain JS: ${messages.length} message(s)`);
for (const m of messages) {
  console.log(`   ${m.line}:${m.column} ${m.message}`);
}
const ruleWorks =
  messages.length === 1 && messages[0].ruleId === "@typescript-eslint/no-array-constructor";

// Sweep every rule to see how many execute without reaching for the compiler.
let executed = 0;
const failures = new Map();
for (const ruleId of ruleIds) {
  try {
    linter.verify("const x = 1;\nfunction f(a) { return a; }\n", {
      plugins: { "@typescript-eslint": plugin },
      rules: { [`@typescript-eslint/${ruleId}`]: "error" },
    });
    executed++;
  } catch (error) {
    const reason = String(error.message).split("\n")[0].slice(0, 80);
    failures.set(reason, (failures.get(reason) ?? 0) + 1);
  }
}
console.log(`\nrules that executed on plain JS: ${executed}/${ruleIds.length}`);
if (failures.size > 0) {
  console.log("failure reasons:");
  for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`   ${String(count).padStart(3)}x ${reason}`);
  }
}

// Static check of the shim surface. Extracted from the installed sources rather than
// hardcoded, so it stays honest as upstream changes.
function collectTsMembers(dir) {
  const found = new Set();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const source = readFileSync(join(entry.parentPath ?? dir, entry.name), "utf8");
    for (const match of source.matchAll(/\bts\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

const pluginDist = dirname(require.resolve("@typescript-eslint/eslint-plugin"));
const used = collectTsMembers(pluginDist);
const missing = [...used].filter((member) => !(member in shim)).sort();

console.log(`\nts.* members referenced by upstream: ${used.size}`);
console.log(`covered by the shim: ${used.size - missing.length}`);
if (missing.length > 0) {
  console.log(`still to implement (${missing.length}): ${missing.join(", ")}`);
}

const pass = redirects.length > 0 && ruleWorks;
console.log(`\n${pass ? "S2 PASS" : "S2 FAIL"}`);
process.exit(pass ? 0 : 1);
