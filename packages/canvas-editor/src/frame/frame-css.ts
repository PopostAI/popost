/** CSS injected into the preview (`buildPreview({ frameCSS })`). The editor overlay draws all selection chrome. */
import { CURRENT_PAGE_CLASS } from '../core/preview';
import { HIGHLIGHT_ATTR, PAGE_ATTR, SELECT_ATTR } from './marks';

export const FRAME_CSS = `
html, body { margin: 0; padding: 0; }
html, body { overflow: hidden !important; scrollbar-width: none; }
::-webkit-scrollbar { display: none; }
[${PAGE_ATTR}]:not(.${CURRENT_PAGE_CLASS}) { display: none !important; }
[${SELECT_ATTR}] { pointer-events: auto !important; }
* { -webkit-user-select: none; user-select: none; }
[contenteditable="true"], [contenteditable="true"] [${SELECT_ATTR}] { pointer-events: auto !important; }
* { -webkit-user-select: text; user-select: text; }
[contenteditable="true"] { outline: none; cursor: text; }
img, svg image { -webkit-user-drag: none; user-drag: none; }
[${HIGHLIGHT_ATTR}] { outline: 2px solid #ff7a1a !important; outline-offset: -2px; }
`.trim();
