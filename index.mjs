// ts7-eslint
//
// Installs the resolution hook, then hands back upstream's plugin, this project's parser,
// and flat configs wiring the two together.

import {
  assertNotAlreadyLoaded,
  installResolutionHook,
} from "./packages/resolution-hook/index.mjs";

assertNotAlreadyLoaded();
installResolutionHook();

// Loaded dynamically, and only once the hook is in place. A static import is evaluated
// before any of the statements above, so the rules would bind to the real TypeScript 7,
// whose compiler API they cannot use.
const plugin = (await import("@typescript-eslint/eslint-plugin")).default;
const parser = (await import("./packages/parser/index.mjs")).default;

const FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

/**
 * Parser and plugin, no rules.
 *
 * `parserOptions.project` is optional: with nothing set, the parser uses the nearest
 * tsconfig.json above each file.
 */
export const base = {
  files: FILES,
  languageOptions: { parser, sourceType: "module" },
  plugins: { "@typescript-eslint": plugin },
};

/** The rules of one of the plugin's own named configs, its own rules only. */
function rulesOf(name) {
  const config = plugin.configs[name];
  const rules = Array.isArray(config) ? config.at(-1)?.rules : config?.rules;
  if (!rules) {
    throw new Error(`@typescript-eslint has no config named "${name}"`);
  }
  return Object.fromEntries(
    Object.entries(rules).filter(([id]) => id.startsWith("@typescript-eslint/")),
  );
}

function configFor(name) {
  return [base, { files: FILES, rules: rulesOf(name) }];
}

// Getters, so a config nobody asks for cannot fail the import.
export const configs = {
  get base() {
    return [base];
  },
  get recommended() {
    return configFor("recommended");
  },
  get recommendedTypeChecked() {
    return configFor("recommended-type-checked");
  },
  get strict() {
    return configFor("strict");
  },
  get strictTypeChecked() {
    return configFor("strict-type-checked");
  },
  get stylistic() {
    return configFor("stylistic");
  },
  get stylisticTypeChecked() {
    return configFor("stylistic-type-checked");
  },
};

/** Flattens config arrays, so several can be spread into one export. */
export function config(...items) {
  return items.flat(Infinity);
}

export { parser, plugin };
export default { base, config, configs, parser, plugin };
