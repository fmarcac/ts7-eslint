// @ts7-eslint/parser
//
// The ESLint entry point. Assembles the compiler connection (@ts7-eslint/ts-api) and the
// AST conversion (@ts7-eslint/typescript-estree) into what ESLint asks a parser for, and
// exposes parserServices in the shape upstream rules already expect.
//
// Scope analysis is upstream's @typescript-eslint/scope-manager, used verbatim: it runs
// purely on the TSESTree AST and has no reference to the compiler, so there was nothing
// to port.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { getProgramService } from "../ts-api/index.mjs";
import { convertSourceFile } from "../typescript-estree/index.mjs";
import { analyze } from "@typescript-eslint/scope-manager";
import { visitorKeys } from "@typescript-eslint/visitor-keys";

/**
 * Find the tsconfig governing a file.
 *
 * TypeScript 7 has no standalone parser: an AST can only come from a Program, so unlike
 * upstream there is no project-less mode. A config is always required, and the nearest
 * one is a better default than an error.
 */
function findTsconfig(fromDirectory, rootDirectory) {
  const stopAt = rootDirectory ? resolve(rootDirectory) : parsePath(fromDirectory).root;
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === stopAt || current === dirname(current)) {
      return undefined;
    }
    current = dirname(current);
  }
}

function resolveProject(options) {
  const cwd = options.tsconfigRootDir ?? process.cwd();
  const filePath = options.filePath ? resolve(cwd, options.filePath) : undefined;

  if (typeof options.project === "string") {
    return { cwd, tsconfigPath: isAbsolute(options.project) ? options.project : resolve(cwd, options.project) };
  }

  if (!filePath) {
    throw new Error(
      "The ts7-eslint parser needs either parserOptions.project or a filePath to locate a tsconfig.",
    );
  }

  const tsconfigPath = findTsconfig(dirname(filePath), options.tsconfigRootDir);
  if (!tsconfigPath) {
    throw new Error(
      `No tsconfig.json found for ${filePath}. TypeScript 7 can only produce an AST through ` +
        `a Program, so set parserOptions.project explicitly.`,
    );
  }
  return { cwd, tsconfigPath };
}

/**
 * A stand-in for ts.Program covering what rules actually call on it.
 *
 * TypeScript 7 splits the old Program: type checking lives on Project.checker rather
 * than behind program.getTypeChecker(). Rules call the latter, so it is bridged here.
 */
function createProgramFacade(service) {
  const program = service.program;
  return {
    getCompilerOptions: () => program.getCompilerOptions(),
    getSourceFile: (fileName) => program.getSourceFile(fileName),
    getSourceFileNames: () => program.getSourceFileNames(),
    getSemanticDiagnostics: (file) => program.getSemanticDiagnostics(file),
    getSyntacticDiagnostics: (file) => program.getSyntacticDiagnostics(file),
    getTypeChecker: () => service.checker,
    isSourceFileDefaultLibrary: (file) => program.isSourceFileDefaultLibrary(file),
    isSourceFileFromExternalLibrary: (file) => program.isSourceFileFromExternalLibrary(file),
  };
}

function createParserServices(service, astMaps, parserOptions) {
  const program = createProgramFacade(service);
  const checker = service.checker;
  const compilerOptions = program.getCompilerOptions();
  const toTsNode = (node) => astMaps.esTreeNodeToTSNodeMap.get(node);

  return {
    program,
    ...astMaps,

    emitDecoratorMetadata:
      compilerOptions.emitDecoratorMetadata ?? parserOptions.emitDecoratorMetadata === true,
    experimentalDecorators:
      compilerOptions.experimentalDecorators ?? parserOptions.experimentalDecorators === true,
    isolatedDeclarations:
      compilerOptions.isolatedDeclarations ?? parserOptions.isolatedDeclarations === true,

    getContextualType: (node) => checker.getContextualType(toTsNode(node)),
    getResolvedSignature: (node) => checker.getResolvedSignature(toTsNode(node)),
    getSymbolAtLocation: (node) => checker.getSymbolAtLocation(toTsNode(node)),
    getTypeAtLocation: (node) => checker.getTypeAtLocation(toTsNode(node)),
    getTypeFromTypeNode: (node) => checker.getTypeFromTypeNode(toTsNode(node)),
    getTypeOfSymbolAtLocation: (symbol, node) =>
      checker.getTypeOfSymbolAtLocation(symbol, toTsNode(node)),
  };
}

export function parseForESLint(code, options = {}) {
  const parserOptions = { ...options };
  const { cwd, tsconfigPath } = resolveProject(parserOptions);
  const filePath = resolve(cwd, parserOptions.filePath);

  const service = getProgramService({ cwd, tsconfigPath });

  // Point the compiler at the text ESLint is linting. When it matches disk, which is the
  // ordinary CLI case, this costs nothing.
  service.setFileText(filePath, code);

  const sourceFile = service.getSourceFile(filePath);
  if (!sourceFile) {
    throw new Error(
      `${filePath} is not part of the program described by ${tsconfigPath}. ` +
        `Add it to the config's include or files.`,
    );
  }

  const { ast, esTreeNodeToTSNodeMap, tsNodeToESTreeNodeMap } = convertSourceFile(sourceFile);

  // ESLint's own option wins over what the file looks like, matching upstream.
  ast.sourceType = parserOptions.sourceType ?? ast.sourceType;

  const compilerOptions = service.program.getCompilerOptions();
  const scopeManager = analyze(ast, {
    globalReturn: parserOptions.ecmaFeatures?.globalReturn,
    jsxFragmentName:
      parserOptions.jsxFragmentName ?? compilerOptions.jsxFragmentFactory?.split(".")[0].trim(),
    jsxPragma: parserOptions.jsxPragma ?? compilerOptions.jsxFactory?.split(".")[0].trim(),
    lib: parserOptions.lib,
    sourceType: ast.sourceType,
  });

  const services = createParserServices(
    service,
    { esTreeNodeToTSNodeMap, tsNodeToESTreeNodeMap },
    parserOptions,
  );

  return { ast, scopeManager, services, visitorKeys };
}

export function parse(code, options) {
  return parseForESLint(code, options).ast;
}

export { visitorKeys };

export default { parse, parseForESLint, visitorKeys };
