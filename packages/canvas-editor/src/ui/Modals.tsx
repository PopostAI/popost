import { useEffect, useRef } from 'react';
import type { EditorController } from '../contracts';
import { useT } from './i18n';

/** `#modal-conflict`: the stored revision changed elsewhere. */
export function ConflictModal({ controller }: { controller: EditorController }) {
  const t = useT();
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div id="modal-conflict" className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="modal">
        <h2 id="conflict-title">{t('conflict.title')}</h2>
        <p>{t('conflict.body')}</p>
        <div className="modal-actions">
          <button type="button" id="conflict-reload" className="btn" ref={first} onClick={() => void controller.reload()}>
            {t('conflict.reload')}
          </button>
          <button type="button" id="conflict-overwrite" className="btn primary" onClick={() => void controller.save({ force: true })}>
            {t('conflict.overwrite')}
          </button>
        </div>
      </div>
    </div>
  );
}
