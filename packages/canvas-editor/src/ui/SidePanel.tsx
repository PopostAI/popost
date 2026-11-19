import { useState } from 'react';
import { useDismissable } from './dismiss';
import { ImagePanel } from './panels/ImagePanel';
import type { ReactNode } from 'react';
import type { EditorController } from '../contracts';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useT } from './i18n';
import type { MessageKey } from './i18n';
import { BlockPanel } from './panels/BlockPanel';
import { CodePanel } from './panels/CodePanel';
import { LayersPanel } from './panels/LayersPanel';
import { TextPanel } from './panels/TextPanel';

export type PanelId = 'text' | 'block' | 'layers' | 'code' | 'images';

const RAIL: Array<{ id: PanelId; icon: IconName; label: MessageKey }> = [
  { id: 'layers', icon: 'layers', label: 'panel.layers' },
  { id: 'block', icon: 'block', label: 'panel.block' },
  { id: 'code', icon: 'code', label: 'panel.code' },
];

export function Rail({ open, onToggle, onAddPage }: { open: PanelId | null; onToggle(id: PanelId): void; onAddPage(): void }) {
  const t = useT();
  const [addOpen, setAddOpen] = useState(false);
  useDismissable(addOpen, () => setAddOpen(false));
  return (
    <nav className="rail" aria-label={t('rail.label')}>
      {RAIL.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`rail-item${open === item.id ? ' active' : ''}`}
          data-panel={item.id}
          aria-pressed={open === item.id}
          title={t(item.label)}
          onClick={() => onToggle(item.id)}
        >
          <Icon name={item.icon} size={18} />
          <span>{t(item.label)}</span>
        </button>
      ))}
      <div className="rail-add">
        <button type="button" className={`rail-item${open === 'text' || open === 'images' ? ' active' : ''}`} aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}>
          <Icon name="plus" size={18} /><span>{t('panel.add')}</span>
        </button>
        {addOpen && <>
          <div className="menu-scrim" onMouseDown={() => setAddOpen(false)} />
          <div className="popover add-popover">
            <button type="button" className="menu-item" onClick={() => { setAddOpen(false); if (open !== 'text') onToggle('text'); }}><Icon name="text" />{t('add.text')}</button>
            <button type="button" className="menu-item" onClick={() => { setAddOpen(false); if (open !== 'images') onToggle('images'); }}><Icon name="image" />{t('panel.images')}</button>
            <button type="button" className="menu-item" onClick={() => { setAddOpen(false); onAddPage(); }}><Icon name="plus" />{t('add.page')}</button>
          </div>
        </>}
      </div>
    </nav>
  );
}

/**
 * The single side panel (`#panel`) with its header; bodies come from `panels/`. The element is always present
 * (external tests read `#panel` + `.open` + `data-view`); it is hidden by CSS while no panel is open.
 */
export function PanelHost({ open, controller, onClose }: { open: PanelId | null; controller: EditorController; onClose(): void }) {
  const t = useT();
  if (!open) return <aside id="panel" className="panel" aria-hidden="true" />;
  const bodies: Record<Exclude<PanelId, 'code'>, ReactNode> = {
    text: <TextPanel controller={controller} />,
    block: <BlockPanel controller={controller} />,
    layers: <LayersPanel controller={controller} />,
    images: <ImagePanel controller={controller} />,
  };
  return (
    <aside id="panel" className="panel open" data-open={open} data-view={open}>
      {open === 'code' ? <CodePanel controller={controller} onClose={onClose} /> : <>
      <div className="panel-head">
        <h2>{t(RAIL.find((r) => r.id === open)?.label ?? (open === 'images' ? 'panel.images' : 'panel.text'))}</h2>
        <button type="button" id="panel-close" className="tb-btn small" title={t('panel.close')} aria-label={t('panel.close')} onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {bodies[open]}
      </>}
    </aside>
  );
}
