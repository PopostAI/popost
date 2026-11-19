import { Icon } from '../icons';
import { downloadTextFile, exportFileName, makeStaticHtml } from '../../app/static-html';
import { useCallback, useEffect, useRef, useState } from 'react';
import CodeMirror from 'codemirror';
import type { Editor } from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/xml/xml';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/css/css';
import 'codemirror/mode/htmlmixed/htmlmixed';
import type { EditorController } from '../../contracts';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { readableCode } from '../logic/readable-code';
import { maskLongData } from '../logic/code-mask';
import type { MaskedSource } from '../logic/code-mask';
import { useSnapshot } from '../use-snapshot';

type Status = { key: MessageKey; error?: boolean; raw?: string };

const ERROR_KEYS: Record<string, MessageKey> = {
  empty: 'code.err.empty',
  'too-large': 'code.err.too-large',
  'no-slide': 'code.err.no-slide',
  unsafe: 'code.err.unsafe',
  rejected: 'code.err.rejected',
  'not-ready': 'code.err.rejected',
};

/**
 * Source editor (CodeMirror 5 on `#canvas-code-source`). Long base64 payloads are shown as placeholders and restored on
 * save. The editor reloads when the document changes elsewhere, unless there are unsaved code edits.
 */
export function CodePanel({ controller, onClose }: { controller: EditorController; onClose(): void }) {
  const t = useT();
  const snap = useSnapshot(controller);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cm = useRef<Editor | null>(null);
  const base = useRef<MaskedSource | null>(null);
  const loading = useRef(false);
  const dirtyRef = useRef(false);
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [status, setStatus] = useState<Status>({ key: 'code.status.idle' });

  const setDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  }, []);

  /** Show the current document source (masked) in the editor. */
  const load = useCallback(() => {
    const editor = cm.current;
    if (!editor) return;
    const masked = maskLongData(readableCode(controller.index()));
    base.current = masked;
    loading.current = true;
    editor.setValue(masked.text);
    loading.current = false;
    setDirty(false);
  }, [controller, setDirty]);

  const saveCode = useCallback(async (): Promise<void> => {
    const editor = cm.current;
    const masked = base.current;
    if (!editor || !masked || !dirtyRef.current || busy) return;
    setBusy(true);
    try {
      const error = controller.replaceSource(masked.restore(editor.getValue()));
      if (error !== null) {
        const key = ERROR_KEYS[error];
        setStatus(key ? { key, error: true } : { key: 'code.err.rejected', error: true, raw: error });
        return;
      }
      load();
      await controller.save();
      const s = controller.getSnapshot();
      setStatus(s.saveState === 'saved' ? { key: 'code.status.saved' } : { key: 'code.status.appliedUnsaved', error: s.saveState === 'error' });
    } finally {
      setBusy(false);
    }
  }, [busy, controller, load]);
  const saveRef = useRef(saveCode);
  saveRef.current = saveCode;

  // Create the editor once.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return undefined;
    const editor = CodeMirror.fromTextArea(area, {
      mode: 'htmlmixed',
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: 10,
      extraKeys: { 'Ctrl-S': () => void saveRef.current(), 'Cmd-S': () => void saveRef.current() },
    });
    cm.current = editor;
    editor.on('change', () => {
      if (loading.current) return;
      setDirty(true);
      setStatus({ key: 'code.status.dirty' });
    });
    load();
    const host = hostRef.current;
    const observer = host && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => editor.refresh()) : null;
    if (host) observer?.observe(host);
    const frame = requestAnimationFrame(() => editor.refresh());
    const timer = setTimeout(() => editor.refresh(), 230);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer?.disconnect();
      editor.toTextArea();
      cm.current = null;
    };
  }, [load, setDirty]);

  // The document changed elsewhere (canvas edit, undo, reload): follow it unless code edits are pending.
  const seen = useRef(snap.sourceVersion);
  useEffect(() => {
    if (seen.current === snap.sourceVersion) return;
    seen.current = snap.sourceVersion;
    if (!dirtyRef.current) load();
  }, [snap.sourceVersion, load]);

  const toggleWrap = () => {
    cm.current?.setOption('lineWrapping', !wrap);
    setWrap(!wrap);
  };

  const copy = async () => {
    const editor = cm.current;
    if (!editor || !base.current) return;
    try {
      await navigator.clipboard.writeText(base.current.restore(editor.getValue()));
      setStatus({ key: 'code.status.copied' });
    } catch {
      setStatus({ key: 'code.status.copyFailed', error: true });
    }
  };

  const statusText = status.raw ? `${t(status.key)}: ${status.raw}` : t(status.key);
  return (
    <>
      <div className="panel-head">
        <h2>{t('panel.code')}</h2>
        <div className="code-header-tools">
          <button type="button" className="tb-btn small" onClick={toggleWrap}>
            <Icon name="wrap" size={14} />{t(wrap ? 'code.disableWrap' : 'code.enableWrap')}
          </button>
          <button type="button" className="tb-btn small" disabled={snap.docState !== 'ready'} onClick={() => void copy()}><Icon name="duplicate" size={14} />{t('code.copy')}</button>
          <button type="button" id="panel-close" className="tb-btn small" title={t('panel.close')} aria-label={t('panel.close')} onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
      </div>
      <div className="panel-body code-panel" data-panel-body="code">
        <div ref={hostRef} className="code-host">
          <textarea id="canvas-code-source" ref={areaRef} defaultValue="" spellCheck={false} />
        </div>
        <div id="code-status" className={`code-status${status.error ? ' error' : ''}`} role="status">
          {statusText}
        </div>
        <div className="code-actions">
          <button type="button" id="code-save" className="btn primary" disabled={!dirty || busy} onClick={() => void saveCode()}>
            {busy ? t('code.saving') : t('code.save')}
            <i className="code-unsaved-dot" hidden={!dirty} />
          </button>
          <button type="button" id="code-download-html" className="btn" onClick={() => {
            const editor = cm.current;
            const masked = base.current;
            if (dirty && editor && masked) {
              downloadTextFile(exportFileName(snap.name), makeStaticHtml(masked.restore(editor.getValue())));
            } else controller.exportHTML();
            setStatus({ key: 'code.status.downloaded' });
          }}>
            {t('code.download')}
          </button>
        </div>
      </div>
    </>
  );
}
