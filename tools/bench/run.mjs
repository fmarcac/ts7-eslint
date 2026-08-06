// Benchmark driver.
//
// Runs the same files, through the same rules, on both stacks, and compares wall time
// and findings. Each stack runs in its own process because they need `typescript` to
// resolve to different versions, and the TS 7 side installs a global resolution hook.
//
//   node tools/bench/run.mjs                          every corpus
//   node tools/bench/run.mjs --corpus rxjs            one of them
//   node tools/bench/run.mjs <tsconfig> <rootDir>     an ad-hoc directory
//
// Flags: --limit N, --repeat N, --exclude <regex>, --parse-only, --quiet

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { corpora } from "./corpora.mjs";

const argv = process.argv.slice(2);

function flagValue(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}
function isFlagValue(arg) {
  const index = argv.indexOf(arg);
  return index > 0 && ["--limit", "--repeat", "--exclude", "--corpus"].includes(argv[index - 1]);
}

const positional = argv.filter((a) => !a.startsWith("--") && !isFlagValue(a));
const limit = Number(flagValue("--limit", Infinity));
const repeat = Number(flagValue("--repeat", 2));
const parseOnly = argv.includes("--parse-only");
const quiet = argv.includes("--quiet");

/** Every source file under the root, sorted so both stacks see an identical list. */
function collect(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        found.push(...collect(full));
      }
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

function runStack(label, directory, tsconfigPath, rootDir, listFile) {
  const runs = [];
  let payload;
  for (let attempt = 0; attempt < repeat; attempt++) {
    // ESLint matches flat-config `files` patterns against its base path, which is the
    // working directory, so each runner is started at the corpus root. Module resolution
    // follows the script's own location and is unaffected.
    const stdout = execFileSync(
      process.execPath,
      [
        join(directory, "run.mjs"),
        tsconfigPath,
        rootDir,
        listFile,
        ...(parseOnly ? ["--parse-only"] : []),
      ],
      { cwd: rootDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    );
    const line = stdout.split("\n").find((l) => l.startsWith("__BENCH__"));
    if (!line) {
      throw new Error(`${label} produced no report:\n${stdout.slice(-2000)}`);
    }
    payload = JSON.parse(line.slice("__BENCH__".length));
    runs.push(payload.totalMs);
  }
  return { ...payload, best: Math.min(...runs) };
}

function benchmark({ exclude, name, root, tsconfig }) {
  const tsconfigPath = resolve(tsconfig);
  const rootDir = resolve(root);
  if (!existsSync(tsconfigPath) || !existsSync(rootDir)) {
    console.log(`skip ${name}: ${existsSync(tsconfigPath) ? rootDir : tsconfigPath} not found`);
    return undefined;
  }

  const pattern = exclude ? new RegExp(exclude) : undefined;
  const files = collect(rootDir)
    .filter((file) => !pattern?.test(file))
    .sort()
    .slice(0, limit);
  const listFile = join(mkdtempSync(join(tmpdir(), "ts7-eslint-bench-")), "files.txt");
  writeFileSync(listFile, files.join("\n"));

  const ts6 = runStack("TS 6", resolve("tools/bench-ts6"), tsconfigPath, rootDir, listFile);
  const ts7 = runStack("TS 7", resolve("tools/bench-ts7"), tsconfigPath, rootDir, listFile);

  const setSix = new Set(ts6.findings);
  const setSeven = new Set(ts7.findings);
  const onlySix = ts6.findings.filter((f) => !setSeven.has(f));
  const onlySeven = ts7.findings.filter((f) => !setSix.has(f));
  const union = new Set([...ts6.findings, ...ts7.findings]).size;
  const agreement = union === 0 ? 1 : (union - onlySix.length - onlySeven.length) / union;

  return { agreement, files: files.length, name, onlySeven, onlySix, ts6, ts7, union };
}

function speed(ratio) {
  return ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
}

function report(result) {
  const { agreement, name, onlySeven, onlySix, ts6, ts7 } = result;
  console.log(
    name.padEnd(18) +
      String(result.files).padStart(6) +
      (ts6.best / 1000).toFixed(2).padStart(10) +
      (ts7.best / 1000).toFixed(2).padStart(10) +
      speed(ts6.best / ts7.best).padStart(14) +
      String(ts6.findings.length).padStart(8) +
      String(ts7.findings.length).padStart(8) +
      `${(agreement * 100).toFixed(2)}%`.padStart(9),
  );

  const crashes = [
    ...(ts6.crashes ?? []).map((c) => `TS 6: ${c}`),
    ...(ts7.crashes ?? []).map((c) => `TS 7: ${c}`),
  ];
  if (ts7.timing) {
    const { bytesReceived, requestCount, roundTripMs, serverTimeMs } = ts7.timing;
    console.log(
      `    ${requestCount} requests, ${(roundTripMs / 1000).toFixed(2)}s round trip, ` +
        `${(serverTimeMs / 1000).toFixed(2)}s of it server time, ` +
        `${(bytesReceived / 1e6).toFixed(1)} MB received`,
    );
    console.log(
      `    ${ts7.batches.batches} of ${ts7.batches.attempts} attempts batched, covering ${ts7.batches.batched} nodes` +
        (ts7.batches.stoppedAfter ? `; stopped after ${ts7.batches.stoppedAfter}` : "") +
        (ts7.batches.missed?.length
          ? `; not covered: ${ts7.batches.missed.map(([k, n]) => `${k} ${n}`).join(", ")}`
          : ""),
    );
    for (const [method, count] of (ts7.timing.byMethod ?? []).slice(0, 8)) {
      console.log(`      ${String(count).padStart(8)}  ${method}`);
    }
  }
  if (ts7.shortcuts) {
    const { checked, wrong } = ts7.shortcuts;
    console.log(`    ${checked} shortcut answers checked against the compiler, ${wrong} wrong`);
  }
  if (ts7.unanswered > 0) {
    console.log(`    ${String(ts7.unanswered).padStart(4)}x query typescript-go could not answer`);
  }
  if (crashes.length > 0) {
    const grouped = new Map();
    for (const reason of crashes) {
      grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of grouped) {
      console.log(`    ${String(count).padStart(4)}x crash  ${reason}`);
    }
  }
  if (!quiet) {
    for (const [label, list] of [
      ["only TS 6", onlySix],
      ["only TS 7", onlySeven],
    ]) {
      for (const item of list.slice(0, 6)) {
        console.log(`    ${label}: ${item}`);
      }
      if (list.length > 6) {
        console.log(`    ${label}: ... and ${list.length - 6} more`);
      }
    }
  }
}

const chosen = flagValue("--corpus");
const selected =
  positional.length >= 2
    ? [
        {
          exclude: flagValue("--exclude"),
          name: "ad-hoc",
          root: positional[1],
          tsconfig: positional[0],
        },
      ]
    : corpora.filter((c) => !chosen || c.name === chosen);

console.log(
  `rules: ${parseOnly ? "none (parse only)" : "recommended-type-checked"}, ${repeat} run(s) per stack, fastest reported\n`,
);
console.log(
  "corpus".padEnd(18) +
    "files".padStart(6) +
    "TS 6".padStart(10) +
    "TS 7".padStart(10) +
    "".padStart(14) +
    "find 6".padStart(8) +
    "find 7".padStart(8) +
    "agree".padStart(9),
);
console.log("".padEnd(83, "-"));

const results = [];
for (const corpus of selected) {
  const result = benchmark(corpus);
  if (result) {
    report(result);
    results.push(result);
  }
}

if (results.length > 1) {
  const totalSix = results.reduce((sum, r) => sum + r.ts6.best, 0);
  const totalSeven = results.reduce((sum, r) => sum + r.ts7.best, 0);
  const files = results.reduce((sum, r) => sum + r.files, 0);
  const disagreements = results.reduce((sum, r) => sum + r.onlySix.length + r.onlySeven.length, 0);
  const union = results.reduce((sum, r) => sum + r.union, 0);
  console.log("".padEnd(83, "-"));
  console.log(
    "total".padEnd(18) +
      String(files).padStart(6) +
      (totalSix / 1000).toFixed(2).padStart(10) +
      (totalSeven / 1000).toFixed(2).padStart(10) +
      speed(totalSix / totalSeven).padStart(14) +
      "".padStart(16) +
      `${(((union - disagreements) / union) * 100).toFixed(2)}%`.padStart(9),
  );
  console.log(`\ndisagreements: ${disagreements} of ${union} distinct findings`);
}
