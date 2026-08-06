// The single owner of the TypeScript 7 connection.
//
// Every `typescript/unstable/*` import in this project lives in this package, so the
// churn in an explicitly unstable API has one blast radius. Nothing downstream imports
// the compiler directly.
//
// Lifetime model: one API instance and one live snapshot per tsconfig, held for the
// whole ESLint run rather than per file. Booting the API costs ~31 ms, so doing it per
// file would dominate everything else.

import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { installNodeCompat, resetNodeCompat } from "./node-compat.mjs";
import { installTypeCompat, resetTypeCompat } from "./type-compat.mjs";

/** tsconfig path to ProgramService. ESLint calls the parser once per file. */
const services = new Map();

/** Round trips per protocol method, for working out which ones are worth avoiding. */
const requestCounts = new Map();

function countRequestsByMethod(client) {
  for (const name of ["apiRequest", "apiRequestBinary"]) {
    const original = client[name];
    if (typeof original !== "function") {
      continue;
    }
    Object.defineProperty(client, name, {
      configurable: true,
      writable: true,
      value(method, params) {
        requestCounts.set(method, (requestCounts.get(method) ?? 0) + 1);
        return original.call(client, method, params);
      },
    });
  }
}

class ProgramService {
  #api;
  #tsconfigPath;

  /** Files whose content we are substituting for what is on disk. */
  #overlay = new Map();
  /** What the server currently believes each file contains. */
  #applied = new Map();
  /** On-disk content, read at most once per file per run. */
  #diskCache = new Map();

  #snapshot;
  /** The resolved project, and the snapshot it belongs to. */
  #project;
  #projectForSnapshot;
  /** Count of snapshot replacements. Exposed so tests can assert we do not churn. */
  #updates = 0;

  constructor({ cwd, tsconfigPath }) {
    this.#tsconfigPath = tsconfigPath;

    this.#api = new API({
      cwd,
      // Returning undefined falls through to the real filesystem, so an empty overlay
      // costs nothing. Only files ESLint hands us with modified text are intercepted.
      fs: { readFile: (fileName) => this.#overlay.get(fileName) },
      // Every checker call is a synchronous round trip, so the question that decides
      // where optimisation is worth spending is how much of that time the server spends
      // computing and how much is transport. The server splits the two when asked, at
      // the cost of timing every request, so this is opt-in.
      collectTiming: process.env.TSESLINT7_TIMING === "1",
    });

    if (process.env.TSESLINT7_TIMING === "1") {
      countRequestsByMethod(this.#api.client);
    }

    // openProjects is ref-counted and persists across snapshots, so it is passed once
    // here and never again. Repeating it on every update would leak references.
    this.#snapshot = this.#api.updateSnapshot({ openProjects: [tsconfigPath] });

    if (this.#snapshot.getProjects().length === 0) {
      this.#api.close();
      throw new Error(`No project was loaded from ${tsconfigPath}`);
    }
  }

  /**
   * The project for this tsconfig, resolved once per snapshot.
   *
   * Caching is not an optimisation here, it is required for correctness. Symbols and
   * types are handles owned by a particular checker, and passing one back to a different
   * checker fails with "empty symbol handle". Resolving the project on every access
   * risks handing out a different Checker each time, so it is pinned to the snapshot and
   * only recomputed when the snapshot is replaced.
   */
  get project() {
    if (this.#projectForSnapshot !== this.#snapshot) {
      const projects = this.#snapshot.getProjects();
      this.#project =
        projects.find((p) => p.configFileName === this.#tsconfigPath) ?? projects[0];
      this.#projectForSnapshot = this.#snapshot;
    }
    return this.#project;
  }

  get program() {
    return this.project.program;
  }

  get checker() {
    const checker = this.project.checker;
    // TS 6 put convenience methods on Type; TS 7.0 moved them to the Checker. Restore
    // them the first time a checker is handed out, since rules call the old shape.
    installTypeCompat(checker);
    return checker;
  }

  #readDisk(fileName) {
    if (!this.#diskCache.has(fileName)) {
      let content;
      try {
        content = readFileSync(fileName, "utf8");
      } catch {
        content = undefined;
      }
      this.#diskCache.set(fileName, content);
    }
    return this.#diskCache.get(fileName);
  }

  /**
   * Point the server at the text ESLint is actually linting.
   *
   * The common case by far is a plain CLI run over unmodified files, where the text
   * matches disk and there is nothing to do. Only editors with unsaved buffers and
   * ESLint processors produce text that differs, and only those pay for a snapshot
   * update.
   */
  setFileText(fileName, text) {
    if (this.#applied.get(fileName) === text) {
      return;
    }

    const matchesDisk = text === this.#readDisk(fileName);
    const hadOverlay = this.#overlay.has(fileName);

    if (matchesDisk && !hadOverlay) {
      // The server already sees exactly this. No snapshot churn.
      this.#applied.set(fileName, text);
      return;
    }

    if (matchesDisk) {
      this.#overlay.delete(fileName);
    } else {
      this.#overlay.set(fileName, text);
    }
    this.#applied.set(fileName, text);

    // Replacing the snapshot invalidates every node and type handle from the previous
    // one. That is safe here only because this runs at the start of a file's parse,
    // after all rules for the previous file have finished.
    const previous = this.#snapshot;
    this.#snapshot = this.#api.updateSnapshot({ fileChanges: { changed: [fileName] } });
    previous.dispose();
    resetTypeCompat();
    resetNodeCompat();
    this.#updates++;
  }

  /** How many times the snapshot has been replaced since construction. */
  get snapshotUpdates() {
    return this.#updates;
  }

  getSourceFile(fileName) {
    const sourceFile = this.program.getSourceFile(fileName);
    // TS 7 has no getChildren(); restore it the first time a node is available.
    installNodeCompat(sourceFile);
    return sourceFile;
  }

  /**
   * Resolve types for many nodes in one round trip.
   *
   * The Checker takes arrays as well as single nodes. A warm single query is ~0.020 ms,
   * so this matters at the scale a whole-file rule works at, not for one lookup.
   */
  getTypes(nodes) {
    if (nodes.length === 0) {
      return [];
    }
    return this.checker.getTypeAtLocation(nodes);
  }

  getSymbols(nodes) {
    if (nodes.length === 0) {
      return [];
    }
    return this.checker.getSymbolAtLocation(nodes);
  }

  /** Round-trip, server, and transport time. Empty unless TSESLINT7_TIMING=1. */
  get timing() {
    return this.#api.getTimingInfo();
  }

  close() {
    this.#api.close();
  }
}

/** Get, creating if needed, the service for a tsconfig. */
export function getProgramService({ cwd = process.cwd(), tsconfigPath }) {
  let service = services.get(tsconfigPath);
  if (!service) {
    service = new ProgramService({ cwd, tsconfigPath });
    services.set(tsconfigPath, service);
  }
  return service;
}

/**
 * What the run spent talking to typescript-go, summed over every project.
 *
 * Returns undefined unless TSESLINT7_TIMING=1 was set before the first parse.
 */
export function programTiming() {
  const totals = { roundTripMs: 0, serverTimeMs: 0, bytesSent: 0, bytesReceived: 0, requestCount: 0 };
  let enabled = false;
  for (const service of services.values()) {
    const info = service.timing;
    if (!info?.enabled) {
      continue;
    }
    enabled = true;
    for (const key of Object.keys(totals)) {
      totals[key] += info.totals[key] ?? 0;
    }
  }
  if (!enabled) {
    return undefined;
  }
  totals.byMethod = [...requestCounts].sort((a, b) => b[1] - a[1]);
  return totals;
}

/** Tear down every service. Primarily for tests, which must not leak tsgo processes. */
export function clearProgramServices() {
  for (const service of services.values()) {
    service.close();
  }
  services.clear();
}
