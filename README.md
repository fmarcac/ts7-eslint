# ts7-eslint

Type-aware ESLint for TypeScript 7, the native Go port.

TypeScript 7 ships without a JavaScript compiler API. The `typescript` package exports
only `./unstable/*`, its root export is a version stub, and everything built on
`ts.createProgram` and `ts.TypeChecker` stopped working with it. `@typescript-eslint`
declares `typescript: ">=4.8.4 <6.1.0"` and refuses at import:

```
typescript-eslint does not support TS 7.0.
```

This rebuilds the layers that touched the compiler, on top of `typescript/unstable/*`,
and runs the published rules unmodified. All 134 of them execute against the real
TypeScript 7 checker.

Upstream tracks TypeScript 7 in
[#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940). Their
reason for waiting, that a project with their compatibility obligations should not build
on an API named `unstable`, is a good one. This is the experiment that issue invites.

## Install

```sh
npm install --save-dev ts7-eslint eslint typescript@7
```

Node 22.15 or newer, for `module.registerHooks`. `@typescript-eslint/eslint-plugin` comes
with it, and should not be installed separately: it has to be loaded after the resolution
hook, which is what the entry point does.

## Usage

```js
// eslint.config.mjs
import tseslint from "ts7-eslint";

export default tseslint.config(tseslint.configs.recommendedTypeChecked);
```

`tseslint.configs` also has `base`, `recommended`, `strict`, `strictTypeChecked`,
`stylistic` and `stylisticTypeChecked`. The parser uses the nearest `tsconfig.json` above
each file; to name one explicitly, add a config object of your own:

```js
export default tseslint.config(tseslint.configs.recommendedTypeChecked, {
  languageOptions: {
    parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
  },
});
```

Upstream's `typescript` imports are redirected at runtime by a hook scoped to modules
under `@typescript-eslint` and `ts-api-utils`, so your own `import ts from "typescript"`
still resolves to the real TypeScript 7 and nothing in `package.json` changes.

## What is inside

One published package, five layers.

| Layer | Responsibility |
| --- | --- |
| `ts-api` | The only one that imports `typescript/unstable/*`. Owns the program and checker, and restores the TypeScript 6 object model over TypeScript 7's handles |
| `typescript-estree` | TypeScript AST to TSESTree, with tokens and comments rebuilt from the scanner |
| `parser` | `parseForESLint`, and the `parserServices` rules expect |
| `ts-compat` | The `ts` namespace upstream imports, 168 members |
| `resolution-hook` | Points those imports at the shim, and nothing else's |

Nothing upstream is patched or forked. `eslint-plugin`, `type-utils`, `utils`,
`scope-manager`, `types` and `visitor-keys` are the published 8.66.0 packages, used as
they are.

## Verification

`pnpm test` compares the AST against `typescript@6.0.3`, the newest release the current
stack supports, which keeps this a comparison of TypeScript 7 rather than of TypeScript
versions. 23 fixtures match node for node, 1081 of 1081, along with every token and
comment. The corpus deliberately includes constructs the converter was not written
against: destructuring in every position, parameter properties, static blocks, tuple
labels, type predicates, JSX, dynamic `import()`, and the comment traps.

`node tools/bench/run.mjs` lints five codebases with both stacks and compares every
finding on rule, message and position.

| Corpus | Files | TS 6.0.3 | TS 7.0.2 | | Findings | Agreement |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| rxjs | 125 | 2.18 s | **1.47 s** | 1.48x faster | 401 | 100.00% |
| zod | 118 | **4.40 s** | 4.64 s | 1.06x slower | 2434 | 100.00% |
| ts-pattern | 18 | 0.77 s | **0.48 s** | 1.61x faster | 266 | 100.00% |
| app-backend | 295 | **6.42 s** | 7.03 s | 1.09x slower | 2096 | 100.00% |
| app-frontend | 416 | 2.54 s | **2.19 s** | 1.16x faster | 558 | 100.00% |
| **total** | **972** | 16.30 s | **15.81 s** | 1.03x faster | **5686** | **100.00%** |

Every finding agrees, 0 disagreements in 5,686, across generic-heavy library code,
type-level metaprogramming, a React frontend, and an application backend with 1,400
tests. The last two are a private codebase, so the benchmark reads its location from
`TS7_ESLINT_APP_CORPUS` and leaves them out when that is not set.

## Speed

The 10x in the TypeScript 7 announcement is a whole-program build: one question, then Go
working in parallel. A linter is the opposite shape of workload. It asks hundreds of
thousands of small questions, one AST node at a time, each a synchronous round trip over
a pipe, and about half of that time is transport rather than compilation.

So the cost model is the number of questions, and that is where the work went. On the
295-file backend the first working version made 664,000 round trips; it now makes
106,000, by memoising what the compiler asks itself, batching a file's nodes into one
request, and not asking questions whose answer is already known. Shortcuts of that last
kind are checked rather than argued: `TS7_ESLINT_VERIFY=1` asks the compiler anyway and
compares the two answers by identity.

What is left is 3.4 s of round trip on that corpus, 1.8 s of it the compiler computing.
The rest is the pipe, and it is why two of the five corpora are still slower.

## Limitations

- A `tsconfig.json` is required. TypeScript 7 has no standalone parser, since an AST can
  only come from a program, so there is no project-less mode.
- `getAwaitedType` is reimplemented, because neither TypeScript 7.0 nor the 7.1
  development builds have it. A union mixing promises and non-promises comes back
  unchanged, as the API offers no way to construct a union type.
- `getChildren` is reconstructed from the scanner. ESLint does not read it; 18 of 23
  fixtures reproduce TypeScript 6.0.3 exactly and the rest differ only where the two
  parsers themselves do.
- `typescript/unstable/*` will change. Every import of it lives in one layer.

## License

MIT
