// @tseslint7/ts-api
//
// The only package that imports typescript/unstable/*. Everything downstream, the ESTree
// converter, the parser, and the type-services facade, talks to the compiler through
// here.

export { capabilities } from "./capabilities.mjs";
export { clearProgramServices, getProgramService } from "./program-service.mjs";
export { installNodeCompat, resetNodeCompat } from "./node-compat.mjs";
export { nextTokenAfter } from "./token-walk.mjs";
export { installTypeCompat, resetTypeCompat, unansweredQueries } from "./type-compat.mjs";
