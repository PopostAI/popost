/**
 * What TEMPLATE.md says of each shot's reading (elements.json, carried into template.json): its layout, the layers to
 * keep, the places to fill with the new subject, the layers dropped, a change in that is an effect of its own and which
 * scene draws it, the captions' style and the marks. Three levels, as the card's budget allows: a few lines per shot,
 * one clause per shot, or the layout alone; an effect of its own and a dropped layer are named at every level, and the
 * looks themselves stay in template.json. Pure.
 */
import type { Template, TemplateShot } from './types';

/** How much the card says of a shot's reading. */
export type ElementsDetail = 'full' | 'short' | 'kinds';

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const ids = (xs: readonly { id: string }[]): string => xs.map((x) => x.id).join(', ');

/** Who draws an effect of its own, in a few words. */
const drawnBy = (s: TemplateShot): string => (s.effect?.by === 'before' ? 'drawn by the scene of the shot before, which runs on over this one' : 'drawn by this shot\'s scene from its first frame');

/** The reading of one shot: a clause for the shot's line, and lines under it at the fullest level. picture: how a picture's path is shown. */
export const elementsText = (s: TemplateShot, d: ElementsDetail, picture: (p: string) => string): { clause: string; lines: string[] } => {
  const e = s.elements, fx = s.effect;
  const effect = fx ? 'custom in, ' + drawnBy(s) : '';
  const runs = e?.runsOn ? 'its motion runs on into the next shot' : '';
  const dropped = e?.dropped.length ? 'drop ' + ids(e.dropped) : '';
  const where = fx?.picture ? ' (' + picture(fx.picture) + ')' : '';
  if (!e && !fx) return { clause: '', lines: [] };
  if (d === 'kinds') {
    const brief = fx ? 'custom in, drawn by ' + (fx.by === 'before' ? 'the scene before it' : 'its scene') + where : '';
    return { clause: [e ? clip(e.layout, 40) : '', brief, e?.runsOn ? 'runs on' : '', dropped].filter(Boolean).map((x) => '; ' + x).join(''), lines: [] };
  }
  if (d === 'short') {
    const parts = [e ? 'layout ' + clip(e.layout, 40) : '', e?.design.length ? 'keep ' + ids(e.design) : '', e?.content.length ? 'replace ' + ids(e.content) : '', dropped,
      fx ? effect + ': ' + clip(fx.description, 70) + where : '', runs];
    return { clause: parts.filter(Boolean).map((x) => '; ' + x).join(''), lines: [] };
  }
  const look = (xs: readonly { id: string; look?: string; content?: string }[], key: 'look' | 'content'): string => xs.map((x) => x.id + (x[key] ? ' (' + clip(x[key] ?? '', 40) + ')' : '')).join(', ');
  const lines = [
    ...(e ? ['   layout: ' + e.layout + (e.job ? '; job: ' + clip(e.job, 50) : '')] : []),
    ...(e?.design.length ? ['   keep: ' + look(e.design, 'look')] : []),
    ...(e?.content.length ? ['   replace: ' + look(e.content, 'content')] : []),
    ...(e?.dropped.length ? ['   drop (never re-made): ' + e.dropped.map((x) => x.id + ' (' + x.role + ')').join(', ')] : []),
    ...(fx ? ['   in: custom ' + fx.frames + 'f, ' + drawnBy(s) + ': ' + clip(fx.description, 160) + where + '; measured as ' + fx.measured] : []),
    ...(e?.runsOn ? ['   ' + runs] : []),
    ...(e?.captions ? ['   captions: ' + clip(e.captions.base, 60) + (e.captions.highlight ? '; highlight: ' + clip(e.captions.highlight, 60) : '') + (e.captions.reveal ? '; reveal: ' + clip(e.captions.reveal, 40) : '')] : []),
    ...(e?.emphasis ?? []).map((m) => '   mark: ' + m.what + ' on ' + clip(m.on, 30) + (m.why ? ', because ' + clip(m.why, 60) : '')),
  ];
  return { clause: '', lines };
};

/** The lines the card's header adds for a reading: where the looks are, and the shots dropped whole. */
export const readingNotes = (tpl: Template): string[] => {
  const read = tpl.shots.some((s) => s.elements);
  const marked = tpl.shots.some((s) => s.elements?.emphasis?.length);
  const worded = tpl.shots.some((s) => (s.elements?.captions?.highlight && !/^(none|no)\b/i.test(s.elements.captions.highlight)) || s.elements?.captions?.reveal);
  const dropped = tpl.dropped ?? [];
  return [
    ...(read ? ['Each shot keeps its layout: find material of the new subject for it, never another layout. Layers (box, look) are in template.json shots[k].elements: keep "design", fill "replace", never draw "drop".'] : []),
    ...(marked ? ['A mark keeps its kind and look and goes on what the new line says: the new subject\'s strongest point for the beat\'s job.'] : []),
    ...(worded ? ['Captions: *mark* stressed words (highlight); "captionReveal": "words" (reveal).'] : []),
    ...(dropped.length ? ['The reference\'s shot' + (dropped.length > 1 ? 's ' : ' ') + dropped.map((x) => x.shot + ' (' + x.seconds.join('-') + ' s' + (x.reason ? ', ' + clip(x.reason, 100) : '') + ')').join(', ') + (dropped.length > 1 ? ' are' : ' is') + ' left out: shots[' + (tpl.shots.length - 1) + '] is the re-make\'s own closing.'] : []),
  ];
};
