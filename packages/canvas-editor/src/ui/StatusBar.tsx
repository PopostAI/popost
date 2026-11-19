import type { EditorSnapshot } from '../contracts';
import type { Actions } from './actions';
import { Icon } from './icons';
import { useT } from './i18n';
import { ZOOM_MAX, ZOOM_MIN } from './logic/zoom';
import type { ZoomState } from './use-zoom';

interface Props {
  snap: EditorSnapshot;
  zoom: ZoomState;
  actions: Actions;
}

/** Bottom bar: page navigation and zoom. */
export function StatusBar({ snap, zoom, actions }: Props) {
  const t = useT();
  const at = snap.pages.findIndex((p) => p.id === snap.currentPageId);
  const total = snap.pages.length;

  return (
    <div className="statusbar">
      <div className="sb-group">
        <button type="button" id="btn-prev-page" className="tb-btn small" disabled={at <= 0} title={t('pages.prev')} aria-label={t('pages.prev')} onClick={() => actions.changePage('prev')}>
          <Icon name="prev" size={14} />
        </button>
        <span id="page-counter" className="page-counter">
          {t('pages.counter', { n: at + 1, total })}
        </span>
        <button type="button" id="btn-next-page" className="tb-btn small" disabled={at < 0 || at >= total - 1} title={t('pages.next')} aria-label={t('pages.next')} onClick={() => actions.changePage('next')}>
          <Icon name="next" size={14} />
        </button>
      </div>

      <div className="sb-spacer" />

      <div className="sb-group zoom-group">
        <button type="button" className="tb-btn small" aria-label={t('zoom.out')} disabled={zoom.percent <= ZOOM_MIN} onClick={() => zoom.step(-1)}><Icon name="minus" size={15} /></button>
        <button type="button" className="tb-btn small" aria-label={t('zoom.in')} disabled={zoom.percent >= ZOOM_MAX} onClick={() => zoom.step(1)}><Icon name="plus" size={15} /></button>
        <input
          id="zoom-slider"
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={Math.round(zoom.percent)}
          aria-label={t('zoom.slider')}
          onChange={(e) => zoom.set(Number(e.currentTarget.value))}
        />
        <button type="button" id="zoom-label" className="zoom-label" title={t('zoom.fit')} onClick={zoom.fit}>
          {Math.round(zoom.percent)}%
        </button>
      </div>
    </div>
  );
}
