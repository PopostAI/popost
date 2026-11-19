import { hostProject } from '../host/project-tools';
import { CloudButton } from './CloudButton';
import { ExportPanel } from './ExportPanel';
import { PageDesign, type CropRequest } from './PageDesign';
import { useCallback, useState } from 'react';
import type { EditorController, EditorSnapshot } from '../contracts';
import { useDismissable } from './dismiss';
import { Icon } from './icons';
import { useT } from './i18n';
import type { MessageKey } from './i18n';

const SAVE_TEXT: Record<EditorSnapshot['saveState'], MessageKey> = {
  saved: 'save.saved',
  dirty: 'save.dirty',
  saving: 'save.saving',
  error: 'save.error',
};

export function Topbar({ controller, snap, onSize, comparing, onCompare, local = false, canCompare = false }: { controller: EditorController; snap: EditorSnapshot; onSize(size: CropRequest): void; comparing: boolean; onCompare(): void; local?: boolean; canCompare?: boolean }) {
  const t = useT();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState<string | null>(null);
  const advancedExport = local || Boolean(hostProject());
  useDismissable(exportOpen, () => setExportOpen(false));
  const ready = snap.docState === 'ready';
  const saveLocal = useCallback(async () => {
    await controller.save();
    const current = controller.getSnapshot();
    return current.docState === 'ready' && current.saveState === 'saved';
  }, [controller]);

  return (
    <header className="topbar">
      <div className="tb-group">
        <button type="button" id="btn-undo" className="tb-btn" disabled={!snap.canUndo} title={t('topbar.undo')} aria-label={t('topbar.undo')} onClick={controller.undo}>
          <Icon name="undo" />
        </button>
        <button type="button" id="btn-redo" className="tb-btn" disabled={!snap.canRedo} title={t('topbar.redo')} aria-label={t('topbar.redo')} onClick={controller.redo}>
          <Icon name="redo" />
        </button>
        <span className="tb-sep" />
        <button type="button" id="btn-reset-layout" className="tb-btn" disabled={!ready} title={t('topbar.resetLayout')} onClick={() => void controller.resetToInitial()}>
          <Icon name="reset" />
          <span className="tb-label">{t('topbar.resetLayout')}</span>
        </button>
      </div>

      <PageDesign controller={controller} snap={snap} onSize={onSize} />
      {canCompare && <button type="button" className={`tb-btn compare-toggle${comparing ? ' active' : ''}`} disabled={!ready} aria-pressed={comparing} aria-label={t(comparing ? 'compare.close' : 'compare.open')} onClick={onCompare}><Icon name="compare" /><span className="tb-text">{t(comparing ? 'compare.close' : 'compare.open')}</span></button>}
      <div className="tb-spacer" />

      <span className={`save-state state-${snap.saveState}`} role="status">
        <i className="state-dot" />
        <span className="save-text">{t(SAVE_TEXT[snap.saveState])}</span>
      </span>

      <div className="tb-menu">
        <button type="button" id="btn-export" className="tb-btn outlined" disabled={!ready} aria-haspopup={advancedExport ? "dialog" : "menu"} aria-expanded={exportOpen} title={t('topbar.export')} onClick={() => setExportOpen((o) => !o)}>
          <Icon name="export" />
          <span className="tb-label">{t('topbar.export')}</span>
          <span className="tb-caret"><Icon name="chevron" size={12} /></span>
        </button>
        {exportOpen && (
          <>
            <div className="menu-scrim" onMouseDown={() => setExportOpen(false)} />
            {advancedExport ? <ExportPanel local={local} controller={controller} snap={snap} customName={exportName} onNameChange={setExportName} onClose={() => setExportOpen(false)} /> : <div id="pop-export" className="popover" role="menu">
              <button type="button" role="menuitem" className="menu-item" onClick={() => {
                setExportOpen(false);
                void controller.downloadAll();
              }}>{t('topbar.downloadImages')}</button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setExportOpen(false);
                  controller.exportHTML();
                }}
              >
                {t('topbar.exportHtml')}
              </button>
            </div>}
          </>
        )}
      </div>

      {controller.cloud && ready && <CloudButton cloud={controller.cloud} saveState={snap.saveState} saveLocal={saveLocal} />}

      <button type="button" id="btn-save" className="btn-save" disabled={!ready || snap.saveState === 'saving'} title={t('topbar.saveTitle')} onClick={() => void controller.save()}>
        {snap.saveState !== 'saved' && <i className="save-dot" />}
        {t('topbar.save')}
      </button>
    </header>
  );
}
