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
//
// The import is not always called `ts`. Both upstream and ts-api-utils ship rollup
// bundles that rename it (`ts9`, plus a `ts9__default.default` interop alias), so the
// local name is read out of each file's own require of "typescript" rather than assumed.
// Guessing `ts` here is how isStringLiteralLike, referenced only as `ts9.` from
// ts-api-utils, was missing from the shim while this check reported full coverage.
function collectTsMembers(dir) {
  const found = new Set();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|cjs|mjs)$/.test(entry.name)) {
      continue;
    }
    const source = readFileSync(join(entry.parentPath ?? dir, entry.name), "utf8");
    const aliases = new Set(["ts"]);
    for (const pattern of [
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["']typescript["']\)/g,
      /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,[^;]*?)?\s*from\s*["']typescript["']/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        aliases.add(match[1]);
        aliases.add(`${match[1]}__default.default`);
      }
    }
    for (const alias of aliases) {
      const escaped = alias.replace(/[.$]/g, "\\$&");
      for (const match of source.matchAll(
        new RegExp(`(?<![\\w$.])${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"),
      )) {
        found.add(match[1]);
      }
    }
  }
  return found;
}

// Everything that runs against the shim. Upstream's own typescript-estree is redirected
// to this project's, so its compiler use is deliberately not counted.
const consumers = [
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/type-utils",
  "@typescript-eslint/utils",
  "ts-api-utils",
];
const pluginEntry = require.resolve("@typescript-eslint/eslint-plugin");
// Resolve the rest the way the plugin itself would, since they are its dependencies.
const fromPlugin = createRequire(pluginEntry);
const used = new Set();
for (const name of consumers) {
  let entry;
  try {
    entry = fromPlugin.resolve(name);
  } catch {
    console.log(`   (not installed, skipped: ${name})`);
    continue;
  }
  for (const member of collectTsMembers(dirname(entry))) {
    used.add(member);
  }
}
const missing = [...used].filter((member) => !(member in shim)).sort();

console.log(`\nts.* members referenced by upstream: ${used.size}`);
console.log(`covered by the shim: ${used.size - missing.length}`);
if (missing.length > 0) {
  console.log(`still to implement (${missing.length}): ${missing.join(", ")}`);
}

const pass = redirects.length > 0 && ruleWorks;
console.log(`\n${pass ? "S2 PASS" : "S2 FAIL"}`);
process.exit(pass ? 0 : 1);
