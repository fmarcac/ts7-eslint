// Benchmark driver.
//
// Runs the same files, through the same rules, on both stacks, and compares wall time
// and findings. Each stack runs in its own process because they need `typescript` to
// resolve to different versions.
//
//   node tools/bench/run.mjs <tsconfig> <rootDir> [--limit N] [--repeat N]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [tsconfigArg, rootArg, ...flags] = process.argv.slice(2);
if (!tsconfigArg || !rootArg) {
  console.error("usage: node tools/bench/run.mjs <tsconfig> <rootDir> [--limit N] [--repeat N]");
  process.exit(2);
}

function flag(name, fallback) {
  const index = flags.indexOf(name);
  return index === -1 ? fallback : Number(flags[index + 1]);
}
const limit = flag("--limit", Infinity);
// Files matching this are skipped. Test files typically import devDependencies, and an
// uninstalled import resolves to an error type, which buries real differences under
// hundreds of spurious no-unsafe-* reports on both sides.
const excludeIndex = flags.indexOf("--exclude");
const exclude = excludeIndex === -1 ? undefined : new RegExp(flags[excludeIndex + 1]);
const repeat = flag("--repeat", 2);

const tsconfigPath = resolve(tsconfigArg);
const rootDir = resolve(rootArg);

/** Every .ts file under the root, sorted so both stacks see an identical list. */
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
  .sort()
  .slice(0, limit);
const listFile = join(mkdtempSync(join(tmpdir(), "tseslint7-bench-")), "files.txt");
writeFileSync(listFile, files.join("\n"));

console.log(`corpus:  ${files.length} files under ${rootDir}`);
console.log(`tsconfig: ${tsconfigPath}`);
console.log(`repeat:  ${repeat} run(s) per stack, reporting the fastest\n`);

// ESLint matches flat-config `files` patterns against its base path, which is the
// working directory. The corpus lives outside this repo, so each runner is started
// there. Module resolution follows the script's own location and is unaffected.
function runStack(label, directory) {
  const runs = [];
  let payload;
  for (let attempt = 0; attempt < repeat; attempt++) {
    const stdout = execFileSync(
      process.execPath,
      [join(directory, "run.mjs"), tsconfigPath, rootDir, listFile, ...(flags.includes("--parse-only") ? ["--parse-only"] : [])],
      { cwd: rootDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const line = stdout.split("\n").find((l) => l.startsWith("__BENCH__"));
    if (!line) {
      throw new Error(`${label} produced no report:\n${stdout.slice(-2000)}`);
    }
    payload = JSON.parse(line.slice("__BENCH__".length));
    runs.push(payload.totalMs);
    console.log(`  ${label} run ${attempt + 1}: ${(payload.totalMs / 1000).toFixed(2)} s`);
  }
  return { ...payload, best: Math.min(...runs) };
}

const ts6 = runStack("TS 6", resolve("tools/bench-ts6"));
const ts7 = runStack("TS 7", resolve("tools/bench-ts7"));

const perFile6 = ts6.best / ts6.files;
const perFile7 = ts7.best / ts7.files;

console.log(`\n${"".padEnd(58, "-")}`);
console.log(`${"".padEnd(30)}${"TS 6".padStart(12)}${"TS 7".padStart(14)}`);
console.log(`${"stack".padEnd(30)}${"6.0.3".padStart(12)}${"7.0.2".padStart(14)}`);
console.log(`${"rules enabled".padEnd(30)}${String(ts6.ruleCount).padStart(12)}${String(ts7.ruleCount).padStart(14)}`);
console.log(`${"first file (cold), ms".padEnd(30)}${ts6.firstFileMs.toFixed(0).padStart(12)}${ts7.firstFileMs.toFixed(0).padStart(14)}`);
console.log(`${"total, s".padEnd(30)}${(ts6.best / 1000).toFixed(2).padStart(12)}${(ts7.best / 1000).toFixed(2).padStart(14)}`);
console.log(`${"per file, ms".padEnd(30)}${perFile6.toFixed(1).padStart(12)}${perFile7.toFixed(1).padStart(14)}`);
console.log(`${"findings".padEnd(30)}${String(ts6.findings.length).padStart(12)}${String(ts7.findings.length).padStart(14)}`);
console.log(`${"".padEnd(58, "-")}`);

const ratio = ts6.best / ts7.best;
console.log(
  ratio >= 1
    ? `\nTS 7 is ${ratio.toFixed(2)}x faster on this corpus.`
    : `\nTS 7 is ${(1 / ratio).toFixed(2)}x slower on this corpus.`,
);

// Findings are the point: a faster linter that reports different things is not a
// drop-in replacement.
const setSix = new Set(ts6.findings);
const setSeven = new Set(ts7.findings);
const onlySix = ts6.findings.filter((f) => !setSeven.has(f));
const onlySeven = ts7.findings.filter((f) => !setSix.has(f));

console.log(`\nfindings only from TS 6: ${onlySix.length}`);
console.log(`findings only from TS 7: ${onlySeven.length}`);
const agreement = ts6.findings.length === 0 ? 1 : (ts6.findings.length - onlySix.length) / ts6.findings.length;
console.log(`agreement: ${(agreement * 100).toFixed(2)}%`);

for (const [label, stack] of [["TS 6", ts6], ["TS 7", ts7]]) {
  const crashes = stack.crashes ?? [];
  if (crashes.length > 0) {
    const grouped = new Map();
    for (const reason of crashes) {
      grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
    }
    console.log(`\n${label} rule crashes: ${crashes.length} across ${grouped.size} cause(s)`);
    for (const [reason, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}x ${reason}`);
    }
  }
}

for (const [label, list] of [["TS 6 only", onlySix], ["TS 7 only", onlySeven]]) {
  if (list.length > 0) {
    console.log(`\n${label}, first 15:`);
    for (const item of list.slice(0, 15)) {
      console.log(`  ${item}`);
    }
  }
}
