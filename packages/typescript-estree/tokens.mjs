// ESLint's token list, rebuilt on TypeScript 7.
//
// TS 7 has no Node.getChildren(), which is how upstream typescript-estree walks leaf
// tokens. TS 7's own astnav module solves the same problem by pairing forEachChild with
// a scanner that recovers the punctuation and keyword tokens in the gaps between child
// nodes. getTokenAtPosition and findNextToken are the public surface of that machinery,
// so walking the stream through them keeps the parser's context decisions (JSX versus
// comparison, regex versus division, `>>` versus two closing generics) rather than
// re-deriving them.
//
// getTokenType and convertToken are deliberate ports of upstream's versions and must
// stay behaviourally identical; the differential runner holds them to it.

import {
  SyntaxKind,
  findNextToken,
  getTokenAtPosition,
} from "typescript/unstable/ast";
import { getLocFor } from "./node-utils.mjs";

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
 * Every source token in order, as raw TypeScript nodes.
 *
 * Comment collection needs the token nodes themselves (for `pos`, `end`, and `parent`),
 * not their ESTree projections, so the walk is exposed separately from the conversion.
 */
export function* walkTokenNodes(sourceFile) {
  let token = getTokenAtPosition(sourceFile, 0);

  while (token && token.kind !== END_OF_FILE) {
    yield token;
    const next = findNextToken(token, sourceFile, sourceFile);
    if (!next || next.end <= token.end) {
      // No forward progress means the walk is stuck; stop rather than spin.
      break;
    }
    token = next;
  }
}

/**
 * ESLint's `ast.tokens`.
 *
 * TS scans `</` as a single LessThanSlashToken in JSX. Upstream never sees that: its
 * getChildren() walk re-scans with the non-JSX scanner, which splits the same two
 * characters into `<` and `/`. Rules are written against the two-token view, so match it.
 */
export function convertTokens(sourceFile) {
  const tokens = [];
  for (const token of walkTokenNodes(sourceFile)) {
    if (token.kind === SyntaxKind.LessThanSlashToken) {
      const start = token.getStart(sourceFile);
      tokens.push(makePunctuator("<", start, start + 1, sourceFile));
      tokens.push(makePunctuator("/", start + 1, start + 2, sourceFile));
      continue;
    }
    tokens.push(convertToken(token, sourceFile));
  }
  return tokens;
}
