// Phase 3 milestone: upstream @typescript-eslint rules running against real TypeScript
// through our parser, on TypeScript 7.
//
// The S2 spike could only run rules on plain JavaScript with espree, because there was
// no parser yet. This runs them on TypeScript, which is what actually matters, and
// reaches the type-aware rules for the first time.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { clearProgramServices } from "@tseslint7/ts-api";
import { assertNotAlreadyLoaded, installResolutionHook } from "@tseslint7/resolution-hook";

assertNotAlreadyLoaded();
installResolutionHook();

// Only load upstream after the hook is in place.
const require = createRequire(import.meta.url);
const plugin = require("@typescript-eslint/eslint-plugin");
const { Linter } = await import("eslint");
const parser = (await import("./index.mjs")).default;

mkdirSync(".tmp", { recursive: true });
const dir = resolve(mkdtempSync(join(".tmp", "tseslint7-parser-")));
const tsconfigPath = join(dir, "tsconfig.json");
const filePath = join(dir, "source.ts");

const SOURCE = `export const inferrable: number = 1;
export function widen(value: Array<string>): Array<string> {
  return value;
}
export async function waits(p: Promise<number>): Promise<number> {
  return await p;
}
export function assertion(s: string): string {
  return s!;
}
`;

writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      target: "esnext",
    },
    files: ["source.ts"],
  }),
);
writeFileSync(filePath, SOURCE);

const linter = new Linter();
const baseConfig = {
  files: ["**/*.ts"],
  languageOptions: {
    parser,
    parserOptions: { project: tsconfigPath, tsconfigRootDir: dir },
  },
  plugins: { "@typescript-eslint": plugin },
};

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
  }
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
}

function run(ruleId, code = SOURCE) {
  return linter.verify(
    code,
    { ...baseConfig, rules: { [`@typescript-eslint/${ruleId}`]: "error" } },
    filePath,
  );
}

console.log("syntactic rules on real TypeScript:");
check(
  "no-inferrable-types flags `const x: number = 1`",
  run("no-inferrable-types").length,
  1,
);
check(
  "array-type flags Array<string>",
  run("array-type").filter((m) => m.ruleId === "@typescript-eslint/array-type").length,
  2,
);

console.log("\ntype-aware rules, which need a real checker:");
check(
  "no-unnecessary-type-assertion flags a redundant `!`",
  run("no-unnecessary-type-assertion").length,
  1,
);

// no-unsafe-return is the one rule that needs getAwaitedType, which TypeScript 7 does
// not provide at all, so it is reimplemented. Executing is not evidence: check that it
// reports, and that it stays quiet when it should.
check(
  "no-unsafe-return flags returning any from an async function",
  run(
    "no-unsafe-return",
    `declare const anything: any;\nexport async function unsafe(): Promise<string> {\n  return anything;\n}\n`,
  ).length,
  1,
);
check(
  "no-unsafe-return accepts a correctly typed async return",
  run("no-unsafe-return", `export async function safe(): Promise<string> {\n  return "ok";\n}\n`).length,
  0,
);

// Sweep every rule to see how many run end to end. Reported rather than asserted: the
// remaining failures are the ts-api-utils port, which is still outstanding, and the
// point of this number is to track it honestly.
const ruleIds = Object.keys(plugin.rules);
let executed = 0;
const reasons = new Map();
const failedRules = [];
for (const ruleId of ruleIds) {
  try {
    run(ruleId);
    executed++;
  } catch (error) {
    const reason = String(error.message).split("\n")[0].slice(0, 70);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    failedRules.push(ruleId);
  }
}

console.log(`\nrules that executed on TypeScript: ${executed}/${ruleIds.length}`);
if (reasons.size > 0) {
  console.log("outstanding failures, by cause:");
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}x ${reason}`);
  }
  console.log(`affected rules: ${failedRules.slice(0, 12).join(", ")}`);
  if (failedRules.length > 12) {
    console.log(`  ... and ${failedRules.length - 12} more`);
  }
}

clearProgramServices();
rmSync(dir, { force: true, recursive: true });

console.log(`\n${failures === 0 ? "parser PASS" : `parser FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
