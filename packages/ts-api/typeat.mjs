// The type TypeScript 7 infers at a position, through this project's stack.
import { resolve } from "node:path";
import { clearProgramServices, getProgramService } from "@tseslint7/ts-api";
import { SyntaxKind } from "typescript/unstable/ast";
const [tsconfigPath, fileName, line, col] = process.argv.slice(2);
const service = getProgramService({ cwd: resolve("."), tsconfigPath: resolve(tsconfigPath) });
const sf = service.getSourceFile(resolve(fileName));
const checker = service.checker;
const pos = sf.getPositionOfLineAndCharacter(Number(line) - 1, Number(col) - 1);
let hit;
(function walk(n) {
  if (n.getStart(sf) <= pos && pos < n.getEnd()) { hit = n; n.forEachChild(walk); }
})(sf);
console.log(`TS7 node: ${SyntaxKind[hit.kind]} "${hit.getText(sf).slice(0, 40)}"`);
console.log(`TS7 type: ${checker.typeToString(checker.getTypeAtLocation(hit))}`);
clearProgramServices();
