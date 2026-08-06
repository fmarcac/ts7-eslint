// Shared benchmark plumbing. Duplicated verbatim in bench-ts7 rather than shared through
// a package, so neither runner can accidentally resolve the other's `typescript`.

/**
 * The rule set both stacks run.
 *
 * Taken from the plugin's own recommended-type-checked config rather than hand-picked,
 * so the mix of syntactic and type-aware rules is upstream's judgement and not one
 * chosen to flatter either side. Both runners load it from the same plugin version.
 */
export function ruleSet(plugin) {
  const candidates = [
    "recommended-type-checked",
    "flat/recommended-type-checked",
    "recommended-requiring-type-checking",
  ];
  for (const name of candidates) {
    const config = plugin.configs?.[name];
    const rules = Array.isArray(config) ? config.at(-1)?.rules : config?.rules;
    if (rules) {
      // Only this plugin's rules; the config also switches off core rules it replaces.
      return Object.fromEntries(
        Object.entries(rules).filter(([id, level]) => id.startsWith("@typescript-eslint/") && level !== "off"),
      );
    }
  }
  throw new Error("could not find a recommended-type-checked config on the plugin");
}

export function report(data) {
  process.stdout.write(`\n__BENCH__${JSON.stringify(data)}\n`);
}
