// The correctness gate for this package.
//
// Our output must match upstream typescript-estree running on typescript@6.0.3, the
// newest version @typescript-eslint@8.66.0 supports. Comparing against TS 6 rather than
// TS 5 keeps the difference attributable to this port instead of to TypeScript version
// drift.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReference, referenceTypeScriptVersion } from "@tseslint7/reference";
import { clearProgramServices, getProgramService } from "@tseslint7/ts-api";
import { fixtures } from "./fixtures.mjs";
import { convertComments } from "./comments.mjs";
import { convertTokens } from "./tokens.mjs";

const dir = mkdtempSync(join(tmpdir(), "tseslint7-estree-"));
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

/** Collapse a token to one comparable line. */
function tokenKey(token) {
  const { loc, range, type, value } = token;
  const where = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
  const regex = token.regex ? ` regex(${token.regex.pattern}/${token.regex.flags})` : "";
  return `${type} ${JSON.stringify(value)} [${range[0]},${range[1]}] ${where}${regex}`;
}

function commentKey(comment) {
  const { loc, range, type, value } = comment;
  const where = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
  return `${type} ${JSON.stringify(value)} [${range[0]},${range[1]}] ${where}`;
}

function compare(label, ours, theirs, report) {
  if (ours.length === theirs.length && ours.every((v, i) => v === theirs[i])) {
    return true;
  }
  report.push(`     ${label}: ours ${ours.length} vs upstream ${theirs.length}`);
  let shown = 0;
  for (let i = 0; i < Math.max(ours.length, theirs.length) && shown < 4; i++) {
    if (ours[i] !== theirs[i]) {
      report.push(`       [${i}] upstream: ${theirs[i] ?? "(none)"}`);
      report.push(`       [${i}] ours:     ${ours[i] ?? "(none)"}`);
      shown++;
    }
  }
  return false;
}

console.log(`reference: typescript-estree 8.66.0 on typescript ${referenceTypeScriptVersion}`);
console.log(`fixtures:  ${files.length}\n`);

let failed = 0;
let totalTokens = 0;
let totalComments = 0;

for (const fixture of files) {
  const sourceFile = service.getSourceFile(fixture.fileName);
  if (!sourceFile) {
    console.log(`FAIL ${fixture.name}: TypeScript 7 returned no source file`);
    failed++;
    continue;
  }

  const upstream = parseReference(fixture.code, { jsx: fixture.jsx ?? false });
  const report = [];

  const tokensOk = compare(
    "tokens",
    convertTokens(sourceFile).map(tokenKey),
    upstream.tokens.map(tokenKey),
    report,
  );
  const commentsOk = compare(
    "comments",
    convertComments(sourceFile).map(commentKey),
    upstream.comments.map(commentKey),
    report,
  );

  totalTokens += upstream.tokens.length;
  totalComments += upstream.comments.length;

  if (tokensOk && commentsOk) {
    console.log(
      `ok   ${fixture.name.padEnd(30)} ${String(upstream.tokens.length).padStart(3)} tokens, ${upstream.comments.length} comments`,
    );
  } else {
    failed++;
    console.log(`FAIL ${fixture.name}`);
    for (const line of report) {
      console.log(line);
    }
  }
}

clearProgramServices();

console.log(`\ncompared ${totalTokens} tokens and ${totalComments} comments`);
console.log(failed === 0 ? "typescript-estree PASS" : `typescript-estree FAIL (${failed}/${files.length})`);
process.exit(failed === 0 ? 0 : 1);
