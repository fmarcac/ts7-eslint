// S1: rebuild ESLint's token list on TypeScript 7, which has no Node.getChildren().
//
// Upstream typescript-estree walks the tree with getChildren() and emits every leaf
// token. TS 7 dropped getChildren(), but its own astnav module solves the same problem
// by pairing forEachChild with a scanner that recovers the punctuation and keyword
// tokens sitting in the gaps between child nodes. getTokenAtPosition and findNextToken
// are the public surface of that machinery, so we walk the token stream through them
// and keep the parser's own context decisions (JSX vs comparison, regex vs division,
// >> vs two closing generics) instead of trying to re-derive them.
//
// getTokenType and convertToken below are deliberate ports of upstream's versions.
// They must stay behaviourally identical, so the differential runner can hold us to it.

import {
  SyntaxKind,
  findNextToken,
  getTokenAtPosition,
} from "typescript/unstable/ast";

// TS 7 renamed EndOfFileToken to EndOfFile. Tolerate either.
const END_OF_FILE = SyntaxKind.EndOfFile ?? SyntaxKind.EndOfFileToken;

function isJSXToken(node) {
  return node.kind >= SyntaxKind.JsxElement && node.kind <= SyntaxKind.JsxAttribute;
}

function hasJSXAncestor(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isJSXToken(current)) {
      return true;
    }
    if (current.kind === SyntaxKind.SourceFile) {
      return false;
    }
  }
  return false;
}

/** Port of upstream getTokenType. */
export function getTokenType(token) {
  if (token.kind === SyntaxKind.NullKeyword) {
    return "Null";
  }
  if (token.kind >= SyntaxKind.FirstKeyword && token.kind <= SyntaxKind.LastFutureReservedWord) {
    if (token.kind === SyntaxKind.FalseKeyword || token.kind === SyntaxKind.TrueKeyword) {
      return "Boolean";
    }
    return "Keyword";
  }
  if (token.kind >= SyntaxKind.FirstPunctuation && token.kind <= SyntaxKind.LastPunctuation) {
    return "Punctuator";
  }
  if (
    token.kind >= SyntaxKind.NoSubstitutionTemplateLiteral &&
    token.kind <= SyntaxKind.TemplateTail
  ) {
    return "Template";
  }

  switch (token.kind) {
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.NumericLiteral:
      return "Numeric";
    case SyntaxKind.PrivateIdentifier:
      return "PrivateIdentifier";
    case SyntaxKind.JsxText:
      return "JSXText";
    case SyntaxKind.StringLiteral:
      // A string literal parented by a JsxAttribute or JsxElement is JSXText in ESTree.
      if (
        token.parent.kind === SyntaxKind.JsxAttribute ||
        token.parent.kind === SyntaxKind.JsxElement
      ) {
        return "JSXText";
      }
      return "String";
    case SyntaxKind.RegularExpressionLiteral:
      return "RegularExpression";
    default:
      break;
  }

  if (token.kind === SyntaxKind.Identifier) {
    if (isJSXToken(token.parent)) {
      return "JSXIdentifier";
    }
    if (token.parent.kind === SyntaxKind.PropertyAccessExpression && hasJSXAncestor(token)) {
      return "JSXIdentifier";
    }
  }

  return "Identifier";
}

function getLocFor(start, end, sourceFile) {
  const startLoc = sourceFile.getLineAndCharacterOfPosition(start);
  const endLoc = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    start: { column: startLoc.character, line: startLoc.line + 1 },
    end: { column: endLoc.character, line: endLoc.line + 1 },
  };
}

/** Port of upstream convertToken. */
export function convertToken(token, sourceFile) {
  const start =
    token.kind === SyntaxKind.JsxText ? token.getFullStart() : token.getStart(sourceFile);
  const end = token.getEnd();
  const value = sourceFile.text.slice(start, end);
  const tokenType = getTokenType(token);
  const range = [start, end];
  const loc = getLocFor(start, end, sourceFile);

  if (tokenType === "RegularExpression") {
    return {
      type: tokenType,
      loc,
      range,
      regex: {
        flags: value.slice(value.lastIndexOf("/") + 1),
        pattern: value.slice(1, value.lastIndexOf("/")),
      },
      value,
    };
  }

  if (tokenType === "PrivateIdentifier") {
    return { type: tokenType, loc, range, value: value.slice(1) };
  }

  return { type: tokenType, loc, range, value };
}

function makePunctuator(value, start, end, sourceFile) {
  return {
    type: "Punctuator",
    loc: getLocFor(start, end, sourceFile),
    range: [start, end],
    value,
  };
}

/**
 * Emit one source token as the one or more ESTree tokens upstream produces for it.
 *
 * TS scans `</` as a single LessThanSlashToken in JSX context. Upstream never sees that:
 * its getChildren() walk re-scans with the non-JSX scanner, which splits the same two
 * characters into `<` and `/`. Rules are written against that two-token view, so match it.
 */
function pushToken(tokens, token, sourceFile) {
  if (token.kind === SyntaxKind.LessThanSlashToken) {
    const start = token.getStart(sourceFile);
    tokens.push(makePunctuator("<", start, start + 1, sourceFile));
    tokens.push(makePunctuator("/", start + 1, start + 2, sourceFile));
    return;
  }
  tokens.push(convertToken(token, sourceFile));
}

/**
 * Walk the whole token stream in source order.
 *
 * findNextToken recurses from the root on every step, so this is not linear. Correctness
 * first: if the differential passes, a single-pass forEachChild plus scanner walker is a
 * drop-in replacement for this function and nothing else has to change.
 */
export function collectTokens(sourceFile) {
  const tokens = [];
  let token = getTokenAtPosition(sourceFile, 0);

  while (token && token.kind !== END_OF_FILE) {
    pushToken(tokens, token, sourceFile);
    const next = findNextToken(token, sourceFile, sourceFile);
    if (!next || next.end <= token.end) {
      // No forward progress means the walk is stuck; stop rather than spin.
      break;
    }
    token = next;
  }

  return tokens;
}
