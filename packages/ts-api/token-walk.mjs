// Walking the token stream without paying for a root descent per token.
//
// astnav's findNextToken searches inside whatever node it is handed, and on the way down
// it inspects every child at every level rather than binary searching. Handing it the
// source file therefore costs a full descent from the root for each token, so sweeping a
// whole file is quadratic in the size of the top-level statement list. On a 5,000 line
// file that is the single most expensive thing this project does.
//
// The fix does not change the answer. The root descent always passes through the token's
// own ancestor chain, so starting at the lowest ancestor that extends past the token
// reaches the same node with the same rules, having skipped the levels above it.

import { findNextToken } from "typescript/unstable/ast";

/** The token starting exactly where `token` ends, or undefined at end of file. */
export function nextTokenAfter(token, sourceFile) {
  let scope = token.parent;
  while (scope && scope.end <= token.end) {
    scope = scope.parent;
  }
  return findNextToken(token, scope ?? sourceFile, sourceFile);
}
