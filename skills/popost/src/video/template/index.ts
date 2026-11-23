/** Templates: a re-creation becomes a reusable structure with slots. See types.ts for the files of a template. */
export { checkFill } from './check';
export { estimateCapacity, measureCapacity, usageOf } from './capacity';
export { fillPackage, fillTemplate, speakRetarget, STRUCTURE_FILE, VOICE_FILE, type FillOptions, type FillResult } from './fill';
export { loadTemplate, measureHash, saveTemplate, TemplateError, type SaveOptions } from './save';
export { retargetInputs, structureMeasure, templateFrom } from './structure';
export { generatedFills, SWAP_MARGIN, swapTest, type SwapFill, type SwapOptions } from './swap';
export type * from './types';
