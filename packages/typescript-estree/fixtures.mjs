// Syntax chosen to break a naive scanner. Every entry is a case where the correct split,
// or the correct answer to "is this a comment", depends on parser context rather than on
// the characters alone.

export const fixtures = [
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
];
