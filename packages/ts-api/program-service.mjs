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

/** tsconfig path to ProgramService. ESLint calls the parser once per file. */
const services = new Map();

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
  /** Count of snapshot replacements. Exposed so tests can assert we do not churn. */
  #updates = 0;

  constructor({ cwd, tsconfigPath }) {
    this.#tsconfigPath = tsconfigPath;

    this.#api = new API({
      cwd,
      // Returning undefined falls through to the real filesystem, so an empty overlay
      // costs nothing. Only files ESLint hands us with modified text are intercepted.
      fs: { readFile: (fileName) => this.#overlay.get(fileName) },
    });

    // openProjects is ref-counted and persists across snapshots, so it is passed once
    // here and never again. Repeating it on every update would leak references.
    this.#snapshot = this.#api.updateSnapshot({ openProjects: [tsconfigPath] });

    if (this.#snapshot.getProjects().length === 0) {
      this.#api.close();
      throw new Error(`No project was loaded from ${tsconfigPath}`);
    }
  }

  get project() {
    const projects = this.#snapshot.getProjects();
    return projects.find((p) => p.configFileName === this.#tsconfigPath) ?? projects[0];
  }

  get program() {
    return this.project.program;
  }

  get checker() {
    return this.project.checker;
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
    this.#updates++;
  }

  /** How many times the snapshot has been replaced since construction. */
  get snapshotUpdates() {
    return this.#updates;
  }

  getSourceFile(fileName) {
    return this.program.getSourceFile(fileName);
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

/** Tear down every service. Primarily for tests, which must not leak tsgo processes. */
export function clearProgramServices() {
  for (const service of services.values()) {
    service.close();
  }
  services.clear();
}
