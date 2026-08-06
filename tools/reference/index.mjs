// The differential baseline.
//
// This package pins TypeScript 6.0.3, the newest version @typescript-eslint@8.66.0
// supports, and runs the real upstream parser against it. Everything this project
// produces is compared to what comes out of here.
//
// It is a separate workspace package purely so pnpm resolves `typescript` to 6.0.3
// here while resolving it to 7.x everywhere else.

import { parse } from "@typescript-eslint/typescript-estree";
import ts from "typescript";

export const referenceTypeScriptVersion = ts.version;

/**
 * Parse with upstream typescript-estree, requesting the full syntactic output.
 * No program and no type information: tokens and comments are purely syntactic.
 */
export function parseReference(code, { jsx = false } = {}) {
  return parse(code, {
    comment: true,
    jsx,
    loc: true,
    range: true,
    tokens: true,
  });
}
