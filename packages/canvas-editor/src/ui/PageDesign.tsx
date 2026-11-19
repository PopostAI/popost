import { useState } from 'react';
import type { EditorController, EditorSnapshot } from '../contracts';
import { Icon } from './icons';
import { useLang, useT } from './i18n';
import { useDismissable } from './dismiss';
import { SizeChoices, type CanvasSize } from './SizeChoices';
import { frameElement } from './frame-dom';
import { ColorSwatches } from './panels/ColorSwatches';
import { useDocColors } from './panels/hooks';
import { isTransparentColor, toHex } from './logic/colors';
import '../styles/size-choices.css';

export type CropRequest = CanvasSize & { pageId: string };

export function PageDesign({ controller, snap, onSize }: {
  controller: EditorController; snap: EditorSnapshot; onSize(size: CropRequest): void;
}) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState<'size' | 'color' | null>(null);
  useDismissable(open !== null, () => setOpen(null));
  const page = snap.pages.find((item) => item.id === snap.currentPageId);
  const colors = useDocColors(controller, snap.sourceVersion);
  const node = page && frameElement(page.id);
  const bg = node?.ownerDocument.defaultView?.getComputedStyle(node).backgroundColor;
  const noColor = isTransparentColor(bg);
  return (
    <div className="tb-group page-design">
      <button type="button" className="tb-btn" disabled={!page} aria-expanded={open === 'size'} aria-label={t('design.size')} onClick={() => setOpen(open === 'size' ? null : 'size')}><Icon name="crop" /><span className="tb-text">{t('design.size')}</span><span className="tb-caret"><Icon name="chevron" size={12} /></span></button>
      <button type="button" className="tb-btn" disabled={!page} aria-expanded={open === 'color'} aria-label={t('design.background')} onClick={() => setOpen(open === 'color' ? null : 'color')}><i className="background-sample" style={{ background: noColor ? undefined : bg }} /><span className="tb-text">{t('design.background')}</span></button>
      {open && page && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(null)} />
          <div className={`popover page-design-pop ${open}`}>
            {open === 'size' ? <SizeChoices value={page} zh={lang === 'zh'} onChange={(size) => {
              setOpen(null);
              if (size.width !== page.width || size.height !== page.height) onSize({ ...size, pageId: page.id });
            }} /> : <ColorSwatches expanded docColors={colors} current={noColor ? 'transparent' : toHex(bg)} allowNone onPick={(color, phase) => {
              controller.apply({ kind: 'setStyle', id: page.id, props: { 'background-color': color } }, { label: 'page background', coalesceKey: phase === 'live' ? 'page background' : undefined });
            }} />}
          </div>
        </>
      )}
    </div>
  );
}
