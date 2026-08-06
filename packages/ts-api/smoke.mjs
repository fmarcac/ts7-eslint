// Phase 1 checks for @tseslint7/ts-api.
//
// The claims worth holding this package to: it boots once, it reads ESLint's in-memory
// text rather than disk when they differ, and it does not churn the snapshot when they
// do not.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilities, clearProgramServices, getProgramService } from "./index.mjs";

const dir = mkdtempSync(join(tmpdir(), "tseslint7-tsapi-"));
const tsconfigPath = join(dir, "tsconfig.json");
const fileA = join(dir, "a.ts");

const ON_DISK = `export const count: number = 1;
export function twice(n: number): number { return n * 2; }
`;

writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: { module: "esnext", strict: true, target: "esnext" },
  files: ["a.ts"],
}));
writeFileSync(fileA, ON_DISK);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
  }
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
}

console.log(`typescript ${capabilities.typescriptVersion}`);
console.log(`  runWithTemporaryFileUpdate: ${capabilities.temporaryFileUpdate ? "available" : "not on this version"}`);

const boot = performance.now();
const service = getProgramService({ cwd: dir, tsconfigPath });
console.log(`\nboot: ${(performance.now() - boot).toFixed(1)} ms\n`);

// The parser is handed text identical to disk, which is the ordinary CLI case.
service.setFileText(fileA, ON_DISK);
check("unmodified text causes no snapshot update", service.snapshotUpdates, 0);

// Repeating the same text must also be free.
service.setFileText(fileA, ON_DISK);
check("repeating the same text is free", service.snapshotUpdates, 0);

const sourceFile = service.getSourceFile(fileA);
check("source file resolves", sourceFile?.fileName, fileA);

// Find the declared identifier and read its type through the checker.
function findIdentifier(node, name, sf) {
  let found;
  (function walk(n) {
    if (found) {
      return;
    }
    if (n.getText?.(sf) === name && n.kind !== sf.kind) {
      found = n;
      return;
    }
    n.forEachChild(walk);
  })(node);
  return found;
}

const countIdent = findIdentifier(sourceFile, "count", sourceFile);
const countType = service.checker.getTypeAtLocation(countIdent);
check("type of `count` from disk text", service.checker.typeToString(countType), "number");

// Now hand it text that differs from disk, as an editor with an unsaved buffer or an
// ESLint processor would.
const MODIFIED = `export const count: string = "one";
export function twice(n: number): number { return n * 2; }
`;
service.setFileText(fileA, MODIFIED);
check("modified text triggers one update", service.snapshotUpdates, 1);

const modifiedFile = service.getSourceFile(fileA);
check("server sees the modified text", modifiedFile.text.startsWith("export const count: string"), true);

const modifiedIdent = findIdentifier(modifiedFile, "count", modifiedFile);
const modifiedType = service.checker.getTypeAtLocation(modifiedIdent);
check("type reflects the overlay, not disk", service.checker.typeToString(modifiedType), "string");

// Going back to the on-disk text must drop the overlay again.
service.setFileText(fileA, ON_DISK);
check("reverting to disk text updates once more", service.snapshotUpdates, 2);
const reverted = service.getSourceFile(fileA);
check("server sees disk text again", reverted.text.startsWith("export const count: number"), true);

// Batched queries.
const sf = service.getSourceFile(fileA);
const identifiers = [];
(function walk(n) {
  if (n.kind === sf.statements[0].declarationList?.declarations?.[0]?.name?.kind) {
    identifiers.push(n);
  }
  n.forEachChild(walk);
})(sf);
const types = service.getTypes(identifiers);
check("batched query returns one type per node", types.length, identifiers.length);
check("empty batch is a no-op", service.getTypes([]).length, 0);

// Two numbers, because they measure different things and only one of them is a property
// of TypeScript 7: what a repeated question costs (the memo) and what a fresh one costs
// (a round trip to the Go process).
const WARM = 500;
const t = performance.now();
for (let i = 0; i < WARM; i++) {
  service.checker.getTypeAtLocation(identifiers[i % identifiers.length]);
}
console.log(`\n${WARM} repeated type queries: ${((performance.now() - t) / WARM).toFixed(3)} ms each`);

const raw = Object.getPrototypeOf(service.checker).getTypeAtLocation;
const cold = performance.now();
for (let i = 0; i < WARM; i++) {
  raw.call(service.checker, identifiers[i % identifiers.length]);
}
console.log(
  `${WARM} round trips to the server: ${((performance.now() - cold) / WARM).toFixed(3)} ms each`,
);

// ---- getAwaitedType -------------------------------------------------------
//
// Reimplemented rather than bridged: it is missing from TypeScript 7.0 and from the 7.1
// development builds alike. Running without throwing proves nothing here, so each case
// checks the type that comes back.

console.log("\ngetAwaitedType:");

const awaitedDir = mkdtempSync(join(tmpdir(), "tseslint7-awaited-"));
const awaitedConfig = join(awaitedDir, "tsconfig.json");
const awaitedFile = join(awaitedDir, "a.ts");

writeFileSync(awaitedConfig, JSON.stringify({
  compilerOptions: { lib: ["esnext"], module: "esnext", strict: true, target: "esnext" },
  files: ["a.ts"],
}));
writeFileSync(
  awaitedFile,
  `export declare const simple: Promise<number>;
export declare const nested: Promise<Promise<string>>;
export declare const thenable: { then(cb: (value: boolean) => void): void };
export declare const plain: number;
export declare const unionNoPromise: number | string;
export declare const anyPromise: Promise<any>;
`,
);

const awaitedService = getProgramService({ cwd: awaitedDir, tsconfigPath: awaitedConfig });
const awaitedSource = awaitedService.getSourceFile(awaitedFile);
const awaitedChecker = awaitedService.checker;

/** The declared type of a top-level `export declare const <name>`. */
function declaredType(name) {
  const identifier = findIdentifier(awaitedSource, name, awaitedSource);
  return awaitedChecker.getTypeAtLocation(identifier);
}

function awaitedString(name) {
  const type = awaitedChecker.getAwaitedType(declaredType(name));
  return type ? awaitedChecker.typeToString(type) : "undefined";
}

check("Promise<number> awaits to number", awaitedString("simple"), "number");
check("Promise<Promise<string>> unwraps fully", awaitedString("nested"), "string");
check("a hand-written thenable awaits to its value", awaitedString("thenable"), "boolean");
check("Promise<any> awaits to any", awaitedString("anyPromise"), "any");

// A non-promise is its own awaited type, and callers compare the result by identity, so
// it has to be the very same object rather than an equal one.
const plainType = declaredType("plain");
check("a non-promise awaits to itself", awaitedChecker.getAwaitedType(plainType), plainType);
const unionType = declaredType("unionNoPromise");
check(
  "a union with no promise in it awaits to itself",
  awaitedChecker.getAwaitedType(unionType),
  unionType,
);

clearProgramServices();
console.log(`\n${failures === 0 ? "ts-api PASS" : `ts-api FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
