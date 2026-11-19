import { useEffect, useRef, useState } from 'react';
import type { EditorController } from '../../contracts';
import { readLocalBoot } from '../../host/params';
import { hostProject, projectRequest, type ProjectImage } from '../../host/project-tools';
import { docImages, fileToDataURL } from '../logic/images';
import { useImageError } from '../ImageTools';
import { useSnapshot } from '../use-snapshot';
import { useT } from '../i18n';
import { Icon } from '../icons';

interface AssetPage {
  readonly items: readonly ProjectImage[];
  readonly more: boolean;
}

const EMPTY: AssetPage = { items: [], more: false };

export function ImagePanel({ controller }: { controller: EditorController }) {
  const t = useT();
  const onError = useImageError();
  const snap = useSnapshot(controller);
  const hosted = Boolean(hostProject());
  const local = Boolean(readLocalBoot());
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const [selected, setSelected] = useState<ProjectImage | null>(null);
  const [current, setCurrent] = useState<AssetPage>(EMPTY);
  const [history, setHistory] = useState<AssetPage>(EMPTY);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hosted && !local) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    const load = local
      ? fetch(`/api/project-assets?tab=${tab}&page=${page}`, { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) throw new Error('Project assets unavailable');
          return await response.json() as AssetPage;
        })
      : projectRequest<AssetPage>('assets', { tab, page: tab === 'history' ? page : 1 });
    void load.then((data) => {
      if (!active) return;
      if (tab === 'current') setCurrent(data);
      else setHistory((prior) => ({ items: page === 1 ? data.items : [...prior.items, ...data.items], more: data.more }));
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [hosted, local, tab, page, retry]);

  const fromDocument = docImages(controller.index()).map(({ src }, i) => ({ src, name: `Image ${i + 1}` }));
  const items = tab === 'history' ? history.items : [...new Map([...fromDocument, ...current.items].map((item) => [item.src, item])).values()];
  const insert = (item: ProjectImage, pageId = controller.getSnapshot().currentPageId): void => {
    const page = controller.getSnapshot().pages.find((entry) => entry.id === pageId);
    if (!page) return;
    const img = document.createElement('img');
    img.setAttribute('src', local && item.src.startsWith('/assets/') ? '..' + item.src : item.src);
    img.alt = item.name;
    const width = Math.round(page.width * 0.46);
    img.style.cssText = `position:absolute;z-index:90;left:${Math.round(page.width * 0.1)}px;top:${Math.round(page.height * 0.12)}px;width:${width}px;height:auto;max-height:${Math.round(page.height * 0.7)}px;object-fit:contain`;
    controller.apply({ kind: 'insertHTML', parentId: page.id, beforeId: null, html: img.outerHTML }, { label: 'add image' });
  };
  return (
    <div className="image-panel" data-panel-body="images">
      <div className="panel-body">
        <div className="asset-tabs" role="tablist" aria-label={t('panel.images')}>
          {(['current', 'history'] as const).map((kind) => (
            <button type="button" role="tab" aria-selected={tab === kind} disabled={kind === 'history' && !hosted && !local} key={kind} onClick={() => { if (kind !== tab) setSelected(null); if (kind === 'history') setPage(1); setTab(kind); }}>{t(local && kind === 'history' ? 'assets.projectHistory' : `assets.${kind}`)}</button>
          ))}
          <button type="button" className="btn" disabled={uploading || snap.docState !== 'ready'} onClick={() => file.current?.click()}><Icon name="upload" size={13} />{t('assets.upload')}</button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(event) => {
            const selection = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!selection) return;
            const target = controller.getSnapshot().currentPageId;
            setUploading(true);
            const load = hosted ? projectRequest<ProjectImage>('upload-asset', selection, 180_000)
              : local && controller.uploadImage ? controller.uploadImage(selection)
              : fileToDataURL(selection).then((src) => ({ src, name: selection.name }));
            void load.then((item) => { insert(item, target); setPage(1); setRetry((value) => value + 1); }).catch(onError).finally(() => setUploading(false));
          }} />
        </div>
        {loading && <p role="status" className="p-hint">{t('status.loading')}</p>}
        {failed && <button type="button" className="btn" onClick={() => setRetry((value) => value + 1)}>{t('assets.failed')}</button>}
        {!loading && !failed && items.length === 0 && <p className="p-hint">{t('assets.empty')}</p>}
        <div className="asset-grid">
          {items.map((item) => <button key={item.src} type="button" title={item.name} aria-pressed={selected?.src === item.src} onClick={() => setSelected((prior) => prior?.src === item.src ? null : item)}><img src={item.src} alt={item.name} loading="lazy" /></button>)}
        </div>
        {tab === 'history' && history.more && <button type="button" className="btn" disabled={loading} onClick={() => setPage((value) => value + 1)}>{t('assets.more')}</button>}
      </div>
      {selected && <footer className="asset-confirm">
        <button type="button" className="btn primary" disabled={snap.docState !== 'ready' || !snap.currentPageId} onClick={() => {
          insert(selected);
          setSelected(null);
        }}>{t('assets.confirm')}</button>
      </footer>}
    </div>
  );
}
