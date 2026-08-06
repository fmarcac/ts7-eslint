// @tseslint7/typescript-estree
//
// Converts a TypeScript 7 SourceFile into the AST ESLint expects. The compiler
// connection itself belongs to @tseslint7/ts-api; this package only transforms what that
// package hands it.

export { convertComments } from "./comments.mjs";
export { Converter, convertProgram } from "./convert.mjs";
export { getLocFor, getRange } from "./node-utils.mjs";
export { convertToken, convertTokens, getTokenType, walkTokenNodes } from "./tokens.mjs";

import { convertComments } from "./comments.mjs";
import { convertProgram } from "./convert.mjs";
import { convertTokens } from "./tokens.mjs";

/**
 * The full ESLint AST for a source file, plus the maps that let type-aware rules get
 * back to the TypeScript node behind any ESTree node.
 */
export function convertSourceFile(sourceFile) {
  const { ast, esTreeNodeToTSNodeMap, tsNodeToESTreeNodeMap } = convertProgram(sourceFile);

  // ESLint reads comments and tokens off the Program node itself.
  ast.comments = convertComments(sourceFile);
  ast.tokens = convertTokens(sourceFile);

  return { ast, esTreeNodeToTSNodeMap, tsNodeToESTreeNodeMap };
}
