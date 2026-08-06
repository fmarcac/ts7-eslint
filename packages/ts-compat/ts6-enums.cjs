// Enums the TypeScript 6 API exposed that TypeScript 7 no longer ships.
//
// TS 7 still ships 27 enums under dist/enums (syntaxKind, typeFlags, symbolFlags,
// modifierFlags, objectFlags, nodeFlags, signatureKind, scriptTarget, and so on), and
// those are re-exported directly rather than copied. The three below have no TS 7
// counterpart, so they are transcribed verbatim from typescript@6.0.3's typescript.d.ts.
//
// Values are load-bearing: rules compare against them numerically. Do not renumber.

/** @see typescript@6.0.3 Extension */
const Extension = {
  Ts: ".ts",
  Tsx: ".tsx",
  Dts: ".d.ts",
  Js: ".js",
  Jsx: ".jsx",
  Json: ".json",
  TsBuildInfo: ".tsbuildinfo",
  Mjs: ".mjs",
  Mts: ".mts",
  Dmts: ".d.mts",
  Cjs: ".cjs",
  Cts: ".cts",
  Dcts: ".d.cts",
};

/** @see typescript@6.0.3 CheckFlags */
const CheckFlags = {
  None: 0,
  Instantiated: 1,
  SyntheticProperty: 2,
  SyntheticMethod: 4,
  Readonly: 8,
  ReadPartial: 16,
  WritePartial: 32,
  HasNonUniformType: 64,
  HasLiteralType: 128,
  ContainsPublic: 256,
  ContainsProtected: 512,
  ContainsPrivate: 1024,
  ContainsStatic: 2048,
  Late: 4096,
  ReverseMapped: 8192,
  OptionalParameter: 16384,
  RestParameter: 32768,
  DeferredType: 65536,
  HasNeverType: 131072,
  Mapped: 262144,
  StripOptional: 524288,
  Unresolved: 1048576,
  Synthetic: 6,
  Discriminant: 192,
  Partial: 48,
};

/** @see typescript@6.0.3 IndexKind */
const IndexKind = {
  String: 0,
  Number: 1,
  0: "String",
  1: "Number",
};

/** @see typescript@6.0.3 TypeFormatFlags */
const TypeFormatFlags = {
  None: 0,
  NoTruncation: 1,
  WriteArrayAsGenericType: 2,
  GenerateNamesForShadowedTypeParams: 4,
  UseStructuralFallback: 8,
  WriteTypeArgumentsOfSignature: 32,
  UseFullyQualifiedType: 64,
  SuppressAnyReturnType: 256,
  MultilineObjectLiterals: 1024,
  WriteClassExpressionAsTypeLiteral: 2048,
  UseTypeOfFunction: 4096,
  OmitParameterModifiers: 8192,
  UseAliasDefinedOutsideCurrentScope: 16384,
  UseSingleQuotesForStringLiteralType: 268435456,
  NoTypeReduction: 536870912,
  OmitThisParameter: 33554432,
  AllowUniqueESSymbolType: 1048576,
  AddUndefined: 131072,
  WriteArrowStyleSignature: 262144,
  InArrayType: 524288,
  InElementType: 2097152,
  InFirstTypeArgument: 4194304,
  InTypeAlias: 8388608,
  NodeBuilderFlagsMask: 848330095,
};

module.exports = { CheckFlags, Extension, IndexKind, TypeFormatFlags };
