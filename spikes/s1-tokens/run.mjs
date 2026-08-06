// S1 gate: our TS 7 token list must match upstream typescript-estree on TS 6.0.3 exactly.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReference, referenceTypeScriptVersion } from "@tseslint7/reference";
import { API } from "typescript/unstable/sync";
import { fixtures } from "./fixtures.mjs";
import { collectTokens } from "./tokens.mjs";

const dir = mkdtempSync(join(tmpdir(), "tseslint7-s1-"));
const files = fixtures.map((f) => {
  const fileName = join(dir, `${f.name}.${f.ext}`);
  writeFileSync(fileName, f.code);
  return { ...f, fileName };
});

writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      allowJs: true,
      experimentalDecorators: false,
      jsx: "preserve",
      module: "esnext",
      moduleResolution: "bundler",
      strict: false,
      target: "esnext",
    },
    files: files.map((f) => `${f.name}.${f.ext}`),
  }),
);

const api = new API({ cwd: dir });
const snapshot = api.updateSnapshot({ openProjects: [join(dir, "tsconfig.json")] });
const project = snapshot.getProjects()[0];

if (!project) {
  throw new Error("no project loaded from the fixture tsconfig");
}

/** Collapse a token to a single comparable line. */
function key(token) {
  const { loc, range, type, value } = token;
  const where = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
  const regex = token.regex ? ` regex(${token.regex.pattern}/${token.regex.flags})` : "";
  return `${type} ${JSON.stringify(value)} [${range[0]},${range[1]}] ${where}${regex}`;
}

let failed = 0;
const MAX_SHOWN = 6;

console.log(`reference: typescript-estree 8.66.0 on typescript ${referenceTypeScriptVersion}`);
console.log(`fixtures:  ${files.length}\n`);

for (const fixture of files) {
  const sourceFile = project.program.getSourceFile(fixture.fileName);
  if (!sourceFile) {
    console.log(`FAIL ${fixture.name}: TS 7 did not return a source file`);
    failed++;
    continue;
  }

  const ours = collectTokens(sourceFile).map(key);
  const theirs = parseReference(fixture.code, { jsx: fixture.jsx ?? false }).tokens.map(key);

  if (ours.length === theirs.length && ours.every((t, i) => t === theirs[i])) {
    console.log(`ok   ${fixture.name.padEnd(32)} ${theirs.length} tokens`);
    continue;
  }

  failed++;
  console.log(`FAIL ${fixture.name.padEnd(32)} ours ${ours.length} vs upstream ${theirs.length}`);

  let shown = 0;
  for (let i = 0; i < Math.max(ours.length, theirs.length) && shown < MAX_SHOWN; i++) {
    if (ours[i] !== theirs[i]) {
      console.log(`       [${i}] upstream: ${theirs[i] ?? "(none)"}`);
      console.log(`       [${i}] ours:     ${ours[i] ?? "(none)"}`);
      shown++;
    }
  }
}

api.close();

console.log(`\n${failed === 0 ? "S1 PASS" : `S1 FAIL (${failed}/${files.length} fixtures)`}`);
process.exit(failed === 0 ? 0 : 1);
