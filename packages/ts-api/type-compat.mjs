// TypeScript 6's convenience methods on Type, restored on TypeScript 7.0.
//
// In TS 6 a Type carried methods that reached back into the checker: getProperty,
// getCallSignatures, getStringIndexType and friends. TypeScript 7.0 moved all of that
// onto the Checker (checker.getPropertyOfType(type, name)) and left Type as data.
// ts-api-utils and many rules call the old methods, so `type.getProperty is not a
// function` is the first thing a type-aware rule hits.
//
// This is temporary by design. The 7.1 development builds add getProperty,
// getProperties, getApparentProperties, getCallSignatures, getConstructSignatures,
// getStringIndexType, getNumberIndexType, getReturnType and getDefault back onto the
// type objects, so on 7.1 the runtime already provides what this fills in. Each method
// is installed only when missing.

import { SignatureKind } from "typescript/unstable/sync";

/** TS 6 name to a function of (checker, type, ...args). */
const METHODS = {
  getApparentProperties: (checker, type) =>
    checker.getPropertiesOfType(checker.getApparentType(type) ?? type),
  getBaseTypes: (checker, type) => checker.getBaseTypes(type),
  getCallSignatures: (checker, type) => checker.getSignaturesOfType(type, SignatureKind.Call),
  getConstructSignatures: (checker, type) =>
    checker.getSignaturesOfType(type, SignatureKind.Construct),
  getFlags: (checker, type) => type.flags,
  getNonNullableType: (checker, type) => checker.getNonNullableType(type),
  getNumberIndexType: (checker, type) => indexTypeOf(checker, type, "number"),
  getProperties: (checker, type) => checker.getPropertiesOfType(type),
  getProperty: (checker, type, name) => checker.getPropertyOfType(type, name),
  getStringIndexType: (checker, type) => indexTypeOf(checker, type, "string"),
};

/** TS 6 predicate name to the TS 7 method that replaced it. */
const PREDICATE_ALIASES = {
  isClass: "isClassOrInterface",
  isClassOrInterface: "isClassOrInterface",
  isIntersection: "isIntersectionType",
  isLiteral: "isLiteralType",
  isNumberLiteral: "isNumberLiteralType",
  isStringLiteral: "isStringLiteralType",
  isUnion: "isUnionType",
};

function indexTypeOf(checker, type, kind) {
  const infos = checker.getIndexInfosOfType(type) ?? [];
  const wanted = kind === "string" ? checker.getStringType() : checker.getNumberType();
  const match = infos.find((info) => info.keyType?.flags === wanted?.flags);
  return match?.valueType;
}

/**
 * TS 6 Symbol methods, gone in TS 7 where Symbol became plain data.
 *
 * `declarations` also changed shape: TS 7 stores NodeHandle values rather than nodes, so
 * getDeclarations has to resolve them. A handle knows the project that produced it, so
 * it can resolve itself.
 */
const SYMBOL_METHODS = {
  getDeclarations: (symbol) =>
    symbol.declarations?.map((declaration) => declaration.resolve?.() ?? declaration),
  getEscapedName: (symbol) => symbol.escapedName,
  getFlags: (symbol) => symbol.flags,
  getName: (symbol) => symbol.name,
};

let installed = false;

/**
 * Patch the Type prototype in place.
 *
 * TypeObject is not exported, so the prototype is reached through an instance. ESLint
 * lints one project at a time, so binding these to a single checker is sound; if that
 * ever stops being true, the methods would need to resolve their own checker instead.
 */
export function installTypeCompat(checker) {
  if (installed) {
    return;
  }
  const sample = checker.getAnyType();
  if (!sample) {
    return;
  }
  const prototype = Object.getPrototypeOf(sample);

  for (const [name, implementation] of Object.entries(METHODS)) {
    if (typeof prototype[name] === "function") {
      continue; // TypeScript 7.1 and later already provide it.
    }
    Object.defineProperty(prototype, name, {
      configurable: true,
      value(...args) {
        return implementation(checker, this, ...args);
      },
      writable: true,
    });
  }

  for (const [oldName, newName] of Object.entries(PREDICATE_ALIASES)) {
    if (typeof prototype[oldName] === "function" || typeof prototype[newName] !== "function") {
      continue;
    }
    Object.defineProperty(prototype, oldName, {
      configurable: true,
      value(...args) {
        return prototype[newName].apply(this, args);
      },
      writable: true,
    });
  }

  if (typeof prototype.isUnionOrIntersection !== "function") {
    Object.defineProperty(prototype, "isUnionOrIntersection", {
      configurable: true,
      value() {
        return this.isUnionType() || this.isIntersectionType();
      },
      writable: true,
    });
  }

  installSymbolCompat(checker);
  installed = true;
}

function installSymbolCompat(checker) {
  // Symbol is not exported either, so reach its prototype through any instance.
  const sample = checker.getPropertyOfType(checker.getStringType(), "length");
  if (!sample) {
    return;
  }
  const prototype = Object.getPrototypeOf(sample);
  for (const [name, implementation] of Object.entries(SYMBOL_METHODS)) {
    if (typeof prototype[name] === "function") {
      continue;
    }
    Object.defineProperty(prototype, name, {
      configurable: true,
      value(...args) {
        return implementation(this, ...args);
      },
      writable: true,
    });
  }
}

/** Test hook: allow reinstalling against a fresh checker. */
export function resetTypeCompat() {
  installed = false;
}
