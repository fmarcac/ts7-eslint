// The type TypeScript 6 infers at a position, for comparing against TypeScript 7.
import ts from "typescript";
const [tsconfigPath, fileName, line, col] = process.argv.slice(2);
const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {},
});
const program = ts.createProgram(config.fileNames, config.options);
const sf = program.getSourceFile(fileName);
const checker = program.getTypeChecker();
const pos = sf.getPositionOfLineAndCharacter(Number(line) - 1, Number(col) - 1);
function findAt(node) {
  let hit;
  (function walk(n) {
    if (n.getStart(sf) <= pos && pos < n.getEnd()) { hit = n; n.forEachChild(walk); }
  })(sf);
  return hit;
}
const node = findAt(sf);
console.log(`TS6 node: ${ts.SyntaxKind[node.kind]} "${node.getText(sf).slice(0, 40)}"`);
console.log(`TS6 type: ${checker.typeToString(checker.getTypeAtLocation(node))}`);
