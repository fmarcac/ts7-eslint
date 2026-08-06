// Dump what the checker answers where a rule and the TS 6 stack disagree.
//
//   node tools/bench-ts7/probe.mjs <tsconfig> <rootDir> <file>
//
// Prints, per `for await` statement, the walk ts-api-utils does to find a type's
// Symbol.asyncIterator property, which is where await-thenable decides.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertNotAlreadyLoaded, installResolutionHook } from "@ts7-eslint/resolution-hook";

assertNotAlreadyLoaded();
installResolutionHook();

const require = createRequire(import.meta.url);
const { Linter } = await import("eslint");
const parser = (await import("@ts7-eslint/parser")).default;
const fromPlugin = createRequire(require.resolve("@typescript-eslint/eslint-plugin"));
const tsutils = fromPlugin("ts-api-utils");
const ts = fromPlugin("typescript");

const [tsconfigPath, rootDir, file] = process.argv.slice(2);

const plugin = {
  rules: {
    probe: {
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {
          ForOfStatement(node) {
            if (!node.await) {
              return;
            }
            const type = services.getTypeAtLocation(node.right);
            console.log(`\nfor await at line ${node.loc.start.line}: ${checker.typeToString(type)}`);
            for (const part of tsutils.unionConstituents(type)) {
              for (const property of part.getProperties()) {
                if (!property.name.startsWith("__@asyncIterator")) {
                  continue;
                }
                const declaration = property.valueDeclaration ?? property.getDeclarations()?.[0];
                console.log(`  property name=${property.name} escapedName=${property.escapedName}`);
                console.log(
                  `  declaration kind=${declaration?.kind} computed=${declaration?.name && ts.isComputedPropertyName(declaration.name)}`,
                );
                if (!declaration?.name || !ts.isComputedPropertyName(declaration.name)) {
                  continue;
                }
                const globalSymbol = checker.getApparentType(
                  checker.getTypeAtLocation(declaration.name.expression),
                ).symbol;
                console.log(`  globalSymbol=${globalSymbol?.name} id=${globalSymbol?.id}`);
                const known = globalSymbol
                  ? checker
                      .getTypeOfSymbolAtLocation(globalSymbol, globalSymbol.valueDeclaration)
                      .getProperty("asyncIterator")
                  : undefined;
                console.log(`  knownSymbol=${known?.name} id=${known?.id}`);
                const knownType =
                  known && checker.getTypeOfSymbolAtLocation(known, known.valueDeclaration);
                console.log(
                  `  knownSymbolType=${knownType && checker.typeToString(knownType)}` +
                    ` flags=${knownType?.flags} unique=${knownType && tsutils.isUniqueESSymbolType(knownType)}` +
                    ` escapedName=${knownType?.escapedName}` +
                    ` symbol=${knownType?.symbol?.name} symbolId=${knownType?.symbol?.id}`,
                );
              }
            }
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
