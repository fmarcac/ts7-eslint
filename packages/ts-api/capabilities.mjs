// What the installed TypeScript can do.
//
// The floor is 7.0.2, the current stable release. TypeScript 7.1 adds methods without
// removing any, so support is a matter of detecting what is present rather than
// branching on version strings.
//
// Measured between 7.0.2 and 7.1.0-dev.20260806.1: 28 methods added, none removed, no
// exported class or function removed, and ast/scanner, ast/astnav and the SyntaxKind
// enum byte-identical. The one breaking change is parseConfigFile, which returns
// ParsedCommandLine on 7.1 and ConfigResponse on 7.0.

import { API } from "typescript/unstable/sync";
import { version } from "typescript";

/**
 * 7.1 adds runWithTemporaryFileUpdate(baseSnapshot, file, newText, callback): evaluate a
 * file against replacement text without touching disk, scoped to a callback.
 *
 * It is detected but not used as the default path. The temporary snapshot lives only for
 * the duration of the callback, and an ESLint parser cannot hold one open across rule
 * execution: parseForESLint returns an AST, and rules query types long after it returns.
 * It becomes useful in a batch driver that owns the whole lint of a file, which is why
 * it is surfaced here rather than ignored.
 */
const hasTemporaryFileUpdate = typeof API.prototype.runWithTemporaryFileUpdate === "function";

export const capabilities = {
  /** The real TypeScript package version backing this process. */
  typescriptVersion: version,
  /** Whether API.runWithTemporaryFileUpdate is available (TypeScript 7.1 and later). */
  temporaryFileUpdate: hasTemporaryFileUpdate,
  /** Whether parseConfigFile returns a ParsedCommandLine rather than a ConfigResponse. */
  parseConfigReturnsCommandLine: hasTemporaryFileUpdate,
};
