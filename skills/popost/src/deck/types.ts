/**
 * The shapes `popost deck` passes between the host side (Node, over `Runtime`) and the converter, which runs the editor's
 * own `compileProject` / `splitProject` (`packages/canvas-editor/src/storage/compile.ts`) inside Chromium (`engine.ts`).
 * They mirror the editor's `ManifestPage`, `PreviousPage` and `SplitPage`.
 */

export interface DeckSize {
  readonly width: number;
  readonly height: number;
}

/** A project page as the editor's `compileProject` takes it. */
export interface DeckPage extends DeckSize {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  /** Page file path relative to the project root, e.g. `pages/p1.html`. */
  readonly htmlPath: string;
  readonly html: string;
}

export interface DeckPreviousPage extends DeckSize {
  readonly id: string;
  readonly role?: string;
}

/** One top-level `.slide` of an editor document, as a project page. */
export interface DeckSplitPage extends DeckSize {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** A complete page document for `pages/<id>.html`. */
  readonly html: string;
}

export interface DeckSplit {
  readonly pages: readonly DeckSplitPage[];
  /** One per page of `pages`, same order: the slide as the document has it, to compare with `baseline`. */
  readonly signatures: readonly string[];
}

/** What turns a project into an editor document and back. The default runs in Chromium; tests may pass their own. */
export interface DeckEngine {
  /** The editor document of `pages` (in order). Throws `ValueError` for a page that cannot be compiled. */
  compile(pages: readonly DeckPage[]): Promise<string>;
  /** The pages of an editor document. Throws `ValueError` when it has no slide. */
  split(content: string, previousPages: readonly DeckPreviousPage[], defaultSize: DeckSize): Promise<DeckSplit>;
  /**
   * Each page's slide as `compile` writes it now, in the form of `DeckSplit.signatures`: every form an unedited slide of that
   * page may have in a document (the current one first); `null` when the page does not compile.
   */
  baseline(pages: readonly DeckPage[]): Promise<Record<string, readonly string[] | null>>;
}

/** Runs `fn` with an engine and releases whatever the engine holds (the browser) afterwards. */
export type DeckSession = <T>(fn: (engine: DeckEngine) => Promise<T>) => Promise<T>;
