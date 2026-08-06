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

/**
 * A recursive signature of TypeScript 6's getChildren() output.
 *
 * TypeScript 7 dropped getChildren, so the reconstruction has to be held against the
 * real thing. Kinds are rendered by name and positions are full positions, which is what
 * getChildren itself reports.
 */
export function childrenSignature(code, { jsx = false } = {}) {
  const sourceFile = ts.createSourceFile(
    jsx ? "f.tsx" : "f.ts",
    code,
    ts.ScriptTarget.ESNext,
    true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = [];
  (function walk(node, depth) {
    lines.push(`${"  ".repeat(depth)}${ts.SyntaxKind[node.kind]}[${node.pos},${node.end}]`);
    for (const child of node.getChildren(sourceFile)) {
      walk(child, depth + 1);
    }
  })(sourceFile, 0);
  return lines;
}
