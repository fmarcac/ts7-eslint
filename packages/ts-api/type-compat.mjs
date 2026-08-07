// TypeScript 6's Type, Symbol and Signature surface, restored on TypeScript 7.0.
//
// TS 6 hung convenience methods off the objects themselves and stored resolved nodes
// inline. TS 7 moved the methods onto the Checker and made the objects thin handles.
// ts-api-utils and many rules were written against the old shape, so this bridges it.
//
// Two different mechanisms are needed, because the two kinds of difference are not alike:
//
// Checker answers are also memoised by argument identity. Every call is a synchronous
// IPC round trip to the Go process and rules ask the same questions repeatedly, so that
// is where nearly all of the speed comes from. Speculatively prefetching a whole file's
// types was tried and removed: a 4% gain on ordinary code, and a catastrophe on
// type-heavy code, because it resolves expensive types no rule would ever have asked
// for. Memoising can only avoid work; prefetching can invent it.
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
import { ObjectFlags, SignatureKind, SymbolFlags, TypeFlags } from "typescript/unstable/sync";
import { batchTypesFrom } from "./type-batch.mjs";

/** Batched look-ahead for type queries. Set TS7_ESLINT_BATCH=0 to ask one node at a time. */
const batching = process.env.TS7_ESLINT_BATCH !== "0";

/**
 * Answer the questions this file shortcuts both ways, and compare.
 *
 * A shortcut that avoids a round trip is only worth having if it gives the same answer,
 * and "the compiler's own implementation says so" is an argument, not evidence. Under
 * TS7_ESLINT_VERIFY=1 the avoided call is made anyway and the two answers compared by
 * identity, so the benchmark can report whether they ever differ.
 */
const verifying = process.env.TS7_ESLINT_VERIFY === "1";
let shortcutsChecked = 0;
let shortcutsWrong = 0;

function verifyShortcut(answer, ask) {
  shortcutsChecked++;
  let expected;
  try {
    expected = ask();
  } catch {
    return;
  }
  if (expected !== answer) {
    shortcutsWrong++;
  }
}

/** Undefined unless TS7_ESLINT_VERIFY=1 was set. */
export function shortcutAudit() {
  return verifying ? { checked: shortcutsChecked, wrong: shortcutsWrong } : undefined;
}

/** Objects already adapted, so repeat crossings are free. */
const adapted = new WeakSet();
/** Prototype methods already wrapped, so reinstalling does not nest wrappers. */
const wrappedTypeMethods = new WeakSet();
/** Instance methods already memoised, for the same reason. */
const memoisedMethods = new WeakSet();

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
  //
  // Always a list, even when the compiler could not produce one: a consumer that reaches
  // this is about to iterate it, and every one of them treats an empty constituent list
  // as "nothing matched", which keeps a rule quiet rather than inventing a report.
  if (!("types" in prototype)) {
    defineGetter(prototype, "types", function () {
      return this.getTypes() ?? [];
    });
  }
}

// Every one of these is a round trip to resolve a handle the type object is already
// holding, and every one is pure within a snapshot.
const TYPE_METHODS_RETURNING_TYPES = [
  "getAliasTypeArguments",
  "getBaseType",
  "getBaseTypes",
  "getCheckType",
  "getConstraint",
  "getExtendsType",
  "getFalseType",
  "getFreshType",
  "getIndexType",
  "getLocalTypeParameters",
  "getObjectType",
  "getOuterTypeParameters",
  "getRegularType",
  "getTarget",
  "getTrueType",
  "getTypeParameters",
  "getTypes",
];

const TYPE_METHODS_RETURNING_SYMBOLS = ["getAliasSymbol", "getSymbol"];

/** Restore the TS 6 surface on a type class, and stop it re-asking the server. */
function patchTypePrototype(prototype) {
  installTypeMethods(prototype);
  memoiseInstanceMethods(prototype, TYPE_METHODS_RETURNING_TYPES, adaptType);
  memoiseInstanceMethods(prototype, TYPE_METHODS_RETURNING_SYMBOLS, adaptSymbol);
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
  if (!Array.isArray(raw)) {
    return;
  }

  // TypeScript 6 left these undefined when there were none; TypeScript 7 gives an empty
  // array. That difference is not cosmetic. no-unnecessary-type-assertion does
  //     type.aliasTypeArguments ?? (isTypeReference(type) ? getTypeArguments(type) : [])
  // and an empty array satisfies `??`, so the type graph is never walked, containsAny
  // comes back false, and a necessary assertion gets reported as unnecessary.
  if (raw.length === 0) {
    // Plain assignment, not defineProperty: this runs for four fields on every type
    // object that crosses the checker boundary, and these are ordinary writable class
    // fields, so redefining them costs more than writing them.
    object[name] = undefined;
    return;
  }
  if (typeof raw[0] !== "number") {
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
    patchTypePrototype(Object.getPrototypeOf(type));
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

  // TypeScript 6 gave a unique symbol type an `escapedName`, the mangled property name
  // that a computed key using that symbol produces: `Symbol.asyncIterator` declares
  // `__@asyncIterator@6`, where 6 is the symbol's id. TypeScript 7 has no such field.
  //
  // ts-api-utils compares a property's escapedName against it to decide whether a type
  // really has a well-known symbol member. With the field absent the comparison is
  // against undefined, never matches, and await-thenable reports every `for await` over
  // a genuine async iterable as being over a non-async one.
  if (isFlagSet(type, TypeFlags.UniqueESSymbol) && !("escapedName" in type)) {
    defineGetter(type, "escapedName", function () {
      const symbol = this.symbol;
      return symbol ? `__@${symbol.escapedName ?? symbol.name}@${symbol.id}` : undefined;
    });
  }

  // TypeScript 6 exposed a type reference's arguments as a `typeArguments` property as
  // well as through getTypeArguments. TypeScript 7 has only the method, and there is no
  // field to adapt: the property simply is not there.
  //
  // type-utils reads the property. isUnsafeAssignment compares a sender's type arguments
  // against a receiver's with `type.typeArguments ?? []`, so on TypeScript 7 it compared
  // nothing and called every generic assignment safe. `const xs: Foo[] = new Array(n)`
  // assigns `any[]` and went unreported.
  if (!("typeArguments" in type)) {
    let cached;
    let computed = false;
    defineGetter(type, "typeArguments", function () {
      if (!computed) {
        computed = true;
        cached = isTypeReference(this) ? currentChecker.getTypeArguments(this) : undefined;
      }
      return cached;
    });
  }

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
    const prototype = Object.getPrototypeOf(signature);
    installSignatureMethods(prototype);
    // The signature class is not reachable from the checker, so this is the first
    // instance we see. getParameters is one round trip and rules ask it per argument.
    memoiseInstanceMethods(prototype, ["getParameters"], adaptSymbol);
    memoiseInstanceMethods(prototype, ["getTypeParameters"], adaptType);
    signatureMethodsInstalled = true;
  }

  const raw = signature.parameters;
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) {
    signature.parameters = signature.getParameters().map(adaptSymbol);
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

/**
 * Whether a type is a reference to a generic type, and so has type arguments.
 *
 * Worth testing before asking: typescript-go's getTypeArguments dereferences the target
 * without checking, so asking a non-reference crashes the server rather than answering.
 */
function isTypeReference(type) {
  return type != null && ((type.objectFlags ?? 0) & ObjectFlags.Reference) !== 0;
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
 * Recover the type of an identifier that names a type.
 *
 * TypeScript 6 answered getTypeAtLocation on the `Observable` in `Observable<T>` with
 * the type itself. TypeScript 7 answers `any`, which is a real behavioural difference in
 * the API rather than anything this project does: raw tsgo says `any` too. Rules map
 * ESTree type nodes onto these identifiers and ask about them, so the difference shows
 * up directly in lint output.
 *
 * getTypeFromTypeNode on the enclosing type node still gives the TS 6 answer, so the
 * fallback is applied narrowly: only when the answer was `any`, and only for an
 * identifier that actually names a type reference.
 */
function resolveTypePosition(checker, node, result) {
  if (!isFlagSet(result, TypeFlags.Any) || !node?.parent) {
    return result;
  }
  const parent = node.parent;
  const namesTheType =
    (parent.kind === SyntaxKind.TypeReference && parent.typeName === node) ||
    (parent.kind === SyntaxKind.ExpressionWithTypeArguments && parent.expression === node) ||
    (parent.kind === SyntaxKind.TypeQuery && parent.exprName === node);
  if (!namesTheType) {
    return result;
  }
  // The *declared* type, not the type instantiated at this use site. TypeScript 6
  // answers `Observable<T>` for the name in `Observable<T>`, keeping the declaration's
  // own type parameter; resolving the enclosing type node instead substitutes whatever
  // the surrounding call inferred, which is a different answer.
  try {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      const declared = checker.getDeclaredTypeOfSymbol(symbol);
      if (declared && !isFlagSet(declared, TypeFlags.Any)) {
        return declared;
      }
    }
    return checker.getTypeFromTypeNode(parent) ?? result;
  } catch {
    return result;
  }
}

/**
 * A panic on the server rather than an error from our own code.
 *
 * The sync channel reports one by throwing an Error whose message is the Go panic text
 * and stack, so the marker is the message itself.
 */
function isServerPanic(error) {
  return typeof error?.message === "string" && error.message.startsWith("panic:");
}

/** Queries typescript-go could not answer. Reported by the benchmark, asserted by tests. */
let unanswered = 0;
let panicReported = false;

export function unansweredQueries() {
  return unanswered;
}

/**
 * Ask, and survive an answer the compiler cannot produce.
 *
 * typescript-go recovers from its own panics and keeps serving, so a query it cannot
 * answer should cost that one answer. Letting it through instead ends the process, and one
 * line in one file discards every finding in every other file of the run, which is by far
 * the worse failure. The count is reported at the end of a run and the first one is
 * printed, so a degraded answer is never silent.
 *
 * Seen on typescript@7.0.2: `s.match(/x/g) ?? []` builds a union whose second member is a
 * fresh empty-array literal, and api/proto.go newTypeResponse does an unchecked
 * AsTupleType on it.
 */
function surviving(compute, fallback) {
  try {
    return compute();
  } catch (error) {
    if (!isServerPanic(error)) {
      throw error;
    }
    unanswered++;
    if (!panicReported) {
      panicReported = true;
      const summary = String(error.message).split("\n")[0];
      console.warn(
        `ts7-eslint: the TypeScript 7 compiler could not answer a type query (${summary}). ` +
          "That type is reported as unknown; the run continues.",
      );
    }
    return fallback;
  }
}

/** Memoise methods taking one object, keyed by that object's identity. */
function memoiseByObject(checker, names) {
  for (const name of names) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    const cache = new WeakMap();
    define(checker, name, function (argument, ...rest) {
      // Several of these take an optional second argument (getResolvedSignature takes a
      // candidates array, getContextualType takes context flags). Those calls are not
      // keyed by it, so they go straight through rather than reading a cache entry that
      // answers a different question.
      if (argument === null || typeof argument !== "object" || rest.length > 0) {
        return original.call(checker, argument, ...rest);
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

/** Memoise methods taking two objects, such as (symbol, node). */
function memoiseByTwoObjects(checker, names) {
  for (const name of names) {
    const original = checker[name];
    if (typeof original !== "function") {
      continue;
    }
    const cache = new WeakMap();
    define(checker, name, function (first, second, ...rest) {
      if (
        first === null ||
        typeof first !== "object" ||
        second === null ||
        typeof second !== "object" ||
        rest.length > 0
      ) {
        return original.call(checker, first, second, ...rest);
      }
      let inner = cache.get(first);
      if (!inner) {
        inner = new WeakMap();
        cache.set(first, inner);
      }
      if (inner.has(second)) {
        return inner.get(second);
      }
      const result = original.call(checker, first, second);
      inner.set(second, result);
      return result;
    });
  }
}

/**
 * Memoise no-argument methods on a compiler object's own prototype, keyed by the
 * instance, and adapt what they return on the way out.
 *
 * These are the calls that do not go through the Checker at all: `type.getTypes()`,
 * `type.getSymbol()`, `signature.getParameters()`. Each is a round trip, each is pure
 * within a snapshot, and rules ask them constantly: on one 295-file application they were
 * 200,000 of the 660,000 requests in a run.
 *
 * The compiler has its own cache for some of them, keyed by the handle id stored on the
 * object, but this file replaces those fields with the resolved objects, so that cache
 * can no longer match. Memoising here restores what it was for.
 *
 * Arrays are copied out. Every one of these methods builds a fresh array per call today,
 * and handing the same instance to every caller would let one of them mutate the answer
 * for the rest.
 */
function memoiseInstanceMethods(prototype, names, adapt) {
  for (const name of names) {
    const original = prototype[name];
    if (typeof original !== "function" || memoisedMethods.has(original)) {
      continue;
    }
    const cache = new WeakMap();
    const wrapper = function () {
      let result;
      if (cache.has(this)) {
        result = cache.get(this);
      } else {
        // Each of these is one request to the compiler, and any of them can be the one it
        // cannot build a response for. The undefined is cached with the rest, so a type
        // that panicked once is not asked about again.
        const raw = surviving(() => original.call(this), undefined);
        result = Array.isArray(raw) ? raw.map(adapt) : adapt(raw);
        cache.set(this, result);
      }
      return Array.isArray(result) ? result.slice() : result;
    };
    memoisedMethods.add(wrapper);
    define(prototype, name, wrapper);
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
    patchTypePrototype(Object.getPrototypeOf(sampleType));
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
    const adapt = name === "getTypeAtLocation" ? adaptType : adaptSymbol;

    define(checker, name, function (nodeOrNodes) {
      // The array overload already batches on the server; pass it straight through.
      if (Array.isArray(nodeOrNodes)) {
        return original.call(checker, nodeOrNodes).map(adapt);
      }
      if (cache.has(nodeOrNodes)) {
        return adapt(cache.get(nodeOrNodes));
      }

      // One request for this node and the ones after it. When it works, the next few
      // queries are cache hits; when it does not, this is the ordinary single query.
      if (
        batching &&
        name === "getTypeAtLocation" &&
        batchTypesFrom(checker, nodeOrNodes, cache, (window) => original.call(checker, window)) &&
        cache.has(nodeOrNodes)
      ) {
        const batched = resolveTypePosition(checker, nodeOrNodes, cache.get(nodeOrNodes));
        cache.set(nodeOrNodes, batched);
        return adapt(batched);
      }

      let result;
      try {
        result = original.call(checker, nodeOrNodes);
      } catch (error) {
        if (!isServerPanic(error)) {
          throw error;
        }
        // typescript-go recovers from its own panic and keeps serving, so one node it
        // cannot answer for should cost one answer rather than every finding in the file.
        // Seen on typescript@7.0.2 building the response for a tuple type reference:
        // api/proto.go newTypeResponse does an unchecked AsTupleType. `unknown` is the
        // honest stand-in, and it is the answer that makes the unsafe-* rules stay quiet
        // rather than invent a report from a type nobody could compute.
        unanswered++;
        result = name === "getTypeAtLocation" ? checker.getUnknownType() : undefined;
      }
      if (name === "getTypeAtLocation") {
        result = resolveTypePosition(checker, nodeOrNodes, result);
      }
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
    "getConstantValue",
    "getConstraintOfTypeParameter",
    "getContextualType",
    "getDeclaredTypeOfSymbol",
    "getExportSpecifierLocalTargetSymbol",
    "getExportsOfModule",
    "getImmediateAliasedSymbol",
    "getIndexInfosOfType",
    "getNonNullableType",
    "getPropertiesOfType",
    "getResolvedSignature",
    "getResolvedSymbol",
    "getRestTypeOfSignature",
    "getReturnTypeOfSignature",
    "getShorthandAssignmentValueSymbol",
    "getSignatureFromDeclaration",
    "getTypeArguments",
    "getTypeFromTypeNode",
    "getTypeOfSymbol",
    "getTypePredicateOfSignature",
    "getWidenedType",
    "isArrayLikeType",
    "isArrayType",
    "isContextSensitive",
    "isTupleType",
  ]);
  memoiseByObjectAndKey(checker, [
    "getMemberInModuleExports",
    "getParameterType",
    "getPropertyOfType",
    "getSignaturesOfType",
    "typeToString",
  ]);
  memoiseByTwoObjects(checker, ["getTypeOfSymbolAtLocation", "isTypeAssignableTo"]);

  // typescript-go reads the target off whatever it is handed, so asking a type that is
  // not a reference for its type arguments takes the server down with a nil dereference
  // rather than returning nothing. TypeScript 6 answered the same question with an empty
  // list, so answer it here instead of asking.
  {
    const original = checker.getTypeArguments;
    define(checker, "getTypeArguments", (type) => (isTypeReference(type) ? original(type) : []));
  }

  // The type of a symbol *at a location* is the symbol's own type unless the location
  // refers to that symbol and control flow has narrowed it there. The compiler requires
  // the location to be an Identifier or PrivateIdentifier whose resolved symbol is the
  // symbol asked about; everything else falls through to getTypeOfSymbol.
  //
  // Whether the location resolves to the symbol needs the checker, but a necessary
  // condition does not: an identifier resolves to a symbol of its own name, so a name
  // mismatch rules narrowing out locally. That covers the traffic, because the calls are
  // overwhelmingly "the type of this parameter, at the callee": no-misused-promises asks
  // it for every parameter of every overload at every call site, and a parameter is not
  // named after the function it belongs to.
  //
  // An optional symbol is asked anyway. TypeScript 7 answers `T` for `then?: T` here and
  // `T | undefined` from getTypeOfSymbol, so for those two the question is genuinely not
  // the same one.
  //
  // Checked rather than argued. Under TS7_ESLINT_VERIFY=1 every shortcut answer is also
  // asked of the compiler and the two compared by identity: 129,362 across the five
  // benchmark corpora, none of them different.
  {
    const original = checker.getTypeOfSymbolAtLocation;
    define(checker, "getTypeOfSymbolAtLocation", (symbol, location) => {
      const kind = location?.kind;
      const mayDiffer =
        ((kind === SyntaxKind.Identifier || kind === SyntaxKind.PrivateIdentifier) &&
          location.text === symbol?.name) ||
        ((symbol?.flags ?? 0) & SymbolFlags.Optional) !== 0;
      if (mayDiffer) {
        return original(symbol, location);
      }
      const answer = checker.getTypeOfSymbol(symbol);
      if (verifying) {
        verifyShortcut(answer, () => original(symbol, location));
      }
      return answer;
    });
  }

  wrapReturning(checker, SYMBOL_RETURNING, adaptSymbol);
  wrapReturning(checker, SIGNATURE_RETURNING, adaptSignature);
  wrapReturning(checker, TYPE_RETURNING, adaptType);

  patchedCheckers.add(checker);
}

/** Used when a snapshot change replaces the checker. */
export function resetTypeCompat() {
  currentChecker = undefined;
}
