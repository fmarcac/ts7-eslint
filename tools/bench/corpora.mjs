// The codebases the benchmark runs against.
//
// Chosen for variety rather than convenience: a reactive library heavy on generics, a
// schema library heavy on conditional types, a pattern matcher that is almost entirely
// type-level, and a real full-stack application with its dependencies installed and a
// large test suite. Anything whose imports do not resolve is a bad corpus: unresolved
// modules become error types and bury real differences under spurious no-unsafe-*
// reports on both stacks.

import { homedir } from "node:os";
import { join } from "node:path";

const bench = join(process.cwd(), ".tmp", "bench");
const app = join(homedir(), "git", "app");

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
];
