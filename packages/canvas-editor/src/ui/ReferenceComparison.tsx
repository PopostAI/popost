import { useEffect, useState } from 'react';
import { hostProject, projectRequest, type ProjectImage } from '../host/project-tools';
import { referenceForPage } from './logic/reference-comparison';
import { Icon } from './icons';
import { useT } from './i18n';
import '../styles/comparison.css';

export interface ReferenceImagesState {
  images: readonly ProjectImage[];
  status: 'loading' | 'ready' | 'failed';
  retry(): void;
}

export function useReferenceImages(localComparison: boolean): ReferenceImagesState {
  const [state, setState] = useState<Pick<ReferenceImagesState, 'images' | 'status'>>({ images: [], status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!localComparison && !hostProject()) return;
    let active = true;
    const load = localComparison
      ? fetch('/api/comparison', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) throw new Error('Reference images unavailable');
          return ((await response.json()) as { items: ProjectImage[] }).items;
        })
      : projectRequest<ProjectImage[]>('references', undefined, 10000);
    void load.then((images) => {
      if (active) setState({ images: images.filter((image) => typeof image?.src === 'string'), status: 'ready' });
    }).catch(() => { if (active) setState({ images: [], status: 'failed' }); });
    return () => { active = false; };
  }, [attempt, localComparison]);
  return { ...state, retry: () => { setState({ images: [], status: 'loading' }); setAttempt((value) => value + 1); } };
}

export function ReferencePane({ state, pageIndex, pageKey, scale }: {
  state: ReferenceImagesState; pageIndex: number; pageKey: string | null; scale: number;
}) {
  const t = useT();
  const image = referenceForPage(state.images, pageIndex, pageKey);
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const width = image?.width || (natural && natural.src === image?.src ? natural.width : 0) || 1080;
  const height = image?.height || (natural && natural.src === image?.src ? natural.height : 0) || 1440;
  return (
    <section className="comparison-reference" aria-label={t('compare.reference')} style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}>
      <div className="comparison-caption">
        <span>{t('compare.reference')}</span>
        <span>{t('compare.page', { n: pageIndex + 1 })} · {t('compare.readonly')}</span>
      </div>
      {image ? <ReferenceImage key={image.src} image={image} onSize={(width, height) => setNatural({ src: image.src, width, height })} /> : (
        <div className="comparison-empty" role="status">
          <Icon name="image" size={28} />
          <strong>{t(state.status === 'loading' ? 'compare.loading' : state.status === 'failed' ? 'compare.failed' : 'compare.empty')}</strong>
          {state.status === 'failed' ? <button type="button" className="tb-btn outlined" onClick={state.retry}>{t('compare.retry')}</button> : <span>{t('compare.emptyHint')}</span>}
        </div>
      )}
    </section>
  );
}

function ReferenceImage({ image, onSize }: { image: ProjectImage; onSize: (width: number, height: number) => void }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  return failed ? <div className="comparison-empty"><Icon name="image" size={28} /><span>{t('compare.imageFailed')}</span><button type="button" className="tb-btn outlined" onClick={() => setFailed(false)}>{t('compare.retry')}</button></div>
    : <img className="comparison-image" src={image.src} alt={image.name || t('compare.reference')} draggable={false} onLoad={(event) => onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => setFailed(true)} />;
}
