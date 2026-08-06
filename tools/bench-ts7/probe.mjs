// Dump what the checker answers for one expression, the way a rule would see it.
//
//   node tools/bench-ts7/probe.mjs <tsconfig> <rootDir> <file>

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertNotAlreadyLoaded, installResolutionHook } from "@tseslint7/resolution-hook";

assertNotAlreadyLoaded();
installResolutionHook();

const require = createRequire(import.meta.url);
const { Linter } = await import("eslint");
const parser = (await import("@tseslint7/parser")).default;
const plugPath = require.resolve("@typescript-eslint/eslint-plugin");
const tsutils = createRequire(plugPath)("ts-api-utils");

const [tsconfigPath, rootDir, file] = process.argv.slice(2);

const describe = (checker, type, label) => {
  if (!type) {
    console.log(`${label}: undefined`);
    return;
  }
  console.log(
    `${label}: ${checker.typeToString(type)}` +
      ` flags=${type.flags} objectFlags=${type.objectFlags}` +
      ` isTypeReference=${tsutils.isTypeReference(type)}` +
      ` aliasTypeArguments=${type.aliasTypeArguments?.length ?? "undefined"}` +
      ` typeArguments=[${(checker.getTypeArguments(type) ?? []).map((t) => checker.typeToString(t)).join(", ")}]`,
  );
};

const plugin = {
  rules: {
    probe: {
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {
          VariableDeclarator(node) {
            if (!node.init) return;
            console.log(`\n${context.filename.split("/").pop()}:${node.loc.start.line}`);
            describe(checker, services.getTypeAtLocation(node.init), "  sender  ");
            describe(checker, services.getTypeAtLocation(node.id), "  receiver");
          },
        };
      },
    },
  },
};

new Linter().verify(readFileSync(file, "utf8"), [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser, parserOptions: { project: tsconfigPath, tsconfigRootDir: rootDir } },
    plugins: { probe: plugin },
    rules: { "probe/probe": "error" },
  },
], file);
