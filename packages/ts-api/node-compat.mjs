// Node.getChildren and friends, rebuilt on TypeScript 7.
//
// TS 6 gave every node getChildren(), getChildAt() and getChildCount(). TS 7 dropped
// them: it exposes forEachChild, which visits only the *named* children and skips the
// punctuation and keyword tokens between them.
//
// The reconstruction pairs forEachChild with the scanner-backed token walk in astnav,
// which is how TypeScript 7's own navigation helpers solve the same problem. Two details
// have to match TS 6 exactly or indices shift and rules misread the tree:
//
//   - Node arrays are wrapped in a synthetic SyntaxList node, so `function f()` reports
//     children [SyntaxList(modifiers), FunctionKeyword, Identifier, ...] rather than
//     splicing the modifiers in directly.
//   - Positions are full positions, including leading trivia, not getStart().
//
// The children differential in @ts7-eslint/typescript-estree compares this against TS
// 6.0.3's real getChildren across the whole fixture corpus, because an implementation
// that is merely close would misindex silently rather than fail.

import { NodeFlags, SyntaxKind, getTokenAtPosition } from "typescript/unstable/ast";
import { nextTokenAfter } from "./token-walk.mjs";

const SYNTAX_LIST = SyntaxKind.SyntaxList;
const END_OF_FILE = SyntaxKind.EndOfFile ?? SyntaxKind.EndOfFileToken;

/** Cached child lists, keyed by node. */
const childCache = new WeakMap();

/**
 * A SyntaxList's children are its elements *and* the separators between them, so
 * `(a, b)` reports Parameter, CommaToken, Parameter rather than just the two parameters.
 */
function syntaxListChildren(sourceFile, array) {
  const children = [];
  let cursor = array.pos;
  for (const element of array) {
    appendTokens(sourceFile, cursor, element.pos, children);
    children.push(element);
    cursor = element.end;
  }
  appendTokens(sourceFile, cursor, array.end, children);
  return children;
}

function makeSyntaxList(sourceFile, parent, array) {
  const elements = syntaxListChildren(sourceFile, array);
  const list = {
    kind: SYNTAX_LIST,
    flags: 0,
    parent,
    pos: array.pos,
    end: array.end,
    getSourceFile: () => sourceFile,
    getFullStart: () => array.pos,
    getStart: () => (elements.length > 0 ? elements[0].getStart(sourceFile) : array.pos),
    getEnd: () => array.end,
    getWidth: () => array.end - list.getStart(),
    getFullWidth: () => array.end - array.pos,
    getLeadingTriviaWidth: () => list.getStart() - array.pos,
    getFullText: () => sourceFile.text.slice(array.pos, array.end),
    getText: () => sourceFile.text.slice(list.getStart(), array.end),
    getChildren: () => elements,
    getChildCount: () => elements.length,
    getChildAt: (index) => elements[index],
    forEachChild: (cbNode) => {
      for (const element of elements) {
        const result = cbNode(element);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    },
  };
  return list;
}

/** Append every token strictly inside [from, to). */
function appendTokens(sourceFile, from, to, out) {
  if (from >= to) {
    return;
  }
  let token = getTokenAtPosition(sourceFile, from);
  while (token && token.pos < to) {
    if (token.end > to || token.kind === END_OF_FILE) {
      return;
    }
    out.push(token);
    const next = nextTokenAfter(token, sourceFile);
    if (!next || next.end <= token.end) {
      return;
    }
    token = next;
  }
}

function computeChildren(node, sourceFile) {
  // Tokens are leaves. Without this the token scan below would rediscover the token
  // itself and recurse forever, and TS 6 reports no children for them either.
  if (node.kind >= SyntaxKind.FirstToken && node.kind <= SyntaxKind.LastToken) {
    return [];
  }

  const sf = sourceFile ?? node.getSourceFile();
  const items = [];
  // TypeScript 7 synthesises reparsed nodes that TypeScript 6 never produced, such as a
  // zero-width export modifier inside a namespace. astnav skips them for the same
  // reason: they are not in the source and would shift every index after them.
  const isReparsed = (candidate) => (candidate.flags & NodeFlags.Reparsed) !== 0;
  node.forEachChild(
    (child) => {
      if (!isReparsed(child)) {
        items.push(child);
      }
      return undefined;
    },
    (array) => {
      if (array.length === 0 || !array.every(isReparsed)) {
        items.push(array);
      }
      return undefined;
    },
  );

  // JSDoc lives inside comment trivia, where the scanner does not tokenize the way it
  // does in code: asking it for the tokens spanning a JSDocText hands back the node
  // itself, which recurses. JSDoc contents report their named children only.
  const inJSDoc =
    node.kind >= SyntaxKind.FirstJSDocNode && node.kind <= SyntaxKind.LastJSDocNode;

  const children = [];
  let cursor = node.pos;
  for (const item of items) {
    if (!inJSDoc) {
      appendTokens(sf, cursor, item.pos, children);
    }
    children.push(Array.isArray(item) ? makeSyntaxList(sf, node, item) : item);
    cursor = item.end;
  }
  if (!inJSDoc) {
    appendTokens(sf, cursor, node.end, children);
  }

  // A child covering exactly the same span with the same kind is the scanner handing
  // back the node it was asked about. Never legitimate, and it recurses forever.
  return children.filter(
    (child) =>
      child !== node && !(child.kind === node.kind && child.pos === node.pos && child.end === node.end),
  );
}

let installed = false;

/**
 * Patch the shared node prototype.
 *
 * Every TypeScript 7 AST node inherits from one `RemoteNode`, which is where
 * forEachChild lives, so a single patch reaches all of them.
 */
export function installNodeCompat(node) {
  if (installed || !node) {
    return;
  }

  // Tokens are synthesized separately by astnav and do not share the tree's prototype,
  // so both have to be patched or a walk dies the first time it reaches a token.
  const prototypes = new Set();
  for (const sample of [node, getTokenAtPosition(node, 0)]) {
    let prototype = sample ? Object.getPrototypeOf(sample) : undefined;
    while (prototype && !Object.prototype.hasOwnProperty.call(prototype, "forEachChild")) {
      prototype = Object.getPrototypeOf(prototype);
    }
    if (prototype) {
      prototypes.add(prototype);
    }
  }
  if (prototypes.size === 0) {
    return;
  }
  for (const prototype of prototypes) {
    patchPrototype(prototype);
  }
  installed = true;
}

function patchPrototype(prototype) {
  if (typeof prototype.getChildren !== "function") {
    Object.defineProperty(prototype, "getChildren", {
      configurable: true,
      writable: true,
      value(sourceFile) {
        let children = childCache.get(this);
        if (!children) {
          children = computeChildren(this, sourceFile);
          childCache.set(this, children);
        }
        return children;
      },
    });
  }

  if (typeof prototype.getChildCount !== "function") {
    Object.defineProperty(prototype, "getChildCount", {
      configurable: true,
      writable: true,
      value(sourceFile) {
        return this.getChildren(sourceFile).length;
      },
    });
  }

  if (typeof prototype.getChildAt !== "function") {
    Object.defineProperty(prototype, "getChildAt", {
      configurable: true,
      writable: true,
      value(index, sourceFile) {
        return this.getChildren(sourceFile)[index];
      },
    });
  }
}

export function resetNodeCompat() {
  installed = false;
}
