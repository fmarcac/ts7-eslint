// The codebases the benchmark runs against.
//
// Chosen for variety rather than convenience: a reactive library heavy on generics, a
// schema library heavy on conditional types, a pattern matcher that is almost entirely
// type-level, and a real full-stack application with its dependencies installed and a
// large test suite. Anything whose imports do not resolve is a bad corpus: unresolved
// modules become error types and bury real differences under spurious no-unsafe-*
// reports on both stacks.
//
// The application is a private codebase, so its location comes from the environment and
// the two corpora that use it are left out when that is not set:
//
//   TS7_ESLINT_APP_CORPUS=~/src/some-app node tools/bench/run.mjs
//
// It is expected to hold `server/` and `client/` directories, each with a tsconfig.json
// and a src/.

import { join } from "node:path";

const bench = join(process.cwd(), ".tmp", "bench");
const app = process.env.TS7_ESLINT_APP_CORPUS;

export const corpora = [
  {
    name: "rxjs",
    note: "reactive library, generic-heavy",
    tsconfig: join(bench, "rxjs/packages/rxjs/tsconfig.json"),
    root: join(bench, "rxjs/packages/rxjs/src"),
    exclude: "\\.spec\\.ts$",
  },
  {
    name: "zod",
    note: "schema library, conditional types",
    tsconfig: join(bench, "zod/packages/zod/tsconfig.json"),
    root: join(bench, "zod/packages/zod/src"),
    exclude: "\\.test\\.ts$",
  },
  {
    name: "ts-pattern",
    note: "pattern matching, almost all type-level",
    tsconfig: join(bench, "ts-pattern/tsconfig.json"),
    root: join(bench, "ts-pattern/src"),
  },
  ...(app
    ? [
        {
          name: "app-backend",
          note: "application backend, dependencies installed",
          tsconfig: join(app, "server/tsconfig.json"),
          root: join(app, "server/src"),
        },
        {
          name: "app-frontend",
          note: "application frontend, React and TSX",
          tsconfig: join(app, "client/tsconfig.json"),
          root: join(app, "client/src"),
        },
      ]
    : []),
];
