// Asking the compiler about several nodes at once.
//
// getTypeAtLocation is the single most requested thing in a lint run, and on a 295-file
// application it accounts for around 118,000 of the 300,000 round trips. The Checker
// takes an array as well as a single node and answers the whole array in one request, so
// the cost of a batch is the cost of one query plus the server's work for the rest.
//
// What makes batching worth trying at all is that ESLint traverses the tree once and runs
// every rule against that one walk, so the nodes rules ask about arrive in document
// order. The node after the one being asked about is very often the next one asked about.
//
// A speculative prefetch was tried before this and removed: it resolved a type for every
// node up front, which was a small gain on ordinary code and a catastrophe on type-heavy
// code, where resolving a conditional or mapped type nobody asked for can cost more than
// the entire rest of the run. What is different here is which nodes are candidates. Only
// value positions are, and identifiers inside type nodes are not reached at all, so the
// work being brought forward is work the checker has already done to check the file.
//
// A wide window wins even though it resolves types nobody asks about, because a request
// costs more than the bytes it brings back: on the application backend, no batching is
// 8.80 s, a window of 128 is 7.17 s and one of 512 is 6.95 s. Past 1024 it stops
// mattering, since one query already covers most of a file.

import { SyntaxKind } from "typescript/unstable/ast";

/** How many nodes to ask about at once. */
const WINDOW = 512;

/**
 * A batch slower than this is resolving types nobody wants, and the file stops batching.
 *
 * Set where only genuine pathology reaches it. Answers the checker already holds cost
 * well under a millisecond each. Set it near the honest cost of a batch instead and it
 * fires on the first query against a file, which is the one that makes the checker check
 * that file and its imports, and would have cost the same asked singly. That first query
 * is exempt for the same reason.
 */
const SLOW_BATCH_MS = 500;

/**
 * Node kinds rules ask about.
 *
 * Deliberately only value positions. A type node's type is what the removed prefetch
 * choked on: in a file that is mostly conditional and mapped types, resolving one of
 * them can cost more than every rule in the run.
 */
const QUERYABLE = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.AsExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.ClassExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Identifier,
  SyntaxKind.JsxElement,
  SyntaxKind.JsxExpression,
  SyntaxKind.JsxFragment,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.NewExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NonNullExpression,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.StringLiteral,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
  SyntaxKind.YieldExpression,
]);

/**
 * An identifier that names a type rather than a value.
 *
 * These take the single-query path because the answer needs the type-position fallback,
 * which is itself two more queries; running that for a node no rule asked about would
 * spend three requests to save one.
 */
function namesAType(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  return (
    (parent.kind === SyntaxKind.TypeReference && parent.typeName === node) ||
    (parent.kind === SyntaxKind.ExpressionWithTypeArguments && parent.expression === node) ||
    (parent.kind === SyntaxKind.TypeQuery && parent.exprName === node)
  );
}

/** Document-order list of the queryable nodes in a file, and each one's position in it. */
const orderBySourceFile = new WeakMap();

/** Files that have already had a batch, so the checker has already checked them. */
const checked = new WeakSet();

/**
 * Files to stop batching in.
 *
 * A window is only as answerable as its least answerable node: one node the server
 * panics on takes the whole request with it. Rather than give up on batching for the
 * run, give up on the file, and let the single-node path, which recovers from a panic
 * one answer at a time, finish it.
 */
const givenUp = new WeakSet();

/** Batches issued and nodes they covered, so a run can report whether this is earning its keep. */
let batches = 0;
let batched = 0;
let attempts = 0;
/** Kinds asked about that no window could cover. Only collected under TSESLINT7_TIMING. */
const missedKinds = new Map();
const trackMisses = process.env.TSESLINT7_TIMING === "1";

export function batchStats() {
  return {
    attempts,
    batches,
    batched,
    missed: [...missedKinds].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

const KIND_NAMES = Object.fromEntries(Object.entries(SyntaxKind).map(([name, value]) => [value, name]));

function kindName(kind) {
  return KIND_NAMES[kind] ?? String(kind);
}

function note(reason) {
  if (trackMisses) {
    missedKinds.set(reason, (missedKinds.get(reason) ?? 0) + 1);
  }
}

function queryOrder(sourceFile) {
  let order = orderBySourceFile.get(sourceFile);
  if (order) {
    return order;
  }

  const nodes = [];
  const walk = (node) => {
    if (QUERYABLE.has(node.kind) && !namesAType(node)) {
      nodes.push(node);
    }
    node.forEachChild(walk);
    return undefined;
  };
  sourceFile.forEachChild(walk);

  const position = new Map();
  for (const [index, node] of nodes.entries()) {
    position.set(node, index);
  }
  order = { nodes, position };
  orderBySourceFile.set(sourceFile, order);
  return order;
}

/**
 * Resolve the type of `node` and of the nodes that follow it, in one request.
 *
 * Returns false when there was nothing to batch, in which case the caller should ask the
 * single-node way. Otherwise every node in the window is in `cache` on return.
 *
 * getSymbolAtLocation takes an array too, and batching it the same way was tried and
 * dropped: it removed 5,000 requests on the backend corpus and added 24 MB of symbols
 * nobody asked for, which came out 170 ms slower.
 */
export function batchTypesFrom(checker, node, cache, request) {
  attempts++;
  let sourceFile;
  try {
    sourceFile = node.getSourceFile?.();
  } catch {
    return false;
  }
  if (!sourceFile || givenUp.has(sourceFile)) {
    return false;
  }

  const { nodes, position } = queryOrder(sourceFile);
  const start = position.get(node);
  if (start === undefined) {
    note(kindName(node.kind));
    return false;
  }

  const window = [];
  for (let index = start; index < nodes.length && window.length < WINDOW; index++) {
    if (!cache.has(nodes[index])) {
      window.push(nodes[index]);
    }
  }
  if (window.length < 2) {
    note("neighbours already known");
    return false;
  }

  const first = !checked.has(sourceFile);
  checked.add(sourceFile);

  const started = performance.now();
  let types;
  try {
    types = request(window);
  } catch {
    givenUp.add(sourceFile);
    note("server refused the window");
    return false;
  }
  const elapsed = performance.now() - started;

  batches++;
  batched += window.length;
  for (const [index, member] of window.entries()) {
    cache.set(member, types[index]);
  }
  if (!first && elapsed > SLOW_BATCH_MS) {
    givenUp.add(sourceFile);
    note("window too slow");
  }
  return true;
}
