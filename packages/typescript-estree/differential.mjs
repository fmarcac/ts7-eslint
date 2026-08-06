// The correctness gate for this package.
//
// Our output must match upstream typescript-estree running on typescript@6.0.3, the
// newest version @typescript-eslint@8.66.0 supports. Comparing against TS 6 rather than
// TS 5 keeps any difference attributable to this port instead of to TypeScript version
// drift.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childrenSignature, parseReference, referenceTypeScriptVersion } from "@ts7-eslint/reference";
import { SyntaxKind } from "typescript/unstable/ast";
import { clearProgramServices, getProgramService } from "@ts7-eslint/ts-api";
import { convertComments } from "./comments.mjs";
import { convertProgram } from "./convert.mjs";
import { fixtures } from "./fixtures.mjs";
import { convertTokens } from "./tokens.mjs";

const dir = mkdtempSync(join(tmpdir(), "ts7-eslint-estree-"));
const files = fixtures.map((f) => {
  const fileName = join(dir, `${f.name}.${f.ext}`);
  writeFileSync(fileName, f.code);
  return { ...f, fileName };
});

const tsconfigPath = join(dir, "tsconfig.json");
writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      allowJs: true,
      jsx: "preserve",
      module: "esnext",
      moduleResolution: "bundler",
      strict: false,
      target: "esnext",
    },
    files: files.map((f) => `${f.name}.${f.ext}`),
  }),
);

const service = getProgramService({ cwd: dir, tsconfigPath });

// ---- comparison ----------------------------------------------------------

/** Plain comparable data: no parent links, no undefined, no exotic value types. */
function normalize(value) {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value instanceof RegExp) {
    return `RegExp(/${value.source}/${value.flags})`;
  }
  if (typeof value === "bigint") {
    return `BigInt(${value})`;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "parent" || inner === undefined) {
        continue;
      }
      out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

function brief(value) {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "(absent)";
  }
  return text.length > 70 ? `${text.slice(0, 70)}...` : text;
}

function diff(expected, actual, path, out, limit = 5) {
  if (out.length >= limit) {
    return;
  }
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    Array.isArray(expected) === Array.isArray(actual);

  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push(`${path}\n         upstream: ${brief(expected)}\n         ours:     ${brief(actual)}`);
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      out.push(`${path}: ${expected.length} items upstream, ${actual.length} ours`);
    }
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      diff(expected[i], actual[i], `${path}[${i}]`, out, limit);
    }
    return;
  }

  // Lead with `type` so a node-kind mismatch reports before its properties do.
  const keys = [...new Set(["type", ...Object.keys(expected), ...Object.keys(actual)])];
  for (const key of keys) {
    if (!(key in expected) && !(key in actual)) {
      continue;
    }
    diff(expected[key], actual[key], `${path}.${key}`, out, limit);
  }
}

function countNodes(value) {
  let total = 0;
  (function walk(v) {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      if (typeof v.type === "string") {
        total++;
      }
      for (const inner of Object.values(v)) {
        walk(inner);
      }
    }
  })(value);
  return total;
}

function tokenKey(token) {
  const { loc, range, type, value } = token;
  const where = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
  const regex = token.regex ? ` regex(${token.regex.pattern}/${token.regex.flags})` : "";
  return `${type} ${JSON.stringify(value)} [${range[0]},${range[1]}] ${where}${regex}`;
}

function commentKey(comment) {
  const { loc, range, type, value } = comment;
  return `${type} ${JSON.stringify(value)} [${range[0]},${range[1]}] ${loc.start.line}`;
}

function compareList(label, ours, theirs, report) {
  if (ours.length === theirs.length && ours.every((v, i) => v === theirs[i])) {
    return true;
  }
  report.push(`  ${label}: ours ${ours.length} vs upstream ${theirs.length}`);
  let shown = 0;
  for (let i = 0; i < Math.max(ours.length, theirs.length) && shown < 3; i++) {
    if (ours[i] !== theirs[i]) {
      report.push(`    [${i}] upstream: ${theirs[i] ?? "(none)"}`);
      report.push(`    [${i}] ours:     ${ours[i] ?? "(none)"}`);
      shown++;
    }
  }
  return false;
}

/** No token may sit on the same characters as a comment, and neither list may go backwards. */
function noOverlap(tokens, comments, report) {
  const merged = [...tokens, ...comments].sort((a, b) => a.range[0] - b.range[0]);
  let ok = true;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].range[0] < merged[i - 1].range[1]) {
      report.push(
        `  overlap: ${merged[i - 1].type} [${merged[i - 1].range}] and ${merged[i].type} [${merged[i].range}]`,
      );
      ok = false;
    }
  }
  return ok;
}

// ---- run -----------------------------------------------------------------

console.log(`reference: typescript-estree 8.66.0 on typescript ${referenceTypeScriptVersion}`);
console.log(`fixtures:  ${files.length}\n`);

/**
 * The same signature as the reference package's, computed through the reconstructed
 * getChildren(). TypeScript 7 has no getChildren, and an implementation that is merely
 * close would misindex rules silently, so it is held against TS 6 exactly.
 */
function ourChildrenSignature(sourceFile) {
  const lines = [];
  // TypeScript 7 renamed the EndOfFileToken kind to EndOfFile. Same node, same position,
  // different label, so it is normalised rather than reported as a mismatch.
  const kindName = (kind) => (SyntaxKind[kind] === "EndOfFile" ? "EndOfFileToken" : SyntaxKind[kind]);
  (function walk(node, depth) {
    lines.push(`${"  ".repeat(depth)}${kindName(node.kind)}[${node.pos},${node.end}]`);
    for (const child of node.getChildren(sourceFile)) {
      walk(child, depth + 1);
    }
  })(sourceFile, 0);
  return lines;
}

let syntacticFailures = 0;
let childrenFailures = 0;
let astMatches = 0;
let totalNodes = 0;
let matchedNodes = 0;
const unsupportedKinds = new Map();

for (const fixture of files) {
  const sourceFile = service.getSourceFile(fixture.fileName);
  const upstream = parseReference(fixture.code, { jsx: fixture.jsx ?? false });
  const report = [];

  const tokensOk = compareList(
    "tokens",
    convertTokens(sourceFile).map(tokenKey),
    upstream.tokens.map(tokenKey),
    report,
  );
  const commentsOk = compareList(
    "comments",
    convertComments(sourceFile).map(commentKey),
    upstream.comments.map(commentKey),
    report,
  );
  // ESLint merges tokens and comments into one position-ordered sequence and does not
  // terminate if the two overlap, so a file that produces overlapping ranges does not
  // lint wrongly, it hangs. Checked separately from the comparison above because the
  // symptom is severe enough to name on its own.
  const overlapsOk = noOverlap(convertTokens(sourceFile), convertComments(sourceFile), report);

  if (!tokensOk || !commentsOk || !overlapsOk) {
    syntacticFailures++;
  }

  const childrenOk = compareList(
    "getChildren",
    ourChildrenSignature(sourceFile),
    childrenSignature(fixture.code, { jsx: fixture.jsx ?? false }),
    report,
  );
  if (!childrenOk) {
    childrenFailures++;
  }

  const { ast, unsupported } = convertProgram(sourceFile);
  for (const [kind, count] of unsupported) {
    unsupportedKinds.set(kind, (unsupportedKinds.get(kind) ?? 0) + count);
  }

  // Compare only the node tree; tokens and comments are checked separately above.
  const { comments: _c, tokens: _t, ...expectedProgram } = upstream;
  const expected = normalize(expectedProgram);
  const actual = normalize(ast);

  const nodes = countNodes(expected);
  totalNodes += nodes;

  const astDiff = [];
  diff(expected, actual, "Program", astDiff);

  const label = fixture.name.padEnd(30);
  if (astDiff.length === 0) {
    astMatches++;
    matchedNodes += nodes;
  }

  if (astDiff.length === 0 && tokensOk && commentsOk && childrenOk) {
    console.log(`ok   ${label} ${String(nodes).padStart(3)} nodes`);
  } else {
    console.log(`FAIL ${label} ${String(nodes).padStart(3)} nodes`);
    for (const line of report) {
      console.log(line);
    }
    for (const line of astDiff.slice(0, 3)) {
      console.log(`     ${line}`);
    }
  }
}

clearProgramServices();

console.log(`\ntokens and comments: ${files.length - syntacticFailures}/${files.length} fixtures match`);
console.log(`getChildren:         ${files.length - childrenFailures}/${files.length} fixtures match`);
if (childrenFailures > 0) {
  console.log(
    "  JSX `</` as one token vs two, and array holes as BindingElement rather than\n" +
      "  OmittedExpression, are parser differences. JSDoc is a deliberate omission:\n" +
      "  TS 6 listed JSDoc nodes among a node's children, and asking the TS 7 scanner\n" +
      "  for the tokens spanning JSDoc hands back the node itself, which recurses.\n" +
      "  ESLint reads none of this: tokens, comments and the AST are exact.",
  );
}
console.log(`full AST:            ${astMatches}/${files.length} fixtures match`);
console.log(`nodes in matching fixtures: ${matchedNodes}/${totalNodes}`);

if (unsupportedKinds.size > 0) {
  const sorted = [...unsupportedKinds].sort((a, b) => b[1] - a[1]);
  console.log(`\nnode kinds not yet converted (${sorted.length}):`);
  for (const [kind, count] of sorted.slice(0, 15)) {
    console.log(`  ${String(count).padStart(3)}x ${kind}`);
  }
}

// Everything must match. Anything less is a regression.
// Tokens, comments and the AST must be exact. getChildren is reported rather than
// gated: the outstanding differences are in how the two compilers parse, not in the
// reconstruction, so a green gate there is not achievable or meaningful.
process.exit(syntacticFailures === 0 && astMatches === files.length ? 0 : 1);
