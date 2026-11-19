import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudAdapter, CloudMode, CloudStatus, EditorSnapshot } from '../contracts';
import { Icon } from './icons';
import { dictionaries, useLang, useT } from './i18n';
import type { MessageKey, TFunction } from './i18n';

const POLL_MS = 2000;

export interface CloudViewProps {
  mode: CloudMode;
  status: CloudStatus | null;
  /** The login address of a started login, shown when no window could be opened. */
  link: string | null;
  copied: boolean;
  /** `push`: an upload is running; `start`: the login address is being prepared. */
  busy: 'push' | 'start' | null;
  onStart(): void;
  onPush(force: boolean): void;
  onRetry(): void;
  onCopy(): void;
}

/** User-readable text for a failure code; an unknown code gets the generic text (the raw message goes to the tooltip). */
export function failureText(t: TFunction, code: string | undefined): string {
  const key = `cloud.error.${code ?? ''}` as MessageKey;
  return key in dictionaries.en ? t(key) : t('cloud.error.generic');
}

function OpenLink({ href, t }: { href: string | undefined; t: TFunction }) {
  if (!href) return null;
  return <a className="cloud-link" href={href} target="_blank" rel="noopener noreferrer" title={t('cloud.openTitle')}>{t('cloud.open')}</a>;
}

/** What the button area shows for a status; pure, so every state can be rendered without a server. */
export function CloudView({ mode, status, link, copied, busy, onStart, onPush, onRetry, onCopy }: CloudViewProps) {
  const t = useT();
  const state = busy === 'push' ? 'uploading' : busy === 'start' ? 'starting' : (status?.state ?? 'idle');
  const label = (key: MessageKey) => <span className="tb-label">{t(key)}</span>;
  if (state === 'uploading')
    return <span className="cloud-state" role="status"><i className="spinner small" />{t(mode === 'keyed' ? 'cloud.syncing' : 'cloud.uploading')}</span>;
  if (state === 'starting')
    return <span className="cloud-state" role="status"><i className="spinner small" />{t('cloud.waiting')}</span>;
  if (state === 'waiting')
    return (
      <>
        <span className="cloud-state" role="status"><i className="spinner small" />{t('cloud.waiting')}</span>
        <button type="button" className="tb-btn outlined cloud-copy" onClick={onCopy}>{copied ? t('cloud.linkCopied') : t('cloud.copyLink')}</button>
        {link && <input className="cloud-link-input" readOnly value={link} aria-label={t('cloud.loginLink')} onFocus={(e) => e.currentTarget.select()} />}
      </>
    );
  if (state === 'saved')
    return <span className="cloud-state" role="status"><Icon name="check" size={14} />{t(mode === 'keyed' ? 'cloud.synced' : 'cloud.saved')}<OpenLink href={status?.webUrl} t={t} /></span>;
  if (state === 'failed')
    return (
      <>
        <span className="cloud-state cloud-error" role="status" title={status?.error?.message}>{failureText(t, status?.error?.code)}</span>
        <button type="button" className="tb-btn outlined" onClick={onRetry}>{t('cloud.retry')}</button>
      </>
    );
  if (state === 'conflict')
    return (
      <>
        <span className="cloud-state cloud-error" role="status">{t('cloud.conflict')}<OpenLink href={status?.webUrl} t={t} /></span>
        {/* Overwriting edits made on the web needs the user's key: a one-time upload credential may not do it. */}
        {mode === 'keyed' ? <button type="button" className="tb-btn outlined" title={t('cloud.overwriteTitle')} onClick={() => onPush(true)}>{t('cloud.overwrite')}</button> : null}
      </>
    );
  if (mode === 'keyed')
    return <button type="button" className="tb-btn outlined cloud-btn" onClick={() => onPush(false)}><Icon name="cloud" />{label('cloud.syncNow')}</button>;
  const pendingChanges = Boolean(status?.webUrl && status.dirty);
  return (
    <button type="button" className="tb-btn outlined cloud-btn" title={t('cloud.tooltip')} aria-label={t('cloud.save')} onClick={onStart}>
      <Icon name="cloud" />
      <span className="tb-label">{t(pendingChanges ? 'cloud.dirty' : 'cloud.save')}</span>
    </button>
  );
}

const failureOf = (error: unknown): CloudStatus['error'] => ({ code: error instanceof Error && 'status' in error ? 'ERROR' : 'NETWORK', message: error instanceof Error ? error.message : String(error) });

/**
 * "Save to Cloud" (no popost key) or the sync indicator (key configured) at the right of the top bar. Rendered only when the
 * store offers cloud save. It polls the local server every 2 s while a login or upload is in progress.
 */
export function CloudButton({ cloud, saveState, saveLocal }: {
  cloud: CloudAdapter;
  saveState: EditorSnapshot['saveState'];
  saveLocal(): Promise<boolean>;
}) {
  const lang = useLang();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [failure, setFailure] = useState<CloudStatus['error']>();
  const [busy, setBusy] = useState<CloudViewProps['busy']>(null);
  const [link, setLink] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const lastAction = useRef<'start' | 'push'>('push');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await cloud.status();
      if (alive.current) setStatus(next);
    } catch {
      /* the next poll or action reports it */
    }
  }, [cloud]);
  // after every save of the editor: the local server marks the project as having changes (and a keyed one starts syncing)
  useEffect(() => void refresh(), [refresh, saveState]);

  const active = busy !== null || status?.state === 'waiting' || status?.state === 'uploading' || (cloud.mode === 'keyed' && status?.state === 'idle' && status.dirty);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const start = useCallback(async () => {
    // Opened inside the click so a popup blocker allows it; pointed at the login page once the address is known.
    const win = window.open('about:blank', '_blank');
    lastAction.current = 'start';
    setFailure(undefined);
    setCopied(false);
    setBusy('start');
    try {
      if (!await saveLocal()) {
        win?.close();
        setFailure({ code: 'LOCAL_SAVE_FAILED', message: '' });
        return;
      }
      const { authorizeUrl } = await cloud.start(lang);
      setLink(authorizeUrl);
      setShowLink(!win);
      if (win) {
        win.opener = null;
        win.location.href = authorizeUrl;
      }
      lastAction.current = 'push'; // a later failure comes from the upload, which keeps its credential for a retry
      await refresh();
    } catch (error) {
      win?.close();
      setFailure(failureOf(error));
    } finally {
      setBusy(null);
    }
  }, [cloud, lang, refresh, saveLocal]);

  const push = useCallback(async (force: boolean) => {
    lastAction.current = 'push';
    setFailure(undefined);
    setBusy('push');
    try {
      if (!await saveLocal()) {
        setFailure({ code: 'LOCAL_SAVE_FAILED', message: '' });
        return;
      }
      const next = await cloud.push({ force, lang });
      if (next.ok === false && next.error?.code === 'LOGIN_REQUIRED') {
        setBusy(null);
        await start();
        return;
      }
      if (alive.current) setStatus(next);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(null);
    }
  }, [cloud, lang, saveLocal, start]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(link ?? '');
      setCopied(true);
    } catch {
      setShowLink(true); // the address is shown in a field for a manual copy
    }
  }, [link]);

  const base: CloudStatus = status ?? { ok: false, mode: cloud.mode, state: 'idle', dirty: true };
  const shown: CloudStatus | null = failure ? { ...base, state: 'failed', error: failure } : status;
  const needsLogin = cloud.mode === 'anonymous' && (shown?.error?.code === 'UNAUTHORIZED' || shown?.error?.code === 'LOGIN_REQUIRED');
  const retry = () => void (needsLogin || lastAction.current === 'start' ? start() : push(false));
  return (
    <div className="cloud">
      <CloudView mode={cloud.mode} status={shown} link={showLink && status?.state === 'waiting' ? link : null} copied={copied} busy={busy} onStart={() => void start()} onPush={(force) => void push(force)} onRetry={retry} onCopy={() => void copy()} />
    </div>
  );
}
