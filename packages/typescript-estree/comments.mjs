// Comment collection.
//
// Upstream delegates this to ts-api-utils' iterateComments, which walks every token and
// asks the scanner for the comment ranges leading and trailing each one. Its token walk
// uses getChildren(), which TypeScript 7 does not have, so this reuses the token walker
// from tokens.mjs and keeps the rest of the algorithm intact, including the shebang skip
// and the JSX trailing-trivia rules. Those rules exist because inside JSX a `//` is
// ordinary text, not a comment.

import { SyntaxKind } from "typescript/unstable/ast";
import {
  forEachLeadingCommentRange,
  forEachTrailingCommentRange,
  getShebang,
} from "typescript/unstable/ast/scanner";
import { getLocFor } from "./node-utils.mjs";
import { walkTokenNodes } from "./tokens.mjs";

const JSX_VARIANT = 1; // LanguageVariant.JSX

function isJsxElementOrFragment(node) {
  return node?.kind === SyntaxKind.JsxElement || node?.kind === SyntaxKind.JsxFragment;
}

/** Port of ts-api-utils' canHaveTrailingTrivia. */
function canHaveTrailingTrivia(token) {
  switch (token.kind) {
    case SyntaxKind.CloseBraceToken:
      return (
        token.parent.kind !== SyntaxKind.JsxExpression ||
        !isJsxElementOrFragment(token.parent.parent)
      );
    case SyntaxKind.GreaterThanToken:
      switch (token.parent.kind) {
        case SyntaxKind.JsxClosingElement:
        case SyntaxKind.JsxClosingFragment:
          return !isJsxElementOrFragment(token.parent.parent.parent);
        case SyntaxKind.JsxOpeningElement:
          return token.end !== token.parent.end;
        case SyntaxKind.JsxOpeningFragment:
          return false;
        default:
          return true;
      }
    default:
      return true;
  }
}

/**
 * Every comment in the file, in source order, in ESLint's shape.
 *
 * Line comments carry their text without the leading `//`; block comments without the
 * surrounding delimiters.
 */
export function convertComments(sourceFile) {
  const text = sourceFile.text;
  const notJsx = sourceFile.languageVariant !== JSX_VARIANT;
  const comments = [];
  const seen = new Set();

  const collect = (pos, end, kind) => {
    // Leading ranges of one token overlap trailing ranges of the previous one.
    const key = `${pos}:${end}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const isLine = kind === SyntaxKind.SingleLineCommentTrivia;
    comments.push({
      type: isLine ? "Line" : "Block",
      loc: getLocFor(pos, end, sourceFile),
      range: [pos, end],
      value: isLine ? text.slice(pos + 2, end) : text.slice(pos + 2, end - 2),
    });
  };

  for (const token of walkTokenNodes(sourceFile)) {
    if (token.pos === token.end) {
      continue;
    }

    if (token.kind !== SyntaxKind.JsxText) {
      const from = token.pos === 0 ? (getShebang(text) ?? "").length : token.pos;
      forEachLeadingCommentRange(text, from, (pos, end, kind) => {
        collect(pos, end, kind);
      });
    }

    if (notJsx || canHaveTrailingTrivia(token)) {
      forEachTrailingCommentRange(text, token.end, (pos, end, kind) => {
        collect(pos, end, kind);
      });
    }
  }

  comments.sort((a, b) => a.range[0] - b.range[0]);
  return comments;
}
