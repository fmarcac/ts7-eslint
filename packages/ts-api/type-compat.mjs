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

import { SyntaxKind } from "typescript/unstable/ast";
import { SignatureKind, TypeFlags } from "typescript/unstable/sync";

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

function installTypeMethods(prototype) {
  for (const [name, implementation] of Object.entries(TYPE_METHODS)) {
    if (typeof prototype[name] !== "function") {
      define(prototype, name, function (...args) {
        return implementation(currentChecker, this, ...args);
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
 * The array form of lazyHandle, for fields holding a list of handle ids.
 *
 * Same re-entrancy problem: getAliasTypeArguments() reads this.aliasTypeArguments.
 */
function lazyHandleArray(object, name, resolve) {
  const raw = object[name];
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "number") {
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
      cached = (resolve.call(this) ?? []).map(adaptType);
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

  // Not every type object comes from the same class, so patching the prototype of one
  // sample is not enough. Any type that arrives without the restored surface gets its
  // own prototype patched, once.
  if (typeof type.isUnionOrIntersection !== "function") {
    installTypeMethods(Object.getPrototypeOf(type));
  }
  lazyHandle(type, "target", function () {
    return adaptType(this.getTarget());
  });
  lazyHandle(type, "symbol", function () {
    return adaptSymbol(this.getSymbol());
  });
  lazyHandle(type, "aliasSymbol", function () {
    return adaptSymbol(this.getAliasSymbol());
  });

  // Type also keeps four *lists* of handle ids. no-unnecessary-type-assertion reads
  // `type.aliasTypeArguments` directly and recurses into the elements, so a bare number
  // reaches code expecting a Type.
  lazyHandleArray(type, "aliasTypeArguments", function () {
    return this.getAliasTypeArguments();
  });
  lazyHandleArray(type, "typeParameters", function () {
    return this.getTypeParameters();
  });
  lazyHandleArray(type, "outerTypeParameters", function () {
    return this.getOuterTypeParameters();
  });
  lazyHandleArray(type, "localTypeParameters", function () {
    return this.getLocalTypeParameters();
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

function installSignatureMethods(prototype) {
  if (typeof prototype.getReturnType !== "function") {
    define(prototype, "getReturnType", function () {
      return currentChecker.getReturnTypeOfSignature(this);
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
    installSignatureMethods(Object.getPrototypeOf(signature));
    signatureMethodsInstalled = true;
  }

  const raw = signature.parameters;
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) {
    define(signature, "parameters", signature.getParameters().map(adaptSymbol));
  }
  return signature;
}

// ---- getAwaitedType ------------------------------------------------------
//
// Absent from TypeScript 7.0 *and* from the 7.1 development builds, unlike most of this
// file, so it is reimplemented rather than waiting for the runtime to supply it.
//
// This follows the compiler's own getPromisedTypeOfPromise: read the `then` property,
// take its first call signature, take that signature's first parameter (the `onfulfilled`
// callback), and take *its* first parameter. That is the promised type. Awaiting is then
// applied repeatedly, so `Promise<Promise<T>>` resolves to `T`.

const MAX_AWAIT_DEPTH = 10;

function isFlagSet(type, flags) {
  return type != null && (type.flags & flags) !== 0;
}

function firstParameterType(checker, signature) {
  const parameters = signature.getParameters?.() ?? [];
  if (parameters.length === 0) {
    return undefined;
  }
  return checker.getParameterType
    ? checker.getParameterType(signature, 0)
    : checker.getTypeOfSymbol(parameters[0]);
}

function getPromisedTypeOfPromise(checker, type) {
  // `Promise<T>` is by far the common case and the type argument is exact, so take it
  // directly rather than going round the `then` signature.
  if (type.isTypeReference?.()) {
    const name = type.getTarget?.()?.getSymbol?.()?.name ?? type.getSymbol?.()?.name;
    if (name === "Promise") {
      const args = checker.getTypeArguments(type);
      if (args?.length > 0) {
        return args[0];
      }
    }
  }

  const thenSymbol = checker.getPropertyOfType(type, "then");
  if (!thenSymbol) {
    return undefined;
  }
  const thenType = checker.getTypeOfSymbol(thenSymbol);
  if (!thenType || isFlagSet(thenType, TypeFlags.Any)) {
    return undefined;
  }
  const thenSignatures = checker.getSignaturesOfType(thenType, SignatureKind.Call);
  if (!thenSignatures || thenSignatures.length === 0) {
    return undefined;
  }

  // `onfulfilled` is declared as `((value: T) => ...) | null | undefined`, so the
  // nullable part has to come off before it has call signatures.
  const onFulfilled = firstParameterType(checker, thenSignatures[0]);
  if (!onFulfilled || isFlagSet(onFulfilled, TypeFlags.Any)) {
    return undefined;
  }
  const callback = checker.getNonNullableType(onFulfilled) ?? onFulfilled;
  const callbackSignatures = checker.getSignaturesOfType(callback, SignatureKind.Call);
  if (!callbackSignatures || callbackSignatures.length === 0) {
    return undefined;
  }
  return firstParameterType(checker, callbackSignatures[0]);
}

function computeAwaitedType(checker, type, depth = 0) {
  if (!type || depth >= MAX_AWAIT_DEPTH) {
    return type;
  }
  if (isFlagSet(type, TypeFlags.Any | TypeFlags.Unknown)) {
    return type;
  }

  if (type.isUnionType?.()) {
    const constituents = type.getTypes() ?? [];
    const awaited = constituents.map((part) => computeAwaitedType(checker, part, depth + 1));

    // Nothing was a promise, so the union is its own awaited type, identity intact.
    if (awaited.every((part, index) => part === constituents[index])) {
      return type;
    }
    // `any | T` collapses to `any` and `unknown | T` to `unknown`, so when a constituent
    // awaits to either, that is the answer for the whole union.
    const absorbing = awaited.find((part) => isFlagSet(part, TypeFlags.Any | TypeFlags.Unknown));
    if (absorbing) {
      return absorbing;
    }
    // Otherwise the true answer is a union of the awaited constituents, and the API
    // offers no way to construct one. Returning the original union keeps the callers'
    // identity comparisons meaningful and never invents a type that does not exist.
    return type;
  }

  const promised = getPromisedTypeOfPromise(checker, type);
  return promised ? computeAwaitedType(checker, promised, depth + 1) : type;
}

/**
 * Node kinds that must not be handed to getTypeAtLocation.
 *
 * `checker.getTypeAtLocation(importClause)` crashes the Go server outright with
 * "panic: runtime error: invalid memory address or nil pointer dereference". Rules never
 * ask about an import clause, so nothing is lost by skipping it, but a speculative
 * prefetch would walk straight into it. Established by sweeping every node kind in a
 * real codebase, where this is the only one that panics.
 */
const UNSAFE_FOR_TYPE_QUERY = new Set([SyntaxKind.ImportClause]);

/** Memoise methods taking one object, keyed by that object's identity. */
function memoiseByObject(checker, names) {
  for (const name of names) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    const cache = new WeakMap();
    define(checker, name, function (argument) {
      if (argument === null || typeof argument !== "object") {
        return original.call(checker, argument);
      }
      if (cache.has(argument)) {
        return cache.get(argument);
      }
      const result = original.call(checker, argument);
      cache.set(argument, result);
      return result;
    });
  }
}

/** Memoise methods taking an object plus a primitive, such as (type, name). */
function memoiseByObjectAndKey(checker, names) {
  for (const name of names) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    const cache = new WeakMap();
    define(checker, name, function (argument, key, ...rest) {
      // Only the two-argument form is memoised; anything richer goes straight through.
      if (argument === null || typeof argument !== "object" || rest.length > 0) {
        return original.call(checker, argument, key, ...rest);
      }
      let byKey = cache.get(argument);
      if (!byKey) {
        byKey = new Map();
        cache.set(argument, byKey);
      }
      if (byKey.has(key)) {
        return byKey.get(key);
      }
      const result = original.call(checker, argument, key);
      byKey.set(key, result);
      return result;
    });
  }
}

/** Every node in a file that is safe to ask about, the unit the prefetch works in. */
function collectNodes(sourceFile) {
  const nodes = [];
  (function walk(node) {
    if (!UNSAFE_FOR_TYPE_QUERY.has(node.kind)) {
      nodes.push(node);
    }
    node.forEachChild(walk);
  })(sourceFile);
  return nodes;
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

/**
 * The checker in play right now.
 *
 * Prototype patches are shared by every type object in the process, but each type
 * belongs to one project checker. ESLint lints one project at a time, so the active
 * checker is tracked here and read dynamically; capturing one in a closure would make a
 * second project resolve its types against the first one.
 */
let currentChecker;
let prototypesPatched = false;
/** Checkers whose own methods have been wrapped. */
const patchedCheckers = new WeakSet();

/**
 * Patch the compiler's object model in place.
 *
 * None of these classes are exported, so each prototype is reached through an instance.
 * ESLint lints one project at a time, so binding to a single checker is sound; the
 * program service resets this whenever the snapshot, and therefore the checker, changes.
 */
export function installTypeCompat(checker) {
  currentChecker = checker;
  if (patchedCheckers.has(checker)) {
    return;
  }

  const sampleType = checker.getAnyType();
  if (!sampleType) {
    return;
  }

  if (!prototypesPatched) {
    installTypeMethods(Object.getPrototypeOf(sampleType));
    const sampleSymbol = checker.getPropertyOfType(checker.getStringType(), "length");
    if (sampleSymbol) {
      installSymbolMethods(Object.getPrototypeOf(sampleSymbol));
    }
    prototypesPatched = true;
  }

    // Absent from 7.0 and 7.1 alike, so it is supplied rather than bridged.
  if (typeof checker.getAwaitedType !== "function") {
    define(checker, "getAwaitedType", (type) => adaptType(computeAwaitedType(checker, type)));
  }

  // Likewise absent. The contextual type of a call argument is the type of the parameter
  // it binds to in the resolved signature, and getParameterType already handles rest
  // parameters, so this is a short composition rather than a reimplementation.
  if (typeof checker.getContextualTypeForArgumentAtIndex !== "function") {
    define(checker, "getContextualTypeForArgumentAtIndex", (call, index) => {
      const signature = checker.getResolvedSignature(call);
      return signature ? adaptType(checker.getParameterType(signature, index)) : undefined;
    });
  }

  // Every checker call is an IPC round trip to the Go process, and rules ask for the
  // type of the same node repeatedly. Types are immutable within a snapshot, so the
  // answer can be memoised per node; the program service drops the cache whenever the
  // snapshot, and therefore the checker, is replaced.
  for (const name of ["getTypeAtLocation", "getSymbolAtLocation"]) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    const cache = new WeakMap();
    const prefetched = new WeakSet();
    const adapt = name === "getTypeAtLocation" ? adaptType : adaptSymbol;

    define(checker, name, function (nodeOrNodes) {
      // The array overload already batches on the server; pass it straight through.
      if (Array.isArray(nodeOrNodes)) {
        return original.call(checker, nodeOrNodes).map(adapt);
      }
      if (cache.has(nodeOrNodes)) {
        return adapt(cache.get(nodeOrNodes));
      }

      // First question about this file: answer it for every node at once. One round
      // trip costs about what eight individual ones do, and a type-aware rule pass asks
      // about most of the file anyway. Files that no type-aware rule touches never get
      // here, so a purely syntactic run pays nothing.
      const sourceFile = nodeOrNodes.getSourceFile?.();
      if (sourceFile && !prefetched.has(sourceFile)) {
        prefetched.add(sourceFile);
        const nodes = collectNodes(sourceFile);
        if (nodes.length > 0) {
          // The prefetch is an optimisation and must never change an answer. If the
          // batch fails for any reason, fall back to asking one node at a time.
          try {
            const answers = original.call(checker, nodes);
            for (const [index, node] of nodes.entries()) {
              cache.set(node, answers[index]);
            }
          } catch {
            // Leave the cache alone; the per-node path below still works.
          }
        }
        if (cache.has(nodeOrNodes)) {
          return adapt(cache.get(nodeOrNodes));
        }
      }

      const result = original.call(checker, nodeOrNodes);
      cache.set(nodeOrNodes, result);
      return adapt(result);
    });
  }

  // Every remaining checker call is also a round trip, and rules ask the same questions
  // over and over: the type of a symbol, the signatures of a type, the apparent type of
  // a receiver. All are pure within a snapshot, so memoise them by argument identity.
  memoiseByObject(checker, [
    "getAliasedSymbol",
    "getApparentType",
    "getBaseConstraintOfType",
    "getBaseTypeOfLiteralType",
    "getBaseTypes",
    "getIndexInfosOfType",
    "getNonNullableType",
    "getPropertiesOfType",
    "getReturnTypeOfSignature",
    "getTypeArguments",
    "getTypeOfSymbol",
    "getWidenedType",
  ]);
  memoiseByObjectAndKey(checker, ["getPropertyOfType", "getSignaturesOfType", "typeToString"]);

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

  patchedCheckers.add(checker);
}

/** Used when a snapshot change replaces the checker. */
export function resetTypeCompat() {
  currentChecker = undefined;
}
