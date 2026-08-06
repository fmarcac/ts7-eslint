// @tseslint7/typescript-estree
//
// Converts a TypeScript 7 SourceFile into the AST ESLint expects. The compiler
// connection itself belongs to @tseslint7/ts-api; this package only transforms what that
// package hands it.

export { convertComments } from "./comments.mjs";
export { getLocFor, getRange } from "./node-utils.mjs";
export { convertToken, convertTokens, getTokenType, walkTokenNodes } from "./tokens.mjs";

import { convertComments } from "./comments.mjs";
import { convertTokens } from "./tokens.mjs";

/**
 * The syntactic half of the ESLint AST: the token stream and the comments.
 *
 * Node conversion is not wired in yet, so this is deliberately partial.
 */
export function convertSourceFile(sourceFile) {
  return {
    comments: convertComments(sourceFile),
    tokens: convertTokens(sourceFile),
  };
}
