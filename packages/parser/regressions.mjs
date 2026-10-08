import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tseslint from "../../index.mjs";
import { clearProgramServices } from "../ts-api/index.mjs";

const { Linter } = await import("eslint");
const dir = mkdtempSync(join(tmpdir(), "ts7-eslint-regressions-"));

after(() => {
  clearProgramServices();
  rmSync(dir, { recursive: true, force: true });
});

function project(name, compilerOptions = {}, extension = "ts") {
  const filePath = join(dir, `${name}.${extension}`);
  const configPath = join(dir, `${name}.json`);
  writeFileSync(filePath, "export {};");
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: "es2022", ...compilerOptions },
    files: [filePath],
  }));
  return { filePath, project: configPath };
}

test("invalid syntax produces a located ESLint parsing error", () => {
  const options = project("syntax");
  const messages = new Linter({ cwd: dir }).verify("export {};\nconst x = ;", {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: options },
  }, options.filePath);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].fatal, true);
  assert.equal(messages[0].line, 2);
  assert.equal(messages[0].column, 11);
  assert.match(messages[0].message, /Expression expected/);
  assert.doesNotThrow(() => tseslint.parser.parseForESLint('const x: number = "wrong";', options));
});

test("missing filePath gives an actionable error", () => {
  assert.throws(() => tseslint.parser.parseForESLint("", { project: "tsconfig.json" }), /needs a filePath/);
});

test("text overlays stay authoritative after disk edits and buffer reverts", () => {
  const options = project("disk-edits");
  const original = "export const value = 1;";
  const saved = 'export const value = "saved";';
  const parseValue = (code) => tseslint.parser.parseForESLint(code, options)
    .ast.body[0].declaration.declarations[0].init.value;
  writeFileSync(options.filePath, original);
  assert.equal(parseValue(original), 1);
  writeFileSync(options.filePath, saved);
  assert.equal(parseValue(saved), "saved");
  assert.equal(parseValue('export const value = "unsaved";'), "unsaved");
  assert.equal(parseValue(original), 1);
  assert.equal(parseValue(saved), "saved");
});

test("scope globals follow explicit lib, target defaults and parser overrides", () => {
  const globals = (options) => new Set(tseslint.parser.parseForESLint("export {};", options)
    .scopeManager.globalScope.variables.map((variable) => variable.name));
  const options = project("libs", { lib: ["es2022", "dom"] });
  const selected = globals(options);
  assert.equal(selected.has("HTMLElement"), true);
  assert.equal(selected.has("Promise"), true);
  assert.equal(selected.has("Disposable"), false);
  const defaultLibs = globals(project("default-libs"));
  assert.equal(defaultLibs.has("HTMLElement"), true);
  assert.equal(defaultLibs.has("Disposable"), false);
  const overridden = globals({ ...options, lib: [] });
  assert.equal(overridden.has("HTMLElement"), false);
  assert.equal(overridden.has("Promise"), false);
});

test("retained types and signatures use their originating project checker", () => {
  const options = project("owner-first");
  const first = tseslint.parser.parseForESLint(
    "export const value = { field: { nested: 1 } }; export function f() { return value; }",
    options,
  );
  const declaration = first.ast.body[0].declaration.declarations[0];
  const type = first.services.getTypeAtLocation(declaration.id);
  const functionNode = first.ast.body[1].declaration;
  const checker = first.services.program.getTypeChecker();
  const stringType = checker.getStringType();
  const signature = checker.getSignatureFromDeclaration(first.services.esTreeNodeToTSNodeMap.get(functionNode));
  const secondOptions = project("owner-second");
  tseslint.parser.parseForESLint("export const other = false;", secondOptions);
  assert.deepEqual(type.getProperties().map((property) => property.name), ["field"]);
  assert.ok(stringType.getProperty("length"));
  assert.deepEqual(signature.getReturnType().getProperties().map((property) => property.name), ["field"]);
  const field = checker.getTypeOfSymbol(type.getProperty("field"));
  assert.deepEqual(field.getProperties().map((property) => property.name), ["nested"]);
  assert.equal(first.services.getTypeAtLocation(declaration.id), type);
});

test("explicit null JSX pragma disables the tsconfig factory reference", () => {
  const options = project("jsx", { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }, "tsx");
  const result = tseslint.parser.parseForESLint(
    "const h = () => null; const Fragment = h; const element = <><div /></>;",
    { ...options, jsxPragma: null, jsxFragmentName: null },
  );
  const variables = result.scopeManager.scopes.flatMap((scope) => scope.variables);
  for (const name of ["h", "Fragment"]) {
    const variable = variables.find((candidate) => candidate.name === name);
    assert.ok(variable);
    assert.equal(variable.references.filter((reference) => reference.isRead()).length, name === "h" ? 1 : 0);
  }
});

test("every preset preserves upstream core-rule overrides", () => {
  for (const name of ["recommended", "recommendedTypeChecked", "strict", "strictTypeChecked", "stylistic", "stylisticTypeChecked"]) {
    const upstreamName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const rules = Object.assign({}, ...tseslint.configs[name].map((config) => config.rules));
    for (const [id, setting] of Object.entries(tseslint.plugin.configs[upstreamName].rules)) {
      assert.deepEqual(rules[id], setting, `${name}: ${id}`);
    }
  }
});

test("recommended config disables core no-unused-vars for type-only uses", () => {
  const options = project("preset");
  const messages = new Linter({ cwd: dir }).verify(
    "interface Value { n: number }\nexport const value: Value = { n: 1 };",
    [{ files: ["**/*.ts"], rules: { "no-unused-vars": "error" } },
      ...tseslint.configs.recommended,
      { files: ["**/*.ts"], languageOptions: { parserOptions: options } }],
    options.filePath,
  );
  assert.deepEqual(messages, []);
});
