// The `ts` namespace as TypeScript 7 can still provide it.
//
// Upstream rules and ts-api-utils do `import ts from "typescript"` and reach for enums,
// type guards, and a handful of host functions. On TS 7 the root export is a version
// stub, so this module stands in for it. It is CommonJS on purpose: upstream is
// CommonJS and does `require("typescript")`, so matching the module format keeps the
// interop identical to the real package.
//
// Measured surface: 69 distinct `ts.*` members across all 135 rules plus type-utils.
// Most are enums TS 7 still exports, and 23 of the 26 type guards come straight from
// unstable/ast/is.

const ast = require("typescript/unstable/ast");
const is = require("typescript/unstable/ast/is");
const { textToKeywordObj } = require("typescript/unstable/ast/scanner");
const sync = require("typescript/unstable/sync");
const real = require("typescript");
const ts6Enums = require("./ts6-enums.cjs");

const { SyntaxKind } = ast;

// What this module reports as its version is the *API contract* it implements, which is
// the TypeScript 6 compiler API, not the TypeScript 7 package it is built on.
//
// This is load-bearing rather than cosmetic. @typescript-eslint/eslint-plugin@8.66.0
// reads ts.versionMajorMinor at import time and throws outright when the major is >= 7,
// directing users to keep TypeScript 6 installed alongside 7 and point the linter at it.
// Reporting "7.0" here would claim to be the TS 7 API, which this module is precisely
// not. The real underlying version stays available as tsVersion.
const API_VERSION = "6.0.3";
const API_VERSION_MAJOR_MINOR = "6.0";

// Absent from unstable/ast/is. These are union predicates, not single-kind checks.
function isParameter(node) {
  return node?.kind === SyntaxKind.Parameter;
}

function isFunctionLike(node) {
  switch (node?.kind) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

function isClassLike(node) {
  return (
    node?.kind === SyntaxKind.ClassDeclaration || node?.kind === SyntaxKind.ClassExpression
  );
}

function isMethodSignature(node) {
  return node?.kind === SyntaxKind.MethodSignature;
}

/**
 * TypeScript 6's isStringLiteralLike.
 *
 * Both a quoted string and an untagged template with no substitutions are "string
 * literal like", because both have a fixed `text`. ts-api-utils asks this in
 * isDeclarationName and isPropertyNameLiteral, which is on the path of several rules.
 */
function isStringLiteralLike(node) {
  return (
    node?.kind === SyntaxKind.StringLiteral ||
    node?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

// TypeScript 6 kept decorators and modifiers in one `modifiers` array and offered these
// two accessors to separate them again. TypeScript 7 kept the array and dropped the
// accessors.
function getDecorators(node) {
  return node?.modifiers?.filter(is.isDecorator);
}

function getModifiers(node) {
  return node?.modifiers?.filter((modifier) => !is.isDecorator(modifier));
}

function canHaveDecorators(node) {
  switch (node?.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

// Union predicates that unstable/ast/is does not provide, because it generates one
// function per single kind.
function isCaseOrDefaultClause(node) {
  return node?.kind === SyntaxKind.CaseClause || node?.kind === SyntaxKind.DefaultClause;
}

function isImportOrExportSpecifier(node) {
  return node?.kind === SyntaxKind.ImportSpecifier || node?.kind === SyntaxKind.ExportSpecifier;
}

function isPropertySignature(node) {
  return node?.kind === SyntaxKind.PropertySignature;
}

function isJSDocFunctionType(node) {
  return node?.kind === SyntaxKind.JSDocFunctionType;
}

/** A file is an external module when the parser found an import, export, or `import.meta`. */
function isExternalModule(sourceFile) {
  return sourceFile?.externalModuleIndicator !== undefined;
}

/**
 * The keyword an identifier would have been, had it not been used as a name.
 *
 * `type`, `as` and friends are contextual: the parser produces an Identifier and rules
 * that care ask this to recover which keyword it spells.
 */
function identifierToKeywordKind(identifier) {
  const text = identifier?.escapedText ?? identifier?.text;
  return typeof text === "string" ? textToKeywordObj[text] : undefined;
}

/** Mirrors TS 6's isTypeOnlyImportOrExportDeclaration. */
function isTypeOnlyImportOrExportDeclaration(node) {
  switch (node?.kind) {
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ImportSpecifier:
      return node.isTypeOnly || node.parent.parent.isTypeOnly;
    case SyntaxKind.NamespaceImport:
      return node.parent.isTypeOnly;
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceExport:
      return node.isTypeOnly;
    default:
      return false;
  }
}

// TS 7 makes forEachChild a method on Node rather than a free function.
function forEachChild(node, cbNode, cbNodes) {
  return node.forEachChild(cbNode, cbNodes);
}

function displayPartsToString(parts) {
  return parts ? parts.map((part) => part.text).join("") : "";
}

/**
 * TypeScript 6's getCombinedModifierFlags.
 *
 * A variable's modifiers sit on the enclosing statement, not the declaration, so the old
 * API walked up the VariableDeclaration to VariableDeclarationList to VariableStatement
 * chain and merged what it found. TypeScript 7 exposes `modifierFlags` per node, which
 * makes the walk simple but does not remove the need for it.
 */
function getCombinedModifierFlags(node) {
  let current = node;
  if (current?.kind === SyntaxKind.BindingElement) {
    while (current && current.kind === SyntaxKind.BindingElement) {
      current = current.parent?.parent;
    }
  }
  let flags = current?.modifierFlags ?? 0;
  if (current?.kind === SyntaxKind.VariableDeclaration) {
    current = current.parent;
    flags |= current?.modifierFlags ?? 0;
    if (current?.kind === SyntaxKind.VariableDeclarationList) {
      current = current.parent;
      flags |= current?.modifierFlags ?? 0;
    }
  }
  return flags;
}

/**
 * TypeScript 6's getNameOfDeclaration.
 *
 * Most declarations simply carry `name`. The cases that do not are the ones where the
 * name is derived from an assignment or an expression, which the old API resolved for
 * callers.
 */
function getNameOfDeclaration(declaration) {
  if (!declaration) {
    return undefined;
  }
  switch (declaration.kind) {
    case SyntaxKind.BinaryExpression:
      return declaration.left;
    case SyntaxKind.ExportAssignment:
      return declaration.expression;
    default:
      return declaration.name;
  }
}

module.exports = {
  ...is,
  ...ast,
  ...ts6Enums,

  canHaveDecorators,
  displayPartsToString,
  forEachChild,
  getCombinedModifierFlags,
  getDecorators,
  getModifiers,
  getNameOfDeclaration,
  identifierToKeywordKind,
  isCaseOrDefaultClause,
  isClassLike,
  isExternalModule,
  isFunctionLike,
  isImportOrExportSpecifier,
  isJSDocFunctionType,
  isMethodSignature,
  isParameter,
  isPropertySignature,
  isStringLiteralLike,
  isTypeOnlyImportOrExportDeclaration,

  // Enums live on both entry points; sync carries the checker-side ones.
  ElementFlags: sync.ElementFlags,
  ModuleKind: sync.ModuleKind,
  ModifierFlags: sync.ModifierFlags,
  ObjectFlags: sync.ObjectFlags,
  SignatureKind: sync.SignatureKind,
  SymbolFlags: sync.SymbolFlags,
  TypeFlags: sync.TypeFlags,
  TypePredicateKind: sync.TypePredicateKind,

  version: API_VERSION,
  versionMajorMinor: API_VERSION_MAJOR_MINOR,

  /** The real TypeScript package version backing this shim. */
  tsVersion: real.version,
};
