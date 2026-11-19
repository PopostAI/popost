import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { exportDeck, EXPORT_FORMATS as FORMATS, type ExportFormat as Format, type ExportOptions } from '../export-deck';
import type { EditorController, EditorSnapshot } from '../contracts';
import { makeStaticHtml } from '../app/static-html';
import { buildPreview } from '../core/preview';
import { THUMB_CSS, alignThumb } from './Filmstrip';
import { readImageOrigins } from '../host/params';
import { isFromHost } from '../host/messaging';
import { hostProject, projectRequest } from '../host/project-tools';
import { useDismissable } from './dismiss';
import { Icon } from './icons';
import { useLang, useT } from './i18n';
import { useToast } from './toasts';

const LOCKED: readonly Format[] = ['svg', 'psd', 'pdf'];

type SelectMenu = { kind: 'format' | 'scale'; anchor: HTMLButtonElement; focusOptions: boolean };

export function ExportPanel({ controller, snap, customName, onNameChange, onClose, local }: {
  controller: EditorController; snap: EditorSnapshot; customName: string | null;
  onNameChange(name: string): void; onClose(): void; local: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const [excluded, setExcluded] = useState<readonly string[]>([]);
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(1);
  const name = customName ?? (snap.name || 'Popost');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const editNameButton = useRef<HTMLButtonElement>(null);
  const [premium, setPremium] = useState(false);
  const [menu, setMenu] = useState<SelectMenu | null>(null);
  const [upgrade, setUpgrade] = useState<Format | number | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, fraction: 0 });
  const pages = snap.pages.filter((page) => !excluded.includes(page.id));
  const representative = pages[0];
  const index = controller.index();
  const thumbnails = useMemo(() => snap.pages.map((page) => buildPreview(index, { frameCSS: THUMB_CSS, baseHref: location.origin + (local ? '/pages/' : '/'), imageOrigins: readImageOrigins(), currentPageId: page.id })), [index, snap.pages, local]);
  useEffect(() => {
    if (local) {
      let active = true;
      void fetch('/api/export-options', { cache: 'no-store' }).then((r) => r.json()).then((options: { premium?: boolean }) => {
        if (active) setPremium(options.premium === true);
      }).catch(() => {});
      return () => { active = false; };
    }
    let active = true;
    void projectRequest<{ premium: boolean }>('export-options').then((options) => {
      if (active) setPremium(options.premium);
    }).catch(() => {});
    const onProgress = (event: MessageEvent) => {
      if (!isFromHost(event, 'popost-workspace')) return;
      const data = event.data;
      if (data.type !== 'export-progress' || data.id !== hostProject()) return;
      setProgress({ completed: data.completed, total: data.total, fraction: data.fraction });
    };
    window.addEventListener('message', onProgress);
    return () => { active = false; window.removeEventListener('message', onProgress); };
  }, [local]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setUpgrade(null);
  }, []);
  useDismissable(menu !== null, () => {
    menu?.anchor.focus();
    closeMenu();
  });

  useLayoutEffect(() => {
    const options = optionsRef.current;
    const panel = panelRef.current;
    if (!menu || !options || !panel) return;
    const place = () => {
      const anchor = menu.anchor.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom) {
        closeMenu();
        return;
      }
      const gap = 6;
      const edge = 8;
      const width = Math.min(270, window.innerWidth - edge * 2);
      const below = window.innerHeight - anchor.bottom - gap - edge;
      const above = anchor.top - gap - edge;
      const opensUp = options.scrollHeight > below && above > below;
      Object.assign(options.style, {
        width: `${width}px`,
        left: `${Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge))}px`,
        maxHeight: `${Math.max(0, opensUp ? above : below)}px`,
        top: opensUp ? 'auto' : `${anchor.bottom + gap}px`,
        bottom: opensUp ? `${window.innerHeight - anchor.top + gap}px` : 'auto',
      });
    };
    place();
    panel.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !options.contains(event.target) && !menu.anchor.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    if (menu.focusOptions) options.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus();
    return () => {
      panel.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', dismissOutside, true);
    };
  }, [menu, closeMenu]);

  const finishNameEdit = (save: boolean, restoreFocus = false) => {
    const next = nameDraft?.trim();
    if (save && next) onNameChange(next);
    setNameDraft(null);
    if (restoreFocus) requestAnimationFrame(() => editNameButton.current?.focus());
  };

  const start = async () => {
    if (!pages.length || busy) return;
    controller.endTextEdit(true);
    setProgress({ completed: 0, total: pages.length, fraction: 0 });
    setBusy(true);
    closeMenu();
    try {
      const options: ExportOptions = {
        html: makeStaticHtml(controller.index().source),
        name: nameDraft?.trim() || name,
        pages: snap.pages.flatMap((page, index) => excluded.includes(page.id) ? [] : [index]),
        format,
        scale: format === 'html' ? 1 : scale,
      };
      if (local) {
        await exportDeck(options, (completed, total, fraction) => setProgress({ completed, total, fraction }), true);
      } else {
        await projectRequest('export', options, 300_000);
      }
      toast(t('export.done'), 'info');
      onClose();
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : t('export.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleMenu = (kind: SelectMenu['kind'], anchor: HTMLButtonElement, focusOptions: boolean) => {
    setMenu((current) => current?.kind === kind ? null : { kind, anchor, focusOptions });
    setUpgrade(null);
  };
  const lock = (id: Format | number, locked: boolean) => locked && (
    <button type="button" className="export-gem" aria-label={t('export.paid')} aria-expanded={upgrade === id}
      onMouseEnter={() => setUpgrade(id)} onFocus={() => setUpgrade(id)} onClick={() => setUpgrade(id)}>
      <Icon name="gem" size={15} />
    </button>
  );
  const choose = (id: Format | number, locked: boolean, action: () => void) => {
    if (locked) setUpgrade(id);
    else {
      action();
      if (menu?.focusOptions) menu.anchor.focus();
      closeMenu();
    }
  };
  const paidInfo = (id: Format | number) => upgrade === id && (
    <div className="export-upgrade">
      <span>{t('export.upgrade')}</span>
      <a href={local ? `https://popost.ai/${lang}/pricing` : `/${lang}/pricing`} target="_blank" rel="noopener noreferrer">{t('export.pricing')}</a>
    </div>
  );

  return (
    <div id="pop-export" ref={panelRef} className="popover export-panel" role="dialog" aria-label={t('topbar.export')}>
      <fieldset disabled={busy}>
        <section className="export-section">
          <div className="export-section-head">
            <strong>{t('export.pages', { n: pages.length, total: snap.pages.length })}</strong>
            <label><input type="checkbox" checked={excluded.length === 0} onChange={(event) => setExcluded(event.currentTarget.checked ? [] : snap.pages.map((page) => page.id))} />{t('export.all')}</label>
          </div>
          <div className="export-pages">
            {snap.pages.map((page, index) => {
              const zoom = Math.min(78 / page.width, 78 / page.height);
              const checked = !excluded.includes(page.id);
              return <button type="button" key={page.id} aria-pressed={checked} onClick={() => setExcluded((prior) => checked ? [...prior, page.id] : prior.filter((id) => id !== page.id))}>
                <span className="export-thumb">
                  <span style={{ width: page.width * zoom, height: page.height * zoom }}>
                    <iframe title={page.name} aria-hidden="true" tabIndex={-1} sandbox="allow-same-origin" onLoad={(event) => alignThumb(event.currentTarget)} srcDoc={thumbnails[index]} style={{ width: page.width, height: page.height, transform: `scale(${zoom})` }} />
                  </span>
                  {checked && <i><Icon name="check" size={12} /></i>}
                </span>
                <b>{page.name}</b><small>{page.width} × {page.height}</small>
              </button>;
            })}
          </div>
        </section>
        <section className="export-section export-settings">
          <div className="export-row">
            <span>{t('export.format')}</span>
            <button className="btn" type="button" aria-expanded={menu?.kind === 'format'} aria-controls={menu?.kind === 'format' ? 'export-options' : undefined} onClick={(event) => toggleMenu('format', event.currentTarget, event.detail === 0)}>{format.toUpperCase()} <Icon name="chevron" size={12} /></button>
          </div>
          <div className="export-row">
            <span>{t('export.resolution')}</span>
            <button className="btn" type="button" disabled={format === 'html'} aria-expanded={menu?.kind === 'scale'} aria-controls={menu?.kind === 'scale' ? 'export-options' : undefined} onClick={(event) => toggleMenu('scale', event.currentTarget, event.detail === 0)}>{t(scale === 1 || format === 'html' ? 'export.standard' : 'export.high')} · {format === 'html' ? 1 : scale}× <Icon name="chevron" size={12} /></button>
          </div>
          <div className="export-row">
            <span>{t('export.name')}</span>
            {nameDraft === null ? (
              <button type="button" className="btn export-name" ref={editNameButton} title={t('export.editName')} aria-label={t('export.editName')} onClick={() => setNameDraft(name)}>
                <span>{name}</span><Icon name="pencil" size={14} />
              </button>
            ) : (
              <form className="export-name-editor" onSubmit={(event) => {
                event.preventDefault();
                finishNameEdit(true, true);
              }} onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) finishNameEdit(true);
              }} onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
                event.stopPropagation();
                finishNameEdit(false, true);
              }}>
                <input autoFocus maxLength={160} aria-label={t('export.name')} value={nameDraft}
                  onFocus={(event) => event.currentTarget.select()} onChange={(event) => setNameDraft(event.currentTarget.value)} />
                <button type="submit" className="btn" onPointerDown={(event) => event.preventDefault()} title={t('export.confirmName')} aria-label={t('export.confirmName')}><Icon name="check" size={15} /></button>
              </form>
            )}
          </div>
        </section>
      </fieldset>
      <button type="button" className="btn export-start" disabled={busy || !pages.length} onClick={() => void start()}>
        {busy && <i style={{ width: `${Math.round(progress.fraction * 100)}%` }} />}
        <span>{busy ? t('export.progress', { percent: Math.round(progress.fraction * 100), done: progress.completed, total: progress.total }) : t('topbar.export')}</span>
      </button>
      {menu && createPortal(
        <div id="export-options" className="export-select" ref={optionsRef} role="group" aria-label={t(menu.kind === 'format' ? 'export.format' : 'export.resolution')}>
          {menu.kind === 'format' ? <>
            {FORMATS.map((value, index) => {
              const locked = LOCKED.includes(value) && !premium;
              return <div key={value}>
                {index === 0 || index === 4 ? <small className="export-category">{t(index === 0 ? 'export.imageFormats' : 'export.documentFormats')}</small> : null}
                <div className="export-option">
                  <button type="button" className="export-option-label" aria-pressed={value === format} onClick={() => choose(value, locked, () => setFormat(value))}>{value.toUpperCase()}</button>
                  {lock(value, locked)}
                </div>
                {paidInfo(value)}
              </div>;
            })}
          </> : <>
            {[1, 2, 3, 4].map((value) => {
              const locked = value > 1 && !premium;
              return <div key={value}>
                <div className="export-option">
                  <button type="button" className="export-option-label" aria-pressed={value === scale} onClick={() => choose(value, locked, () => setScale(value))}>
                    {t(value === 1 ? 'export.standard' : 'export.high')} · {value}×
                    {representative && <small>{representative.width * value} × {representative.height * value} px</small>}
                  </button>
                  {lock(value, locked)}
                </div>
                {paidInfo(value)}
              </div>;
            })}
          </>}
        </div>,
        document.body,
      )}
    </div>
  );
}
