// Position and range helpers shared by the token, comment, and node converters.

/** ESTree uses 1-based lines and 0-based columns. */
export function getLocFor(start, end, sourceFile) {
  const startLoc = sourceFile.getLineAndCharacterOfPosition(start);
  const endLoc = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    start: { column: startLoc.character, line: startLoc.line + 1 },
    end: { column: endLoc.character, line: endLoc.line + 1 },
  };
}

/** The range ESLint sees: from the first non-trivia character to the node end. */
export function getRange(node, sourceFile) {
  return [node.getStart(sourceFile), node.getEnd()];
}
