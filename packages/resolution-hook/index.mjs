// Wire upstream @typescript-eslint to this stack without touching the consumer's
// package.json.
//
// The alternative is npm `overrides`, which means a multi-line block spelled differently
// by npm, pnpm, and yarn, in every consuming repo. A synchronous resolution hook does the
// same redirect at runtime, so consumer setup collapses to a single import.
//
// The redirect is scoped by *requester*, not by specifier alone. Only modules living
// under @typescript-eslint or ts-api-utils get the shim; the application's own
// `import ts from "typescript"` still resolves to the real TypeScript 7, so tsc and
// anything else in the process are unaffected.

import { createRequire, registerHooks } from "node:module";

const require = createRequire(import.meta.url);

/** Specifier to redirect, and the module that stands in for it. */
const REDIRECTS = new Map([["typescript", "../ts-compat/index.cjs"]]);

/** Only requesters inside these subtrees are redirected. */
const SUBTREES = ["/node_modules/@typescript-eslint/", "/node_modules/ts-api-utils/"];

function isRedirectedRequester(parentURL) {
  return parentURL != null && SUBTREES.some((subtree) => parentURL.includes(subtree));
}

export function installResolutionHook({ onRedirect } = {}) {
  // Resolve targets from *our* location, by path rather than by package name. Resolving
  // them from the requester would fail under pnpm, where @typescript-eslint's directory
  // cannot see our modules at all.
  const resolved = new Map(
    [...REDIRECTS].map(([specifier, target]) => [
      specifier,
      new URL(target, import.meta.url).href,
    ]),
  );

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolved.get(specifier);
      if (url && isRedirectedRequester(context.parentURL)) {
        onRedirect?.(specifier, context.parentURL);
        return { shortCircuit: true, url };
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * The hook cannot apply retroactively: anything already in the module cache keeps the
 * binding it resolved with. Report that loudly rather than linting with a half-wired
 * stack.
 */
export function assertNotAlreadyLoaded() {
  const loaded = Object.keys(require.cache).filter((path) =>
    SUBTREES.some((subtree) => path.includes(subtree)),
  );
  if (loaded.length > 0) {
    throw new Error(
      `@typescript-eslint was loaded before the resolution hook was installed ` +
        `(${loaded.length} modules). Import this package first.`,
    );
  }
}
