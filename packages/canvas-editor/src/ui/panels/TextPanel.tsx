import { useState } from 'react';
import type { EditorController } from '../../contracts';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { toHex } from '../logic/colors';
import { newBlockHTML } from '../logic/insert';
import type { NewBlockKind } from '../logic/insert';
import { useSnapshot } from '../use-snapshot';
import { ColorSwatches } from './ColorSwatches';
import type { ColorPhase } from './ColorSwatches';
import { targetsOf, useDocColors, useTargetStyles } from './hooks';

const ADD: Array<{ kind: NewBlockKind; id: string; label: MessageKey; sample: MessageKey; icon: string }> = [
  { kind: 'heading', id: 'add-heading', label: 'text.addHeading', sample: 'text.sampleHeading', icon: 'H1' },
  { kind: 'subheading', id: 'add-subheading', label: 'text.addSubheading', sample: 'text.sampleSubheading', icon: 'H2' },
  { kind: 'paragraph', id: 'add-paragraph', label: 'text.addParagraph', sample: 'text.sampleParagraph', icon: 'P' },
];

export function TextPanel({ controller }: { controller: EditorController }) {
  const t = useT();
  const snap = useSnapshot(controller);
  const docColors = useDocColors(controller, snap.sourceVersion);
  const styles = useTargetStyles(controller, snap, ['color']);
  const targets = targetsOf(snap);
  const [newColor, setNewColor] = useState("#222222");
  const rangeEditing = snap.editingTextId !== null && snap.textState?.range === true;

  const add = (kind: NewBlockKind, sample: MessageKey): void => {
    if (snap.currentPageId === null) return;
    controller.apply({ kind: 'insertHTML', parentId: snap.currentPageId, beforeId: null, html: newBlockHTML(kind, controller.pageSize().width, t(sample), newColor) }, { label: 'add text' });
    // The controller selects the new block; put the caret in it with the sample text selected.
    const created = controller.getSnapshot().selection[0];
    if (created !== undefined && controller.index().elements.has(created)) controller.beginTextEdit(created, 'all');
  };

  const pick = (color: string, phase: ColorPhase): void => {
    if (rangeEditing && phase === 'live') return;
    setNewColor(color);
    if (targets.length) controller.format({ command: 'color', value: color });
  };

  return (
    <div className="panel-body" data-panel-body="text">
      <section className="p-section">
        <h3>{t('text.add')}</h3>
        <div className="add-list">
          {ADD.map((a) => (
            <button key={a.kind} type="button" id={a.id} className={`add-item add-${a.kind}`} disabled={snap.docState !== 'ready'} onClick={() => add(a.kind, a.sample)}>
              <span className="add-icon">{a.icon}</span>
              <span>{t(a.label)}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="p-section">
        <h3>{t('text.color')}</h3>
        <ColorSwatches docColors={docColors} current={toHex(styles.color) ?? toHex(newColor)} onPick={pick} />
      </section>
    </div>
  );
}
