// Syntax chosen to break a naive scanner. Every entry is a case where the correct split,
// or the correct answer to "is this a comment", depends on parser context rather than on
// the characters alone.

export const fixtures = [
  {
    name: "import-export-attributes",
    ext: "ts",
    code: `import data from "./data.json" with { type: "json" };
export { default as data } from "./data.json" with { type: "json" };
export * from "./data.json" with { type: "json" };
`,
  },
  {
    name: "export-interleaved-comments",
    ext: "ts",
    code: `export /* declaration */ const x = 1;
export default /* function */ function f() {}
`,
  },
  {
    name: "basic",
    ext: "ts",
    code: `const greeting: string = "hello";
function add(a: number, b: number): number { return a + b; }
export { add, greeting };
`,
  },
  {
    name: "generics-shift-ambiguity",
    ext: "ts",
    code: `type Nested = Map<string, Array<Record<string, number>>>;
const shifted = 1 >> 2;
const unsigned = 8 >>> 1;
function f<T extends Array<Map<string, T>>>(x: T): T { return x; }
`,
  },
  {
    name: "regex-vs-division",
    ext: "ts",
    code: `const ratio = 10 / 2 / 1;
const pattern = /ab+c/gi;
const afterParen = (1 + 2) / 3;
const replaced = "x".replace(/\\/+/g, "-");
`,
  },
  {
    name: "template-literals",
    ext: "ts",
    code: `const plain = \`no substitution\`;
const name = "world";
const greet = \`hello \${name} and \${\`nested \${name}\`}!\`;
const tagged = String.raw\`c:\\path\\\${name}\`;
type Keys = \`prefix-\${string}\`;
`,
  },
  {
    name: "optional-chaining-and-nullish",
    ext: "ts",
    code: `declare const o: { a?: { b?: () => number } } | null;
const v = o?.a?.b?.();
const w = o?.["a"];
const fallback = v ?? 0;
const asserted = o!.a!.b!;
`,
  },
  {
    name: "private-identifiers",
    ext: "ts",
    code: `class Counter {
  #count = 0;
  static #instances = 0;
  has(o: object) { return #count in o; }
  bump() { this.#count++; }
}
`,
  },
  {
    name: "decorators",
    ext: "ts",
    code: `function dec(_t: unknown, _c: unknown) {}
@dec
class Service {
  @dec accessor value = 1;
  @dec method(@dec param: string) { return param; }
}
`,
  },
  {
    name: "numeric-forms",
    ext: "ts",
    code: `const big = 123n;
const hex = 0xff;
const bin = 0b1010;
const oct = 0o777;
const sep = 1_000_000;
const exp = 1.5e-10;
`,
  },
  {
    name: "modifiers-and-type-operators",
    ext: "ts",
    code: `abstract class A {
  abstract readonly x: number;
  protected static override toString(): string { return ""; }
}
type Ro = { readonly [K in keyof A as \`get\${string & K}\`]-?: A[K] };
const sat = { a: 1 } satisfies Record<string, number>;
const asConst = [1, 2] as const;
type Infer<T> = T extends Array<infer U> ? U : never;
`,
  },
  {
    name: "jsx",
    ext: "tsx",
    jsx: true,
    code: `const el = <div className="box" data-n={1}>
  text &amp; more {"expr"}
  <Self.Closing attr />
  <ns.Comp<string> prop={<span />} {...rest} />
</div>;
const empty = <></>;
const compare = 1 < 2;
`,
  },

  // Comment placement. A `//` inside a string, a regex, or JSX text is not a comment,
  // and a comment's own delimiters are not part of its value.
  {
    name: "comments-basic",
    ext: "ts",
    code: `// leading line comment
/* leading block */
const a = 1; // trailing line
/**
 * JSDoc block
 * @param x nothing
 */
function documented(x: number) {
  /* inner */ return x; // after return
}
/* multi
   line
   block */
export { documented };
`,
  },
  // Dynamic import. TypeScript parses it as a call whose callee is the `import` keyword;
  // ESTree gives it its own node with the specifier in `source`. Getting that wrong is
  // not visible in the tree shape alone: the callee has no type, so every dynamic import
  // in a file gets reported by no-unsafe-call.
  {
    name: "dynamic-import",
    ext: "ts",
    code: `const lazy = () => import("./module");
const withOptions = import("./module", { with: { type: "json" } });
async function load() {
  const mod = await import("./other");
  return mod;
}
export { lazy, withOptions, load };
`,
  },

  // A file whose very first characters are a JSDoc comment attached to a declaration.
  // TypeScript 7 hangs that comment on the declaration as a JSDoc *node*, and asking
  // astnav for the token at position 0 answers with that node rather than with a token,
  // so the token list ends up covering the same characters as the comment list. ESLint
  // merges the two into one position-ordered sequence and never terminates when they
  // overlap: the whole file hangs. Nothing else here opens that way.
  {
    name: "comments-leading-jsdoc",
    ext: "ts",
    code: `/**
 * Documented from the first character of the file.
 * @public
 */
export interface Documented {
  /** A documented member. */
  value: string;
}
`,
  },
  {
    name: "comments-not-comments",
    ext: "ts",
    code: `const url = "https://example.com/not-a-comment";
const re = /\\/\\/ still not a comment/;
const tpl = \`// inside a template \${1 /* but this is */}\`;
const div = 10 / 2; // real comment
`,
  },
  {
    name: "comments-in-jsx",
    ext: "tsx",
    jsx: true,
    code: `const node = <div>
  // this is JSX text, not a comment
  {/* this IS a comment */}
  <span attr="// also text" />
</div>;
`,
  },
  {
    name: "shebang",
    ext: "ts",
    code: `#!/usr/bin/env node
// a real comment after the shebang
const started = true;
export { started };
`,
  },

  // Constructs the converter was not written against, added to find real gaps rather
  // than confirm the shapes it was built from.
  {
    name: "destructuring",
    ext: "ts",
    code: `const { a, b: renamed, c = 1, ...restObj } = source;
const [first, , third = 2, ...restArr] = list;
const { deep: { nested: [x] } } = tree;
function take({ p, q = 3 }: Opts, [r]: number[]) { return p + q + r; }
({ assigned } = other);
[swapA, swapB] = [swapB, swapA];
`,
  },
  {
    name: "control-flow",
    ext: "ts",
    code: `outer: for (const k in obj) {
  if (k) continue outer; else break outer;
}
for (let i = 0, j = 1; i < j; i++, j--) {}
for await (const chunk of stream) {}
do { keepGoing(); } while (cond);
switch (v) {
  case 1:
  case 2: { run(); break; }
  default: fallback();
}
try { risky(); } catch { recover(); } finally { cleanup(); }
try { risky(); } catch (e: unknown) { report(e); }
while (true) { ; }
`,
  },
  {
    name: "class-members",
    ext: "ts",
    code: `class Full extends Base implements A, B {
  static { initialize(); }
  [key: string]: unknown;
  constructor(private readonly dep: Dep, public other: number) { super(); }
  get value(): number { return 1; }
  set value(next: number) {}
  static async *gen(): AsyncGenerator<number> { yield 1; }
  declare marker: string;
  override method(): void {}
}
`,
  },
  {
    name: "enums-and-namespaces",
    ext: "ts",
    code: `enum Direction { Up, Down = 5, Named = "n" }
const enum Fast { A = 1 }
declare enum Ambient { X }
namespace Outer.Inner { export const value = 1; }
declare module "external" { export const thing: number; }
declare global { interface Window { custom: string } }
`,
  },
  {
    name: "functions-and-generators",
    ext: "ts",
    code: `async function* streamer(): AsyncGenerator<number> {
  yield 1;
  yield* other();
  const v = await promise;
  return v;
}
function overloaded(a: string): string;
function overloaded(a: number): number;
function overloaded(a: unknown): unknown { return a; }
const seq = (a, b) => (a, b);
const nested = () => () => 1;
new.target;
`,
  },
  {
    name: "modules",
    ext: "ts",
    code: `import * as ns from "a";
import type { T } from "b";
import { type U, V } from "c";
import def, * as everything from "d";
import "side-effect";
export * from "e";
export * as grouped from "f";
export { one, two as three } from "g";
export type { T as Alias };
export default function named() {}
`,
  },
  {
    name: "type-system",
    ext: "ts",
    code: `type Tuple = [first: string, second?: number, ...rest: boolean[]];
type Guard = (x: unknown) => x is string;
type Ctor = new (a: string) => object;
type Idx = { [k: string]: number };
type Q = typeof globalThis;
type Rec = A.B.C<D>;
type Opt = { a?: string; readonly b: number };
declare function assertIt(x: unknown): asserts x is string;
type Callable = { <T>(x: T): T; new (y: string): object; (z: number): void };
declare global {
  interface Augmented {
    [Symbol.iterator]: { <T>(source: ReadonlyArray<T>): T };
  }
}
abstract class Shape { abstract area(): number; }
`,
  },
  {
    name: "export-assignment",
    ext: "ts",
    code: `declare function f(): void;
declare namespace f { const version: string }
export = f;
`,
  },
  {
    name: "export-assignment-in-module",
    ext: "ts",
    code: `declare module "pkg/a.js" {
  import { Duplex } from "stream";
  function open(stream: Duplex): void;
  export = open;
}
declare module "pkg/b.js" {
  export function named(): void;
  export as namespace PkgB;
}
`,
  },
  {
    name: "import-equals-and-default-export",
    ext: "ts",
    code: `import fs = require("node:fs");
import Alias = fs.promises;
export default class {
  method(): void {}
}
export const used = Alias;
`,
  },
];
