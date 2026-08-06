// TypeScript 7 AST to TSESTree.
//
// The shapes here are not invented: they are matched against what upstream
// typescript-estree emits on typescript@6.0.3, and differential.mjs holds them to it.
//
// Two TS 7 specifics shape this file:
//
//   - Class and type members carry a single `postfixToken` rather than separate
//     `questionToken` and `exclamationToken`, so `optional` and `definite` are both read
//     from it and discriminated by kind.
//   - `modifierFlags` is on the node itself, so modifiers are a bitmask test rather than
//     a scan of a modifiers array.

import { ModifierFlags, SyntaxKind } from "typescript/unstable/ast";
import { tokenToString } from "typescript/unstable/ast/scanner";
import { xhtmlEntities } from "./jsx-entities.mjs";
import { getLocFor } from "./node-utils.mjs";

/** Decode XHTML entities, as JSX text and attribute values require. */
function unescapeEntities(text) {
  return text.replaceAll(/&(?:#\d+|#x[\da-fA-F]+|[0-9a-zA-Z]+);/g, (entity) => {
    const item = entity.slice(1, -1);
    if (item[0] === "#") {
      const codePoint = item[1] === "x" ? parseInt(item.slice(2), 16) : parseInt(item.slice(1), 10);
      return codePoint > 0x10ffff ? entity : String.fromCodePoint(codePoint);
    }
    return xhtmlEntities[item] ?? entity;
  });
}

const ASSIGNMENT_OPERATORS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const LOGICAL_OPERATORS = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** SyntaxKind to the TSESTree type for keyword type nodes. */
const KEYWORD_TYPES = new Map([
  [SyntaxKind.AnyKeyword, "TSAnyKeyword"],
  [SyntaxKind.BigIntKeyword, "TSBigIntKeyword"],
  [SyntaxKind.BooleanKeyword, "TSBooleanKeyword"],
  [SyntaxKind.NeverKeyword, "TSNeverKeyword"],
  [SyntaxKind.NumberKeyword, "TSNumberKeyword"],
  [SyntaxKind.ObjectKeyword, "TSObjectKeyword"],
  [SyntaxKind.StringKeyword, "TSStringKeyword"],
  [SyntaxKind.SymbolKeyword, "TSSymbolKeyword"],
  [SyntaxKind.UndefinedKeyword, "TSUndefinedKeyword"],
  [SyntaxKind.UnknownKeyword, "TSUnknownKeyword"],
  [SyntaxKind.VoidKeyword, "TSVoidKeyword"],
]);

export class Converter {
  constructor(sourceFile) {
    this.ast = sourceFile;
    this.esTreeNodeToTSNodeMap = new Map();
    this.tsNodeToESTreeNodeMap = new Map();
    /** SyntaxKind name to count, for the kinds this converter does not handle yet. */
    this.unsupported = new Map();
  }

  convertProgram() {
    return this.#node(
      this.ast,
      {
        type: "Program",
        body: this.#convertStatements(this.ast.statements),
        sourceType: this.ast.externalModuleIndicator ? "module" : "script",
      },
      // The Program starts at the first real token, not at position 0: leading comments
      // and a shebang sit outside it.
      [this.ast.getStart(this.ast), this.ast.endOfFileToken.end],
    );
  }

  // ---- infrastructure -----------------------------------------------------

  #node(tsNode, data, explicitRange) {
    const range = explicitRange ?? [tsNode.getStart(this.ast), tsNode.getEnd()];
    const result = { ...data, range, loc: getLocFor(range[0], range[1], this.ast) };
    this.esTreeNodeToTSNodeMap.set(result, tsNode);
    if (!this.tsNodeToESTreeNodeMap.has(tsNode)) {
      this.tsNodeToESTreeNodeMap.set(tsNode, result);
    }
    return result;
  }

  /**
   * Statements at module or namespace level.
   *
   * TypeScript treats `export` as a modifier on the declaration. ESTree makes it
   * structural, wrapping the declaration in an Export*Declaration whose child starts
   * after the keyword, so the wrapping happens here rather than in the per-kind cases.
   */
  #convertStatements(nodes) {
    const out = [];
    for (const node of nodes ?? []) {
      const converted = this.#exportWrapped(node);
      if (converted) {
        out.push(converted);
      }
    }
    return out;
  }

  #exportWrapped(node) {
    // `export ... from` and `export =` are already export nodes, not modified declarations.
    if (
      node.kind === SyntaxKind.ExportDeclaration ||
      node.kind === SyntaxKind.ExportAssignment ||
      node.kind === SyntaxKind.ImportDeclaration
    ) {
      return this.convert(node);
    }

    if (!this.#has(node, ModifierFlags.Export)) {
      return this.convert(node);
    }

    const isDefault = this.#has(node, ModifierFlags.Default);
    const outerStart = node.getStart(this.ast);
    const declaration = this.convert(node);
    if (!declaration) {
      return null;
    }

    // The wrapped declaration begins after the export/default keywords.
    const keywords = (node.modifiers ?? []).filter(
      (m) => m.kind === SyntaxKind.ExportKeyword || m.kind === SyntaxKind.DefaultKeyword,
    );
    if (keywords.length > 0) {
      let inner = Math.max(...keywords.map((m) => m.end));
      while (inner < this.ast.text.length && /\s/.test(this.ast.text[inner])) {
        inner++;
      }
      declaration.range = [inner, declaration.range[1]];
      declaration.loc = getLocFor(inner, declaration.range[1], this.ast);
    }

    const range = [outerStart, node.getEnd()];
    const wrapper = isDefault
      ? { type: "ExportDefaultDeclaration", declaration, exportKind: "value" }
      : {
          type: "ExportNamedDeclaration",
          attributes: [],
          declaration,
          exportKind: "value",
          source: null,
          specifiers: [],
        };

    return this.#node(node, wrapper, range);
  }

  #convertAll(nodes) {
    const out = [];
    for (const node of nodes ?? []) {
      const converted = this.convert(node);
      if (converted) {
        out.push(converted);
      }
    }
    return out;
  }

  /** Null-safe child conversion; ESTree uses null for absent array elements. */
  #child(node) {
    return node == null ? null : this.convert(node);
  }

  /** Like #child, but absent means the key is omitted rather than set to null. */
  #optional(node) {
    return node == null ? undefined : this.convert(node);
  }

  /**
   * Reinterpret an expression as an assignment target.
   *
   * TypeScript parses the left of `({ a } = b)` and `[x, y] = z` as object and array
   * literals, because it cannot know which it is until it sees the `=`. ESTree requires
   * patterns there. Rewriting after the fact handles arbitrary nesting without threading
   * a context flag through every conversion.
   */
  #toPattern(node) {
    if (node == null || typeof node !== "object") {
      return node;
    }
    return this.#rebuilt(node, this.#toPatternInner(node));
  }

  /** Carry a rebuilt node the original node mapping. */
  #rebuilt(original, replacement) {
    if (replacement !== original) {
      const tsNode = this.esTreeNodeToTSNodeMap.get(original);
      if (tsNode) {
        this.esTreeNodeToTSNodeMap.set(replacement, tsNode);
      }
    }
    return replacement;
  }

  #toPatternInner(node) {
    switch (node.type) {
      case "ObjectExpression":
        return {
          ...node,
          type: "ObjectPattern",
          decorators: [],
          optional: false,
          properties: node.properties.map((p) => this.#toPattern(p)),
        };
      case "ArrayExpression":
        return {
          ...node,
          type: "ArrayPattern",
          decorators: [],
          elements: node.elements.map((e) => this.#toPattern(e)),
          optional: false,
        };
      case "Property":
        return { ...node, value: this.#toPattern(node.value) };
      case "SpreadElement":
        return {
          ...node,
          type: "RestElement",
          argument: this.#toPattern(node.argument),
          decorators: [],
          optional: false,
        };
      case "AssignmentExpression": {
        // An AssignmentPattern has no operator, so build it rather than spreading.
        const { left, loc, range, right } = node;
        return {
          type: "AssignmentPattern",
          decorators: [],
          left: this.#toPattern(left),
          loc,
          optional: false,
          range,
          right,
        };
      }
      default:
        return node;
    }
  }

  /** An element of an object or array binding pattern. */
  #bindingElement(node) {
    if (node.dotDotDotToken) {
      return this.#node(node, {
        type: "RestElement",
        argument: this.convert(node.name),
        decorators: [],
        optional: false,
      });
    }

    const target = node.initializer
      ? this.#node(node, {
          type: "AssignmentPattern",
          decorators: [],
          left: this.convert(node.name),
          optional: false,
          right: this.convert(node.initializer),
        })
      : this.convert(node.name);

    if (node.parent.kind !== SyntaxKind.ObjectBindingPattern) {
      return target;
    }

    return this.#node(node, {
      type: "Property",
      computed: node.propertyName?.kind === SyntaxKind.ComputedPropertyName,
      key: node.propertyName ? this.#propertyName(node.propertyName) : this.convert(node.name),
      kind: "init",
      method: false,
      optional: false,
      shorthand: node.propertyName == null,
      value: target,
    });
  }

  #enumBody(node) {
    const open = this.ast.text.indexOf("{", node.name.getEnd());
    const range = [open === -1 ? node.getStart(this.ast) : open, node.getEnd()];
    return this.#node(node, { type: "TSEnumBody", members: this.#convertAll(node.members) }, range);
  }

  #isGlobalAugmentation(node) {
    // TypeScript 6 marked this with NodeFlags.GlobalAugmentation. TypeScript 7 removed
    // that flag, so the old bitmask test read as undefined and silently never fired.
    // Recognise the form by shape instead: a module declaration named "global".
    return node.name.kind === SyntaxKind.Identifier && node.name.text === "global";
  }

  #moduleKind(node) {
    if (this.#isGlobalAugmentation(node)) {
      return "global";
    }
    if (node.name.kind === SyntaxKind.StringLiteral) {
      return "module";
    }
    return "namespace";
  }

  #has(node, flag) {
    return (node.modifierFlags & flag) !== 0;
  }

  #text(node) {
    return this.ast.text.slice(node.getStart(this.ast), node.getEnd());
  }

  /** A type annotation wraps its type node and starts at the colon. */
  #typeAnnotation(typeNode) {
    if (!typeNode) {
      return undefined;
    }
    const converted = this.convert(typeNode);

    // The annotation begins at the marker introducing it, which is `:` for a parameter,
    // property or variable, and `=>` for a function type's return. Scan back over
    // whitespace from the type rather than searching forward, so a `:` or `=>` occurring
    // earlier in the line cannot be picked up by mistake.
    const typeStart = typeNode.getStart(this.ast);
    const text = this.ast.text;
    let cursor = typeStart - 1;
    while (cursor >= 0 && /\s/.test(text[cursor])) {
      cursor--;
    }
    let start = typeStart;
    if (text[cursor] === ">" && text[cursor - 1] === "=") {
      start = cursor - 1;
    } else if (text[cursor] === ":") {
      start = cursor;
    }

    const range = [start, typeNode.getEnd()];
    return this.#node(typeNode, { type: "TSTypeAnnotation", typeAnnotation: converted }, range);
  }

  #postfix(node, kind) {
    return node.postfixToken?.kind === kind;
  }

  #unsupported(node) {
    const name = SyntaxKind[node.kind] ?? String(node.kind);
    this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1);
    return this.#node(node, { type: `Unsupported:${name}` });
  }

  // ---- dispatch -----------------------------------------------------------

  convert(node) {
    if (node == null) {
      return null;
    }

    switch (node.kind) {
      // ---- literals and names ----
      case SyntaxKind.Identifier:
        return this.#node(node, {
          type: "Identifier",
          decorators: [],
          name: node.text,
          optional: false,
        });

      case SyntaxKind.PrivateIdentifier:
        return this.#node(node, { type: "PrivateIdentifier", name: node.text.slice(1) });

      case SyntaxKind.ThisKeyword:
        return this.#node(node, { type: "ThisExpression" });

      case SyntaxKind.SuperKeyword:
        return this.#node(node, { type: "Super" });

      case SyntaxKind.NullKeyword:
        return this.#node(node, { type: "Literal", raw: "null", value: null });

      case SyntaxKind.TrueKeyword:
        return this.#node(node, { type: "Literal", raw: "true", value: true });

      case SyntaxKind.FalseKeyword:
        return this.#node(node, { type: "Literal", raw: "false", value: false });

      case SyntaxKind.StringLiteral:
        return this.#node(node, { type: "Literal", raw: this.#text(node), value: node.text });

      case SyntaxKind.NumericLiteral:
        return this.#node(node, {
          type: "Literal",
          raw: this.#text(node),
          value: Number(node.text),
        });

      case SyntaxKind.BigIntLiteral: {
        const raw = this.#text(node);
        const digits = raw.slice(0, -1).replaceAll("_", "");
        return this.#node(node, {
          type: "Literal",
          bigint: digits,
          raw,
          value: BigInt(digits),
        });
      }

      case SyntaxKind.RegularExpressionLiteral: {
        const raw = this.#text(node);
        const slash = raw.lastIndexOf("/");
        const pattern = raw.slice(1, slash);
        const flags = raw.slice(slash + 1);
        let value = null;
        try {
          value = new RegExp(pattern, flags);
        } catch {
          value = null;
        }
        return this.#node(node, {
          type: "Literal",
          raw,
          regex: { flags, pattern },
          value,
        });
      }

      // ---- statements ----
      case SyntaxKind.Block:
        return this.#node(node, {
          type: "BlockStatement",
          body: this.#convertAll(node.statements),
        });

      case SyntaxKind.EmptyStatement:
        return this.#node(node, { type: "EmptyStatement" });

      case SyntaxKind.DebuggerStatement:
        return this.#node(node, { type: "DebuggerStatement" });

      case SyntaxKind.ExpressionStatement:
        return this.#node(node, {
          type: "ExpressionStatement",
          directive: undefined,
          expression: this.convert(node.expression),
        });

      case SyntaxKind.ReturnStatement:
        return this.#node(node, {
          type: "ReturnStatement",
          argument: this.#child(node.expression),
        });

      case SyntaxKind.ThrowStatement:
        return this.#node(node, {
          type: "ThrowStatement",
          argument: this.convert(node.expression),
        });

      case SyntaxKind.IfStatement:
        return this.#node(node, {
          type: "IfStatement",
          alternate: this.#child(node.elseStatement),
          consequent: this.convert(node.thenStatement),
          test: this.convert(node.expression),
        });

      case SyntaxKind.WhileStatement:
        return this.#node(node, {
          type: "WhileStatement",
          body: this.convert(node.statement),
          test: this.convert(node.expression),
        });

      case SyntaxKind.DoStatement:
        return this.#node(node, {
          type: "DoWhileStatement",
          body: this.convert(node.statement),
          test: this.convert(node.expression),
        });

      case SyntaxKind.ForStatement:
        return this.#node(node, {
          type: "ForStatement",
          body: this.convert(node.statement),
          init: this.#child(node.initializer),
          test: this.#child(node.condition),
          update: this.#child(node.incrementor),
        });

      case SyntaxKind.ForInStatement:
        return this.#node(node, {
          type: "ForInStatement",
          body: this.convert(node.statement),
          left: this.#toPattern(this.convert(node.initializer)),
          right: this.convert(node.expression),
        });

      case SyntaxKind.ForOfStatement:
        return this.#node(node, {
          type: "ForOfStatement",
          await: node.awaitModifier != null,
          body: this.convert(node.statement),
          left: this.#toPattern(this.convert(node.initializer)),
          right: this.convert(node.expression),
        });

      case SyntaxKind.BreakStatement:
        return this.#node(node, { type: "BreakStatement", label: this.#child(node.label) });

      case SyntaxKind.ContinueStatement:
        return this.#node(node, { type: "ContinueStatement", label: this.#child(node.label) });

      case SyntaxKind.LabeledStatement:
        return this.#node(node, {
          type: "LabeledStatement",
          body: this.convert(node.statement),
          label: this.convert(node.label),
        });

      case SyntaxKind.TryStatement:
        return this.#node(node, {
          type: "TryStatement",
          block: this.convert(node.tryBlock),
          finalizer: this.#child(node.finallyBlock),
          handler: this.#child(node.catchClause),
        });

      case SyntaxKind.CatchClause:
        return this.#node(node, {
          type: "CatchClause",
          body: this.convert(node.block),
          // `catch (e: unknown)` carries a type annotation on the parameter.
          param: node.variableDeclaration
            ? this.#bindingWithType(node.variableDeclaration)
            : null,
        });

      case SyntaxKind.SwitchStatement:
        return this.#node(node, {
          type: "SwitchStatement",
          cases: this.#convertAll(node.caseBlock.clauses),
          discriminant: this.convert(node.expression),
        });

      case SyntaxKind.CaseClause:
        return this.#node(node, {
          type: "SwitchCase",
          consequent: this.#convertAll(node.statements),
          test: this.convert(node.expression),
        });

      case SyntaxKind.DefaultClause:
        return this.#node(node, {
          type: "SwitchCase",
          consequent: this.#convertAll(node.statements),
          test: null,
        });

      // ---- declarations ----
      case SyntaxKind.VariableStatement:
        return this.#node(node, {
          type: "VariableDeclaration",
          declarations: this.#convertAll(node.declarationList.declarations),
          declare: this.#has(node, ModifierFlags.Ambient),
          kind: this.#variableKind(node.declarationList),
        });

      case SyntaxKind.VariableDeclarationList:
        return this.#node(node, {
          type: "VariableDeclaration",
          declarations: this.#convertAll(node.declarations),
          declare: false,
          kind: this.#variableKind(node),
        });

      case SyntaxKind.VariableDeclaration:
        return this.#node(node, {
          type: "VariableDeclarator",
          definite: node.exclamationToken != null,
          id: this.#bindingWithType(node),
          init: this.#child(node.initializer),
        });

      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression: {
        const isDeclaration = node.kind === SyntaxKind.FunctionDeclaration;
        return this.#node(node, {
          type: isDeclaration
            ? node.body
              ? "FunctionDeclaration"
              : "TSDeclareFunction"
            : "FunctionExpression",
          async: this.#has(node, ModifierFlags.Async),
          body: this.#optional(node.body),
          declare: isDeclaration ? this.#has(node, ModifierFlags.Ambient) : false,
          expression: false,
          generator: node.asteriskToken != null,
          id: this.#child(node.name),
          params: this.#convertAll(node.parameters),
          returnType: this.#typeAnnotation(node.type),
          typeParameters: this.#typeParameters(node),
        });
      }

      case SyntaxKind.ArrowFunction:
        return this.#node(node, {
          type: "ArrowFunctionExpression",
          async: this.#has(node, ModifierFlags.Async),
          body: this.convert(node.body),
          expression: node.body.kind !== SyntaxKind.Block,
          generator: false,
          id: null,
          params: this.#convertAll(node.parameters),
          returnType: this.#typeAnnotation(node.type),
          typeParameters: this.#typeParameters(node),
        });

      case SyntaxKind.Parameter:
        return this.#wrapParameterProperty(node, this.#parameter(node));

      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return this.#node(node, {
          type: node.kind === SyntaxKind.ClassDeclaration ? "ClassDeclaration" : "ClassExpression",
          abstract: this.#has(node, ModifierFlags.Abstract),
          body: this.#classBody(node),
          declare: this.#has(node, ModifierFlags.Ambient),
          decorators: this.#decorators(node),
          id: this.#child(node.name),
          implements: this.#heritage(node, SyntaxKind.ImplementsKeyword),
          superClass: this.#superClass(node),
          typeParameters: this.#typeParameters(node),
        });

      case SyntaxKind.PropertyDeclaration:
        return this.#node(node, {
          // ESTree encodes `abstract` and `accessor` in the node type rather than as
          // flags on a single PropertyDefinition.
          type: this.#has(node, ModifierFlags.Abstract)
            ? "TSAbstractPropertyDefinition"
            : this.#isAccessor(node)
              ? "AccessorProperty"
              : "PropertyDefinition",
          accessibility: this.#accessibility(node),
          computed: node.name.kind === SyntaxKind.ComputedPropertyName,
          declare: this.#has(node, ModifierFlags.Ambient),
          decorators: this.#decorators(node),
          definite: this.#postfix(node, SyntaxKind.ExclamationToken),
          key: this.#propertyName(node.name),
          optional: this.#postfix(node, SyntaxKind.QuestionToken),
          override: this.#has(node, ModifierFlags.Override),
          readonly: this.#has(node, ModifierFlags.Readonly),
          static: this.#has(node, ModifierFlags.Static),
          typeAnnotation: this.#typeAnnotation(node.type),
          value: this.#child(node.initializer),
        });

      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        return this.#methodDefinition(node);

      case SyntaxKind.SemicolonClassElement:
        return null;

      // ---- expressions ----
      case SyntaxKind.ParenthesizedExpression:
        return this.convert(node.expression);

      case SyntaxKind.BinaryExpression:
        return this.#binary(node);

      case SyntaxKind.PrefixUnaryExpression: {
        const operator = tokenToString(node.operator);
        const isUpdate = operator === "++" || operator === "--";
        return this.#node(node, {
          type: isUpdate ? "UpdateExpression" : "UnaryExpression",
          argument: this.convert(node.operand),
          operator,
          prefix: true,
        });
      }

      case SyntaxKind.PostfixUnaryExpression:
        return this.#node(node, {
          type: "UpdateExpression",
          argument: this.convert(node.operand),
          operator: tokenToString(node.operator),
          prefix: false,
        });

      case SyntaxKind.TypeOfExpression:
        return this.#node(node, {
          type: "UnaryExpression",
          argument: this.convert(node.expression),
          operator: "typeof",
          prefix: true,
        });

      case SyntaxKind.VoidExpression:
        return this.#node(node, {
          type: "UnaryExpression",
          argument: this.convert(node.expression),
          operator: "void",
          prefix: true,
        });

      case SyntaxKind.DeleteExpression:
        return this.#node(node, {
          type: "UnaryExpression",
          argument: this.convert(node.expression),
          operator: "delete",
          prefix: true,
        });

      case SyntaxKind.AwaitExpression:
        return this.#node(node, {
          type: "AwaitExpression",
          argument: this.convert(node.expression),
        });

      case SyntaxKind.ConditionalExpression:
        return this.#node(node, {
          type: "ConditionalExpression",
          alternate: this.convert(node.whenFalse),
          consequent: this.convert(node.whenTrue),
          test: this.convert(node.condition),
        });

      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        return this.#maybeChain(node);

      case SyntaxKind.NonNullExpression:
        return this.#node(node, {
          type: "TSNonNullExpression",
          expression: this.convert(node.expression),
        });

      case SyntaxKind.AsExpression:
        return this.#node(node, {
          type: "TSAsExpression",
          expression: this.convert(node.expression),
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.SatisfiesExpression:
        return this.#node(node, {
          type: "TSSatisfiesExpression",
          expression: this.convert(node.expression),
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.ObjectLiteralExpression:
        return this.#node(node, {
          type: "ObjectExpression",
          properties: this.#convertAll(node.properties),
        });

      case SyntaxKind.ArrayLiteralExpression:
        return this.#node(node, {
          type: "ArrayExpression",
          elements: (node.elements ?? []).map((el) =>
            el.kind === SyntaxKind.OmittedExpression ? null : this.convert(el),
          ),
        });

      case SyntaxKind.PropertyAssignment:
        return this.#node(node, {
          type: "Property",
          computed: node.name.kind === SyntaxKind.ComputedPropertyName,
          key: this.#propertyName(node.name),
          kind: "init",
          method: false,
          optional: false,
          shorthand: false,
          value: this.convert(node.initializer),
        });

      case SyntaxKind.ShorthandPropertyAssignment:
        return this.#node(node, {
          type: "Property",
          computed: false,
          key: this.convert(node.name),
          kind: "init",
          method: false,
          optional: false,
          shorthand: true,
          value: node.objectAssignmentInitializer
            ? this.#node(node, {
                type: "AssignmentPattern",
                decorators: [],
                left: this.convert(node.name),
                optional: false,
                right: this.convert(node.objectAssignmentInitializer),
              })
            : this.convert(node.name),
        });

      case SyntaxKind.SpreadAssignment:
      case SyntaxKind.SpreadElement:
        return this.#node(node, {
          type: "SpreadElement",
          argument: this.convert(node.expression),
        });

      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return this.#node(node, {
          type: "TemplateLiteral",
          expressions: [],
          quasis: [this.#templateElement(node, true)],
        });

      case SyntaxKind.TemplateExpression:
        return this.#templateExpression(node);

      case SyntaxKind.TaggedTemplateExpression:
        return this.#node(node, {
          type: "TaggedTemplateExpression",
          quasi: this.convert(node.template),
          tag: this.convert(node.tag),
          typeArguments: this.#typeArguments(node),
        });

      // ---- types ----
      case SyntaxKind.TypeReference:
        return this.#node(node, {
          type: "TSTypeReference",
          typeArguments: this.#typeArguments(node),
          typeName: this.convert(node.typeName),
        });

      case SyntaxKind.QualifiedName:
        return this.#node(node, {
          type: "TSQualifiedName",
          left: this.convert(node.left),
          right: this.convert(node.right),
        });

      case SyntaxKind.TypeParameter:
        return this.#node(node, {
          type: "TSTypeParameter",
          const: this.#has(node, ModifierFlags.Const),
          constraint: node.constraint ? this.convert(node.constraint) : undefined,
          default: node.default ? this.convert(node.default) : undefined,
          in: this.#has(node, ModifierFlags.In),
          name: this.convert(node.name),
          out: this.#has(node, ModifierFlags.Out),
        });

      case SyntaxKind.FunctionType:
        return this.#node(node, {
          type: "TSFunctionType",
          params: this.#convertAll(node.parameters),
          returnType: this.#typeAnnotation(node.type),
          typeParameters: this.#typeParameters(node),
        });

      case SyntaxKind.ConstructorType:
        return this.#node(node, {
          type: "TSConstructorType",
          abstract: this.#has(node, ModifierFlags.Abstract),
          params: this.#convertAll(node.parameters),
          returnType: this.#typeAnnotation(node.type),
          typeParameters: this.#typeParameters(node),
        });

      case SyntaxKind.ConditionalType:
        return this.#node(node, {
          type: "TSConditionalType",
          checkType: this.convert(node.checkType),
          extendsType: this.convert(node.extendsType),
          falseType: this.convert(node.falseType),
          trueType: this.convert(node.trueType),
        });

      case SyntaxKind.InferType:
        return this.#node(node, {
          type: "TSInferType",
          typeParameter: this.convert(node.typeParameter),
        });

      case SyntaxKind.TypeOperator:
        return this.#node(node, {
          type: "TSTypeOperator",
          operator: tokenToString(node.operator),
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.IndexedAccessType:
        return this.#node(node, {
          type: "TSIndexedAccessType",
          indexType: this.convert(node.indexType),
          objectType: this.convert(node.objectType),
        });

      case SyntaxKind.MappedType:
        return this.#node(node, {
          type: "TSMappedType",
          constraint: this.convert(node.typeParameter.constraint),
          key: this.convert(node.typeParameter.name),
          nameType: this.#child(node.nameType),
          optional: this.#mappedModifier(node.questionToken),
          readonly: this.#mappedModifier(node.readonlyToken),
          typeAnnotation: this.#child(node.type),
        });

      case SyntaxKind.TemplateLiteralType: {
        const quasis = [this.#templateElement(node.head, false)];
        const types = [];
        for (const span of node.templateSpans) {
          types.push(this.convert(span.type));
          quasis.push(
            this.#templateElement(span.literal, span.literal.kind === SyntaxKind.TemplateTail),
          );
        }
        return this.#node(node, { type: "TSTemplateLiteralType", quasis, types });
      }

      // ---- JSX ----
      case SyntaxKind.JsxElement:
        return this.#node(node, {
          type: "JSXElement",
          children: this.#convertAll(node.children),
          closingElement: this.convert(node.closingElement),
          openingElement: this.convert(node.openingElement),
        });

      case SyntaxKind.JsxSelfClosingElement:
        return this.#node(node, {
          type: "JSXElement",
          children: [],
          closingElement: null,
          openingElement: this.#node(node, {
            type: "JSXOpeningElement",
            attributes: this.#convertAll(node.attributes.properties),
            name: this.#jsxName(node.tagName),
            selfClosing: true,
            typeArguments: this.#typeArguments(node),
          }),
        });

      case SyntaxKind.JsxOpeningElement:
        return this.#node(node, {
          type: "JSXOpeningElement",
          attributes: this.#convertAll(node.attributes.properties),
          name: this.#jsxName(node.tagName),
          selfClosing: false,
          typeArguments: this.#typeArguments(node),
        });

      case SyntaxKind.JsxClosingElement:
        return this.#node(node, { type: "JSXClosingElement", name: this.#jsxName(node.tagName) });

      case SyntaxKind.JsxFragment:
        return this.#node(node, {
          type: "JSXFragment",
          children: this.#convertAll(node.children),
          closingFragment: this.convert(node.closingFragment),
          openingFragment: this.convert(node.openingFragment),
        });

      case SyntaxKind.JsxOpeningFragment:
        return this.#node(node, { type: "JSXOpeningFragment" });

      case SyntaxKind.JsxClosingFragment:
        return this.#node(node, { type: "JSXClosingFragment" });

      case SyntaxKind.JsxText:
        return this.#node(
          node,
          {
            type: "JSXText",
            raw: this.ast.text.slice(node.getFullStart(), node.getEnd()),
            value: unescapeEntities(node.text),
          },
          [node.getFullStart(), node.getEnd()],
        );

      case SyntaxKind.JsxExpression:
        return this.#node(node, {
          type: "JSXExpressionContainer",
          expression: node.expression
            ? this.convert(node.expression)
            : this.#jsxEmptyExpression(node),
        });

      case SyntaxKind.JsxAttribute:
        return this.#node(node, {
          type: "JSXAttribute",
          name: this.#jsxName(node.name),
          value: this.#child(node.initializer),
        });

      case SyntaxKind.JsxSpreadAttribute:
        return this.#node(node, {
          type: "JSXSpreadAttribute",
          argument: this.convert(node.expression),
        });

      case SyntaxKind.UnionType:
        return this.#node(node, { type: "TSUnionType", types: this.#convertAll(node.types) });

      case SyntaxKind.IntersectionType:
        return this.#node(node, {
          type: "TSIntersectionType",
          types: this.#convertAll(node.types),
        });

      case SyntaxKind.ArrayType:
        return this.#node(node, {
          type: "TSArrayType",
          elementType: this.convert(node.elementType),
        });

      case SyntaxKind.ParenthesizedType:
        return this.convert(node.type);

      case SyntaxKind.LiteralType:
        if (node.literal.kind === SyntaxKind.NullKeyword) {
          return this.#node(node, { type: "TSNullKeyword" });
        }
        return this.#node(node, {
          type: "TSLiteralType",
          literal: this.convert(node.literal),
        });

      case SyntaxKind.TypeLiteral:
        return this.#node(node, {
          type: "TSTypeLiteral",
          members: this.#convertAll(node.members),
        });

      case SyntaxKind.PropertySignature:
        return this.#node(node, {
          type: "TSPropertySignature",
          computed: node.name.kind === SyntaxKind.ComputedPropertyName,
          key: this.#propertyName(node.name),
          optional: this.#postfix(node, SyntaxKind.QuestionToken),
          readonly: this.#has(node, ModifierFlags.Readonly),
          static: this.#has(node, ModifierFlags.Static),
          typeAnnotation: this.#typeAnnotation(node.type),
        });

      case SyntaxKind.MethodSignature:
        return this.#node(node, {
          type: "TSMethodSignature",
          computed: node.name.kind === SyntaxKind.ComputedPropertyName,
          key: this.#propertyName(node.name),
          kind: "method",
          optional: this.#postfix(node, SyntaxKind.QuestionToken),
          params: this.#convertAll(node.parameters),
          readonly: this.#has(node, ModifierFlags.Readonly),
          returnType: this.#typeAnnotation(node.type),
          static: this.#has(node, ModifierFlags.Static),
        });

      case SyntaxKind.TypeAliasDeclaration:
        return this.#node(node, {
          type: "TSTypeAliasDeclaration",
          declare: this.#has(node, ModifierFlags.Ambient),
          id: this.convert(node.name),
          typeParameters: this.#typeParameters(node),
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.InterfaceDeclaration:
        return this.#node(node, {
          type: "TSInterfaceDeclaration",
          body: this.#interfaceBody(node),
          declare: this.#has(node, ModifierFlags.Ambient),
          extends: this.#heritage(node, SyntaxKind.ExtendsKeyword),
          id: this.convert(node.name),
          typeParameters: this.#typeParameters(node),
        });

      // ---- modules ----
      case SyntaxKind.ImportDeclaration:
        return this.#importDeclaration(node);

      case SyntaxKind.ExportDeclaration:
        return this.#exportDeclaration(node);

      case SyntaxKind.ExportAssignment:
        return this.#node(node, {
          type: node.isExportEquals ? "TSExportAssignment" : "ExportDefaultDeclaration",
          declaration: this.convert(node.expression),
          exportKind: "value",
        });

      // ---- binding patterns ----
      case SyntaxKind.ObjectBindingPattern:
        return this.#node(node, {
          type: "ObjectPattern",
          decorators: [],
          optional: false,
          properties: this.#convertAll(node.elements),
        });

      case SyntaxKind.ArrayBindingPattern:
        return this.#node(node, {
          type: "ArrayPattern",
          decorators: [],
          elements: node.elements.map((el) =>
            el.kind === SyntaxKind.OmittedExpression ? null : this.convert(el),
          ),
          optional: false,
        });

      case SyntaxKind.BindingElement:
        return this.#bindingElement(node);

      // ---- enums and namespaces ----
      case SyntaxKind.EnumDeclaration:
        return this.#node(node, {
          type: "TSEnumDeclaration",
          body: this.#enumBody(node),
          const: this.#has(node, ModifierFlags.Const),
          declare: this.#has(node, ModifierFlags.Ambient),
          id: this.convert(node.name),
        });

      case SyntaxKind.EnumMember:
        return this.#node(node, {
          type: "TSEnumMember",
          computed: node.name.kind === SyntaxKind.ComputedPropertyName || undefined,
          id: this.#propertyName(node.name),
          initializer: this.#optional(node.initializer),
        });

      case SyntaxKind.ModuleDeclaration: {
        // TypeScript nests a ModuleDeclaration per dotted segment. ESTree flattens the
        // chain into one declaration whose id is a TSQualifiedName.
        let innermost = node;
        const names = [node.name];
        while (innermost.body?.kind === SyntaxKind.ModuleDeclaration) {
          innermost = innermost.body;
          names.push(innermost.name);
        }
        let id = this.convert(names[0]);
        for (const segment of names.slice(1)) {
          const right = this.convert(segment);
          const range = [id.range[0], right.range[1]];
          id = this.#node(segment, { type: "TSQualifiedName", left: id, right }, range);
        }
        return this.#node(node, {
          type: "TSModuleDeclaration",
          body: this.#optional(innermost.body),
          declare: this.#has(node, ModifierFlags.Ambient),
          global: this.#isGlobalAugmentation(node),
          id,
          kind: this.#moduleKind(node),
        });
      }

      case SyntaxKind.ModuleBlock:
        return this.#node(node, {
          type: "TSModuleBlock",
          body: this.#convertStatements(node.statements),
        });

      case SyntaxKind.ClassStaticBlockDeclaration:
        return this.#node(node, {
          type: "StaticBlock",
          body: this.#convertAll(node.body.statements),
        });

      // ---- remaining type nodes ----
      case SyntaxKind.IndexSignature:
        return this.#node(node, {
          type: "TSIndexSignature",
          parameters: this.#convertAll(node.parameters),
          readonly: this.#has(node, ModifierFlags.Readonly),
          static: this.#has(node, ModifierFlags.Static),
          typeAnnotation: this.#typeAnnotation(node.type),
        });

      case SyntaxKind.TypePredicate:
        return this.#node(node, {
          type: "TSTypePredicate",
          asserts: node.assertsModifier != null,
          parameterName: this.convert(node.parameterName),
          typeAnnotation: this.#typeAnnotation(node.type),
        });

      case SyntaxKind.TupleType:
        return this.#node(node, {
          type: "TSTupleType",
          elementTypes: this.#convertAll(node.elements),
        });

      case SyntaxKind.NamedTupleMember: {
        const outerRange = [node.getStart(this.ast), node.getEnd()];
        const innerStart = node.dotDotDotToken ? node.name.getStart(this.ast) : outerRange[0];
        const member = this.#node(
          node,
          {
            type: "TSNamedTupleMember",
            elementType: this.convert(node.type),
            label: this.convert(node.name),
            optional: node.questionToken != null,
          },
          [innerStart, outerRange[1]],
        );
        if (!node.dotDotDotToken) {
          return member;
        }
        return this.#node(node, { type: "TSRestType", typeAnnotation: member }, outerRange);
      }

      case SyntaxKind.RestType:
        return this.#node(node, {
          type: "TSRestType",
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.OptionalType:
        return this.#node(node, {
          type: "TSOptionalType",
          typeAnnotation: this.convert(node.type),
        });

      case SyntaxKind.TypeQuery:
        return this.#node(node, {
          type: "TSTypeQuery",
          exprName: this.convert(node.exprName),
          typeArguments: this.#typeArguments(node),
        });

      // ---- remaining expressions ----
      case SyntaxKind.YieldExpression:
        return this.#node(node, {
          type: "YieldExpression",
          argument: this.#optional(node.expression),
          delegate: node.asteriskToken != null,
        });

      case SyntaxKind.MetaProperty:
        return this.#node(node, {
          type: "MetaProperty",
          meta: this.#node(node, { type: "Identifier", decorators: [], name: tokenToString(node.keywordToken), optional: false }, [
            node.getStart(this.ast),
            node.getStart(this.ast) + tokenToString(node.keywordToken).length,
          ]),
          property: this.convert(node.name),
        });

      case SyntaxKind.OmittedExpression:
        return null;

      default:
        if (KEYWORD_TYPES.has(node.kind)) {
          return this.#node(node, { type: KEYWORD_TYPES.get(node.kind) });
        }
        return this.#unsupported(node);
    }
  }

  // ---- helpers ------------------------------------------------------------

  #variableKind(list) {
    const flags = list.flags & 7; // NodeFlags Let = 1, Const = 2, Using = 4
    if (flags & 2) {
      return "const";
    }
    if (flags & 1) {
      return "let";
    }
    return "var";
  }

  /** An identifier or binding pattern, carrying its type annotation. */
  #bindingWithType(declaration) {
    const id = this.convert(declaration.name);
    if (declaration.type && id) {
      id.typeAnnotation = this.#typeAnnotation(declaration.type);
      id.range = [id.range[0], declaration.type.getEnd()];
      id.loc = getLocFor(id.range[0], id.range[1], this.ast);
    }
    return id;
  }

  #parameter(node) {
    const base = this.convert(node.name);
    if (node.type && base) {
      base.typeAnnotation = this.#typeAnnotation(node.type);
      base.range = [base.range[0], node.type.getEnd()];
      base.loc = getLocFor(base.range[0], base.range[1], this.ast);
    }
    if (base && node.questionToken) {
      base.optional = true;
    }

    if (node.dotDotDotToken) {
      return this.#node(node, {
        type: "RestElement",
        argument: base,
        decorators: this.#decorators(node),
        optional: false,
        typeAnnotation: undefined,
        value: undefined,
      });
    }

    if (node.initializer) {
      return this.#node(node, {
        type: "AssignmentPattern",
        decorators: this.#decorators(node),
        left: base,
        optional: false,
        right: this.convert(node.initializer),
      });
    }

    if (base) {
      base.decorators = this.#decorators(node);
    }
    return base;
  }

  /**
   * `constructor(private readonly dep: Dep)` declares a field as a side effect.
   * TypeScript spells that as modifiers on the parameter; ESTree wraps the parameter in
   * a TSParameterProperty instead.
   */
  #wrapParameterProperty(node, inner) {
    const accessibility = this.#accessibility(node);
    const readonly = this.#has(node, ModifierFlags.Readonly);
    const override = this.#has(node, ModifierFlags.Override);
    if (accessibility === undefined && !readonly && !override) {
      return inner;
    }
    return this.#node(node, {
      type: "TSParameterProperty",
      accessibility,
      decorators: this.#decorators(node),
      override,
      parameter: inner,
      readonly,
      static: false,
    });
  }

  #propertyName(name) {
    if (name.kind === SyntaxKind.ComputedPropertyName) {
      return this.convert(name.expression);
    }
    return this.convert(name);
  }

  /** `<string, number>` at a use site. */
  #typeArguments(node) {
    const args = node.typeArguments;
    if (!args || args.length === 0) {
      return undefined;
    }
    // NodeArray carries its own pos/end, which bracket the angle brackets.
    const range = [args.pos - 1, args.end + 1];
    return this.#node(
      node,
      { type: "TSTypeParameterInstantiation", params: this.#convertAll(args) },
      range,
    );
  }

  /** `<T extends string>` at a declaration site. */
  #typeParameters(node) {
    const params = node.typeParameters;
    if (!params || params.length === 0) {
      return undefined;
    }
    const range = [params.pos - 1, params.end + 1];
    return this.#node(
      node,
      { type: "TSTypeParameterDeclaration", params: this.#convertAll(params) },
      range,
    );
  }

  /** A mapped type's `+`/`-` modifier, or true when the token is bare. */
  #mappedModifier(token) {
    if (!token) {
      return undefined;
    }
    if (token.kind === SyntaxKind.PlusToken) {
      return "+";
    }
    if (token.kind === SyntaxKind.MinusToken) {
      return "-";
    }
    return true;
  }

  /** Identifiers in tag and attribute position are JSXIdentifier, not Identifier. */
  #jsxName(node) {
    switch (node.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.JsxNamespacedName:
        return this.#node(node, { type: "JSXIdentifier", name: this.#text(node) });
      case SyntaxKind.PropertyAccessExpression:
        return this.#node(node, {
          type: "JSXMemberExpression",
          object: this.#jsxName(node.expression),
          property: this.#jsxName(node.name),
        });
      case SyntaxKind.ThisKeyword:
        return this.#node(node, { type: "JSXIdentifier", name: "this" });
      default:
        return this.convert(node);
    }
  }

  /** `{}` or `{/* comment *​/}` inside JSX: an empty container, spanning the braces. */
  #jsxEmptyExpression(node) {
    const range = [node.getStart(this.ast) + 1, node.getEnd() - 1];
    return this.#node(node, { type: "JSXEmptyExpression" }, range);
  }

  /** ESTree spells accessibility out; TypeScript keeps it in the modifier bitmask. */
  #accessibility(node) {
    if (this.#has(node, ModifierFlags.Private)) {
      return "private";
    }
    if (this.#has(node, ModifierFlags.Protected)) {
      return "protected";
    }
    if (this.#has(node, ModifierFlags.Public)) {
      return "public";
    }
    return undefined;
  }

  #isAccessor(node) {
    return (node.modifiers ?? []).some((m) => m.kind === SyntaxKind.AccessorKeyword);
  }

  #decorators(node) {
    const decorators = (node.modifiers ?? []).filter((m) => m.kind === SyntaxKind.Decorator);
    return decorators.map((d) =>
      this.#node(d, { type: "Decorator", expression: this.convert(d.expression) }),
    );
  }

  #heritage(node, keyword) {
    const clause = (node.heritageClauses ?? []).find((c) => c.token === keyword);
    if (!clause) {
      return [];
    }
    return clause.types.map((t) =>
      this.#node(t, {
        type: "TSClassImplements",
        expression: this.convert(t.expression),
        typeArguments: this.#typeArguments(t),
      }),
    );
  }

  #superClass(node) {
    const clause = (node.heritageClauses ?? []).find(
      (c) => c.token === SyntaxKind.ExtendsKeyword,
    );
    return clause?.types?.[0] ? this.convert(clause.types[0].expression) : null;
  }

  #classBody(node) {
    const members = this.#convertAll(node.members);
    const openBrace = this.ast.text.indexOf("{", node.name?.getEnd() ?? node.getStart(this.ast));
    const range = [openBrace === -1 ? node.getStart(this.ast) : openBrace, node.getEnd()];
    return this.#node(node, { type: "ClassBody", body: members }, range);
  }

  #interfaceBody(node) {
    const members = this.#convertAll(node.members);
    const openBrace = this.ast.text.indexOf("{", node.name.getEnd());
    const range = [openBrace === -1 ? node.getStart(this.ast) : openBrace, node.getEnd()];
    return this.#node(node, { type: "TSInterfaceBody", body: members }, range);
  }

  #methodDefinition(node) {
    const kind =
      node.kind === SyntaxKind.Constructor
        ? "constructor"
        : node.kind === SyntaxKind.GetAccessor
          ? "get"
          : node.kind === SyntaxKind.SetAccessor
            ? "set"
            : "method";

    // The FunctionExpression covers the signature and body, not the member name.
    const valueStart = node.parameters.pos - 1;
    const valueRange = [valueStart, node.getEnd()];
    const value = {
      // An abstract method or an overload signature has no body, and ESTree gives that a
      // distinct node type rather than a FunctionExpression with a null body.
      type: node.body ? "FunctionExpression" : "TSEmptyBodyFunctionExpression",
      async: this.#has(node, ModifierFlags.Async),
      body: this.#child(node.body),
      declare: false,
      expression: false,
      generator: node.asteriskToken != null,
      id: null,
      params: this.#convertAll(node.parameters),
      returnType: this.#typeAnnotation(node.type),
      typeParameters: this.#typeParameters(node),
      range: valueRange,
      loc: getLocFor(valueRange[0], valueRange[1], this.ast),
    };
    this.esTreeNodeToTSNodeMap.set(value, node);

    const key =
      node.kind === SyntaxKind.Constructor
        ? this.#constructorKey(node)
        : this.#propertyName(node.name);

    return this.#node(node, {
      type: this.#has(node, ModifierFlags.Abstract)
        ? "TSAbstractMethodDefinition"
        : "MethodDefinition",
      accessibility: this.#accessibility(node),
      computed: node.name?.kind === SyntaxKind.ComputedPropertyName,
      decorators: this.#decorators(node),
      key,
      kind,
      optional: this.#postfix(node, SyntaxKind.QuestionToken),
      override: this.#has(node, ModifierFlags.Override),
      static: this.#has(node, ModifierFlags.Static),
      value,
    });
  }

  #constructorKey(node) {
    const start = this.ast.text.indexOf("constructor", node.getStart(this.ast));
    const range = [start, start + "constructor".length];
    return this.#node(
      node,
      { type: "Identifier", decorators: [], name: "constructor", optional: false },
      range,
    );
  }

  #binary(node) {
    const operatorKind = node.operatorToken.kind;
    const operator = tokenToString(operatorKind);

    if (operatorKind === SyntaxKind.CommaToken) {
      return this.#node(node, {
        type: "SequenceExpression",
        expressions: [this.convert(node.left), this.convert(node.right)],
      });
    }

    const type = ASSIGNMENT_OPERATORS.has(operatorKind)
      ? "AssignmentExpression"
      : LOGICAL_OPERATORS.has(operatorKind)
        ? "LogicalExpression"
        : "BinaryExpression";

    const left = this.convert(node.left);
    return this.#node(node, {
      type,
      left: type === "AssignmentExpression" ? this.#toPattern(left) : left,
      operator,
      right: this.convert(node.right),
    });
  }

  /**
   * Optional chaining.
   *
   * TypeScript marks each link with a questionDotToken. ESTree instead marks the links
   * `optional` and wraps the outermost link of the chain in a single ChainExpression, so
   * the wrapper is added here only when this node is not itself inside a chain.
   */
  #maybeChain(node) {
    const inner = this.#chainLink(node);
    if (!this.#isChainRoot(node)) {
      return inner;
    }
    if (!this.#containsOptional(node)) {
      return inner;
    }
    return this.#node(node, { type: "ChainExpression", expression: inner });
  }

  #chainLink(node) {
    switch (node.kind) {
      case SyntaxKind.PropertyAccessExpression:
        return this.#node(node, {
          type: "MemberExpression",
          computed: false,
          object: this.convert(node.expression),
          optional: node.questionDotToken != null,
          property: this.convert(node.name),
        });
      case SyntaxKind.ElementAccessExpression:
        return this.#node(node, {
          type: "MemberExpression",
          computed: true,
          object: this.convert(node.expression),
          optional: node.questionDotToken != null,
          property: this.convert(node.argumentExpression),
        });
      case SyntaxKind.CallExpression:
        return this.#node(node, {
          type: "CallExpression",
          arguments: this.#convertAll(node.arguments),
          callee: this.convert(node.expression),
          optional: node.questionDotToken != null,
          typeArguments: this.#typeArguments(node),
        });
      case SyntaxKind.NewExpression:
        return this.#node(node, {
          type: "NewExpression",
          arguments: this.#convertAll(node.arguments),
          callee: this.convert(node.expression),
          typeArguments: this.#typeArguments(node),
        });
      default:
        return this.#unsupported(node);
    }
  }

  /** True when no enclosing node continues the same chain. */
  #isChainRoot(node) {
    const parent = node.parent;
    if (!parent) {
      return true;
    }
    switch (parent.kind) {
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        return parent.expression !== node;
      case SyntaxKind.CallExpression:
        return parent.expression !== node;
      case SyntaxKind.NonNullExpression:
        return false;
      default:
        return true;
    }
  }

  #containsOptional(node) {
    let current = node;
    while (current) {
      if (current.questionDotToken) {
        return true;
      }
      switch (current.kind) {
        case SyntaxKind.CallExpression:
        case SyntaxKind.ElementAccessExpression:
        case SyntaxKind.NonNullExpression:
        case SyntaxKind.PropertyAccessExpression:
          current = current.expression;
          break;
        default:
          return false;
      }
    }
    return false;
  }

  #templateElement(node, tail) {
    const raw = this.#text(node);
    // Strip the delimiters: ` or } at the start, ` or ${ at the end.
    const rawInner = raw.slice(1, tail ? -1 : -2);
    const start = node.getStart(this.ast);
    const range = [start, node.getEnd()];
    return this.#node(
      node,
      { type: "TemplateElement", tail, value: { cooked: node.text, raw: rawInner } },
      range,
    );
  }

  #templateExpression(node) {
    const quasis = [this.#templateElement(node.head, false)];
    const expressions = [];
    for (const span of node.templateSpans) {
      expressions.push(this.convert(span.expression));
      quasis.push(
        this.#templateElement(span.literal, span.literal.kind === SyntaxKind.TemplateTail),
      );
    }
    return this.#node(node, { type: "TemplateLiteral", expressions, quasis });
  }

  #importDeclaration(node) {
    const specifiers = [];
    const clause = node.importClause;
    if (clause?.name) {
      specifiers.push(
        this.#node(clause.name, {
          type: "ImportDefaultSpecifier",
          local: this.convert(clause.name),
        }),
      );
    }
    const bindings = clause?.namedBindings;
    if (bindings?.kind === SyntaxKind.NamespaceImport) {
      specifiers.push(
        this.#node(bindings, {
          type: "ImportNamespaceSpecifier",
          local: this.convert(bindings.name),
        }),
      );
    } else if (bindings?.kind === SyntaxKind.NamedImports) {
      for (const element of bindings.elements) {
        specifiers.push(
          this.#node(element, {
            type: "ImportSpecifier",
            imported: this.convert(element.propertyName ?? element.name),
            importKind: element.isTypeOnly ? "type" : "value",
            local: this.convert(element.name),
          }),
        );
      }
    }

    return this.#node(node, {
      type: "ImportDeclaration",
      attributes: [],
      importKind: clause?.isTypeOnly ? "type" : "value",
      phase: null,
      source: this.convert(node.moduleSpecifier),
      specifiers,
    });
  }

  #exportDeclaration(node) {
    const specifiers = [];
    if (node.exportClause?.kind === SyntaxKind.NamedExports) {
      for (const element of node.exportClause.elements) {
        specifiers.push(
          this.#node(element, {
            type: "ExportSpecifier",
            exported: this.convert(element.name),
            exportKind: element.isTypeOnly ? "type" : "value",
            local: this.convert(element.propertyName ?? element.name),
          }),
        );
      }
    }

    if (!node.exportClause || node.exportClause.kind === SyntaxKind.NamespaceExport) {
      return this.#node(node, {
        type: "ExportAllDeclaration",
        attributes: [],
        exported: node.exportClause ? this.convert(node.exportClause.name) : null,
        exportKind: node.isTypeOnly ? "type" : "value",
        source: this.convert(node.moduleSpecifier),
      });
    }

    return this.#node(node, {
      type: "ExportNamedDeclaration",
      attributes: [],
      declaration: null,
      exportKind: node.isTypeOnly ? "type" : "value",
      source: this.#child(node.moduleSpecifier),
      specifiers,
    });
  }
}

/** Convert a whole source file. */
export function convertProgram(sourceFile) {
  const converter = new Converter(sourceFile);
  const ast = converter.convertProgram();
  return {
    ast,
    esTreeNodeToTSNodeMap: converter.esTreeNodeToTSNodeMap,
    tsNodeToESTreeNodeMap: converter.tsNodeToESTreeNodeMap,
    unsupported: converter.unsupported,
  };
}
