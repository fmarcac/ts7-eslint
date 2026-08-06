// TypeScript 6's Type, Symbol and Signature surface, restored on TypeScript 7.0.
//
// TS 6 hung convenience methods off the objects themselves and stored resolved nodes
// inline. TS 7 moved the methods onto the Checker and made the objects thin handles.
// ts-api-utils and many rules were written against the old shape, so this bridges it.
//
// Two different mechanisms are needed, because the two kinds of difference are not alike:
//
//   - Missing *methods* (Type.getProperty, Signature.getReturnType) go on the prototype.
//     Cheap, and shared by every instance.
//   - Changed *properties* (Signature.parameters became handle ids, Symbol.declarations
//     became NodeHandles) cannot: class fields are own properties, so a prototype getter
//     would be shadowed. Those are adapted per instance as they cross the checker
//     boundary, lazily where resolution costs a round trip.
//
// This is transitional. The 7.1 development builds add most of the Type methods back, so
// each one is installed only when it is actually missing.

import { SignatureKind } from "typescript/unstable/sync";

/** Objects already adapted, so repeat crossings are free. */
const adapted = new WeakSet();
/** Prototype methods already wrapped, so reinstalling does not nest wrappers. */
const wrappedTypeMethods = new WeakSet();

// ---- Type ----------------------------------------------------------------

const TYPE_METHODS = {
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
const TYPE_PREDICATES = {
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
  return infos.find((info) => info.keyType?.flags === wanted?.flags)?.valueType;
}

function define(target, name, value) {
  Object.defineProperty(target, name, { configurable: true, value, writable: true });
}

function defineGetter(target, name, get) {
  Object.defineProperty(target, name, { configurable: true, get });
}

function installTypeMethods(checker, prototype) {
  for (const [name, implementation] of Object.entries(TYPE_METHODS)) {
    if (typeof prototype[name] !== "function") {
      define(prototype, name, function (...args) {
        return implementation(checker, this, ...args);
      });
    }
  }

  for (const [oldName, newName] of Object.entries(TYPE_PREDICATES)) {
    if (typeof prototype[oldName] !== "function" && typeof prototype[newName] === "function") {
      define(prototype, oldName, function (...args) {
        return prototype[newName].apply(this, args);
      });
    }
  }

  if (typeof prototype.isUnionOrIntersection !== "function") {
    define(prototype, "isUnionOrIntersection", function () {
      return this.isUnionType() || this.isIntersectionType();
    });
  }

  // TS 6 exposed union and intersection members as a `types` property. TS 7 has
  // getTypes(). There is no own `types` field on the type object, so a prototype getter
  // is enough here. ts-api-utils iterates this, so without it unionConstituents yields
  // undefined and every consumer fails with "not iterable".
  if (!("types" in prototype)) {
    defineGetter(prototype, "types", function () {
      return this.getTypes();
    });
  }
}

/**
 * Replace a handle id with the object it denotes, resolved on first read.
 *
 * The resolver almost always reads the very property being replaced (getTarget() reads
 * `this.target`), so a naive getter would recurse forever. The re-entrancy guard hands
 * back the raw handle for reads that originate from inside the resolver, which is
 * exactly what it wants.
 */
function lazyHandle(object, name, resolve) {
  const raw = object[name];
  if (typeof raw !== "number" || raw === 0) {
    return;
  }
  let cached;
  let resolving = false;
  defineGetter(object, name, function () {
    if (cached !== undefined) {
      return cached;
    }
    if (resolving) {
      return raw;
    }
    resolving = true;
    try {
      cached = resolve.call(this);
    } finally {
      resolving = false;
    }
    return cached;
  });
}

/**
 * Resolve a type's handle ids to the objects they denote.
 *
 * TS 6 stored `target`, `symbol` and `aliasSymbol` as objects. TS 7 stores handle ids and
 * exposes getTarget(), getSymbol() and getAliasSymbol(). type-utils does
 * `type = type.target` and then calls methods on it, which fails on a bare number.
 */
function adaptType(type) {
  if (!type || typeof type !== "object" || adapted.has(type)) {
    return type;
  }
  adapted.add(type);
  lazyHandle(type, "target", function () {
    return adaptType(this.getTarget());
  });
  lazyHandle(type, "symbol", function () {
    return adaptSymbol(this.getSymbol());
  });
  lazyHandle(type, "aliasSymbol", function () {
    return adaptSymbol(this.getAliasSymbol());
  });
  return type;
}

// ---- Symbol --------------------------------------------------------------

const SYMBOL_METHODS = {
  getEscapedName: (symbol) => symbol.escapedName,
  getFlags: (symbol) => symbol.flags,
  getName: (symbol) => symbol.name,
};

function installSymbolMethods(prototype) {
  for (const [name, implementation] of Object.entries(SYMBOL_METHODS)) {
    if (typeof prototype[name] !== "function") {
      define(prototype, name, function (...args) {
        return implementation(this, ...args);
      });
    }
  }
  if (typeof prototype.getDeclarations !== "function") {
    define(prototype, "getDeclarations", function () {
      return this.declarations;
    });
  }
}

/**
 * Resolve a symbol's NodeHandles to real nodes.
 *
 * Lazily, because each resolution is a round trip and most symbols are never asked for
 * their declarations. A handle knows the project that produced it, so it resolves itself.
 */
function adaptSymbol(symbol) {
  if (!symbol || adapted.has(symbol)) {
    return symbol;
  }
  adapted.add(symbol);

  const rawValueDeclaration = symbol.valueDeclaration;
  if (typeof rawValueDeclaration?.resolve === "function") {
    let cached;
    defineGetter(symbol, "valueDeclaration", () => (cached ??= rawValueDeclaration.resolve()));
  }

  const rawDeclarations = symbol.declarations;
  if (Array.isArray(rawDeclarations) && typeof rawDeclarations[0]?.resolve === "function") {
    let cached;
    defineGetter(
      symbol,
      "declarations",
      () => (cached ??= rawDeclarations.map((handle) => handle.resolve?.() ?? handle)),
    );
  }

  return symbol;
}

// ---- Signature -----------------------------------------------------------

function installSignatureMethods(checker, prototype) {
  if (typeof prototype.getReturnType !== "function") {
    define(prototype, "getReturnType", function () {
      return checker.getReturnTypeOfSignature(this);
    });
  }
  if (typeof prototype.getDeclaration !== "function") {
    define(prototype, "getDeclaration", function () {
      return this.declaration?.resolve?.() ?? this.declaration;
    });
  }
}

/**
 * Replace a signature's parameter handle ids with the symbols they denote.
 *
 * TS 6's Signature.parameters was Symbol[]; TS 7's is number[] of handles, with the
 * symbols behind getParameters(). ts-api-utils indexes `signature.parameters[0]` and
 * hands the result straight to the checker, which rejects a bare number with
 * "empty symbol handle".
 *
 * Eager rather than lazy: getParameters() reads the very property being replaced, so a
 * lazy getter would have to unpick its own definition mid-call.
 */
let signatureMethodsInstalled = false;

function adaptSignature(signature) {
  if (!signature || adapted.has(signature)) {
    return signature;
  }
  adapted.add(signature);

  if (!signatureMethodsInstalled) {
    installSignatureMethods(boundChecker, Object.getPrototypeOf(signature));
    signatureMethodsInstalled = true;
  }

  const raw = signature.parameters;
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) {
    define(signature, "parameters", signature.getParameters().map(adaptSymbol));
  }
  return signature;
}

// ---- checker boundary ----------------------------------------------------

/** Checker methods whose results need per-instance adaptation. */
const SYMBOL_RETURNING = [
  "getAliasedSymbol",
  "getExportSpecifierLocalTargetSymbol",
  "getExportsOfModule",
  "getImmediateAliasedSymbol",
  "getMemberInModuleExports",
  "getPropertiesOfType",
  "getPropertyOfType",
  "getResolvedSymbol",
  "getShorthandAssignmentValueSymbol",
  "getSymbolAtLocation",
  "getSymbolAtPosition",
  "resolveName",
];

const TYPE_RETURNING = [
  "getApparentType",
  "getBaseConstraintOfType",
  "getBaseTypeOfLiteralType",
  "getConstraintOfTypeParameter",
  "getContextualType",
  "getDeclaredTypeOfSymbol",
  "getNonNullableType",
  "getParameterType",
  "getReturnTypeOfSignature",
  "getRestTypeOfSignature",
  "getTypeArguments",
  "getTypeAtLocation",
  "getTypeAtPosition",
  "getTypeFromTypeNode",
  "getTypeOfSymbol",
  "getTypeOfSymbolAtLocation",
  "getWidenedType",
];

const SIGNATURE_RETURNING = [
  "getResolvedSignature",
  "getSignatureFromDeclaration",
  "getSignaturesOfType",
];

function wrapReturning(checker, names, adapt) {
  for (const name of names) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    // Own property on the instance, shadowing the prototype method.
    define(checker, name, function (...args) {
      const result = original.apply(checker, args);
      return Array.isArray(result) ? result.map(adapt) : adapt(result);
    });
  }
}

let installed = false;
/** The checker the patches are bound to. */
let boundChecker;

/**
 * Patch the compiler's object model in place.
 *
 * None of these classes are exported, so each prototype is reached through an instance.
 * ESLint lints one project at a time, so binding to a single checker is sound; the
 * program service resets this whenever the snapshot, and therefore the checker, changes.
 */
export function installTypeCompat(checker) {
  if (installed) {
    return;
  }

  boundChecker = checker;

  const sampleType = checker.getAnyType();
  if (!sampleType) {
    return;
  }
  installTypeMethods(checker, Object.getPrototypeOf(sampleType));

  const sampleSymbol = checker.getPropertyOfType(checker.getStringType(), "length");
  if (sampleSymbol) {
    installSymbolMethods(Object.getPrototypeOf(sampleSymbol));
  }

    wrapReturning(checker, SYMBOL_RETURNING, adaptSymbol);
  wrapReturning(checker, SIGNATURE_RETURNING, adaptSignature);
  wrapReturning(checker, TYPE_RETURNING, adaptType);

  // Types also reach callers from other types, not only from the checker.
  const typePrototype = Object.getPrototypeOf(sampleType);
  for (const name of ["getTarget", "getTypes", "getConstraint", "getBaseTypes"]) {
    const original = typePrototype[name];
    if (typeof original !== "function" || wrappedTypeMethods.has(original)) {
      continue;
    }
    const wrapper = function (...args) {
      const result = original.apply(this, args);
      return Array.isArray(result) ? result.map(adaptType) : adaptType(result);
    };
    wrappedTypeMethods.add(wrapper);
    define(typePrototype, name, wrapper);
  }

  installed = true;
}

/** Test hook, and used when a snapshot change replaces the checker. */
export function resetTypeCompat() {
  installed = false;
  signatureMethodsInstalled = false;
}
