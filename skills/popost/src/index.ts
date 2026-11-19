/**
 * Library entry for hosts that run the popost CLI in-process (the popost.ai web agent sandbox): `run(argv, runtime)`
 * with the host's own runtime. The npm `popost` command is `cli.ts`.
 */
export { run } from './main';
export { VERSION } from './version';
export { launchChromium, findChromium, BrowserUnavailableError } from './render/browser';
export type { CommandMain, EditorHost, FileStat, FileSystem, LocalProcesses, Runtime } from './runtime';
export { exportDeck } from './deck/export-deck';
export type { ExportDeckOptions, ExportDeckResult } from './deck/export-deck';
export { importDeck } from './deck/import-deck';
export type { ImportDeckOptions, ImportDeckResult } from './deck/import-deck';
export type { DeckEngine, DeckPage, DeckSession, DeckSize, DeckSplit, DeckSplitPage } from './deck/types';

export { searchTemplateIndex } from './workflow/community-search';
export type { SearchableTemplate, TemplateSearchQuery } from './workflow/community-search';
