/**
 * Transport: first / -10 / -1 / play / +1 / +10 / last, a frame slider, frame number and time, speed, a box to jump
 * to a frame, and the keyboard (Space, Left / Right, Shift+Left / Shift+Right, Home / End).
 */
import { SPEEDS, type Actions, type Store, type View } from './app';
import { h, icon } from './dom';
import { t, type Key } from './i18n';
import { formatTime, timelineFps, timelineFrames } from './model';

interface Controls {
  buttons: { el: HTMLButtonElement; title: Key }[];
  play: HTMLButtonElement;
  playIcon: HTMLElement;
  slider: HTMLInputElement;
  frameLabel: HTMLElement;
  frameNo: HTMLElement;
  frameOf: HTMLElement;
  time: HTMLElement;
  speedLabel: HTMLElement;
  speed: HTMLSelectElement;
  jump: HTMLInputElement;
}

const button = (c: Pick<Controls, 'buttons'>, id: string, title: Key, content: Node | string, run: () => void): HTMLButtonElement => {
  const el = h('button', { id, class: 'tbtn', attrs: { type: 'button' } }, [content]);
  // Blur after a click, so that Space keeps meaning play / pause instead of pressing the button again.
  el.addEventListener('click', () => {
    run();
    el.blur();
  });
  c.buttons.push({ el, title });
  return el;
};

/** Jumps to the frame typed in the box on Enter; a box that does not hold a whole number is marked invalid. */
const jumpBox = (actions: Actions): HTMLInputElement => {
  const jump = h('input', { id: 'jump', attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off' } });
  jump.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = Number(jump.value.trim());
    const valid = jump.value.trim() !== '' && Number.isInteger(n);
    jump.setAttribute('aria-invalid', String(!valid));
    if (!valid) return;
    actions.pause();
    actions.seek(n);
    jump.value = '';
    jump.blur();
  });
  return jump;
};

const speedList = (actions: Actions): HTMLSelectElement => {
  const speed = h('select', { id: 'speed' }, SPEEDS.map((s) => h('option', { text: s + 'x', attrs: { value: String(s) } })));
  speed.value = '1';
  speed.addEventListener('change', () => {
    actions.setSpeed(Number(speed.value));
    speed.blur();
  });
  return speed;
};

const build = (root: HTMLElement, actions: Actions): Controls => {
  const buttons: Controls['buttons'] = [];
  // Stepping and jumping stop playback, from the buttons as from the keyboard; the slider and the lanes seek and play on.
  const stopped = (run: () => void) => (): void => {
    actions.pause();
    run();
  };
  const playIcon = h('span', { class: 'icon' }, [icon('play')]);
  const slider = h('input', { id: 'slider', attrs: { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'frame' } });
  slider.addEventListener('input', () => actions.seek(Number(slider.value)));
  const c: Controls = {
    buttons, playIcon, slider, play: button({ buttons }, 'play', 'play', playIcon, () => actions.togglePlay()),
    frameLabel: h('span', { class: 'muted' }), frameNo: h('span', { id: 'frame-no', class: 'num' }), frameOf: h('span', { class: 'num muted' }),
    time: h('span', { id: 'time', class: 'num muted' }), speedLabel: h('label', { class: 'muted', attrs: { for: 'speed' } }), speed: speedList(actions), jump: jumpBox(actions),
  };
  root.append(
    button(c, 'first', 'first', icon('first'), stopped(() => actions.seek(0))),
    button(c, 'back10', 'back10', '−10', stopped(() => actions.step(-10))),
    button(c, 'back1', 'back1', '−1', stopped(() => actions.step(-1))),
    c.play,
    button(c, 'fwd1', 'fwd1', '+1', stopped(() => actions.step(1))),
    button(c, 'fwd10', 'fwd10', '+10', stopped(() => actions.step(10))),
    button(c, 'last', 'last', icon('last'), stopped(() => actions.seek(Number.MAX_SAFE_INTEGER))),
    h('div', { class: 'slider-wrap' }, [slider]),
    h('span', { class: 'readout' }, [h('span', {}, [c.frameLabel, c.frameNo, c.frameOf]), c.time]),
    h('span', { class: 'speed' }, [c.speedLabel, c.speed]),
    c.jump,
  );
  return c;
};

const update = (c: Controls, v: View, prev: View | undefined): void => {
  const frames = v.state ? timelineFrames(v.state) : 0;
  const fps = v.state ? timelineFps(v.state) : 30;
  c.slider.max = String(Math.max(0, frames - 1));
  c.slider.value = String(v.frame);
  c.frameNo.textContent = String(v.frame);
  c.frameOf.textContent = ' / ' + Math.max(0, frames - 1);
  c.time.textContent = formatTime(v.frame, fps) + ' / ' + formatTime(frames, fps);
  if (prev && v.playing === prev.playing && v.lang === prev.lang) return;
  c.playIcon.replaceChildren(icon(v.playing ? 'pause' : 'play'));
  c.buttons.forEach((b) => { b.el.title = t(v.lang, b.el === c.play ? (v.playing ? 'pause' : 'play') : b.title); });
  c.frameLabel.textContent = t(v.lang, 'frame') + ' ';
  c.speedLabel.textContent = t(v.lang, 'speed') + ' ';
  c.jump.placeholder = t(v.lang, 'jump');
  c.jump.title = t(v.lang, 'jumpHint');
};

/** Keys act everywhere except while typing in a text box or choosing in a list, and when edit mode took the key. */
const keyboard = (e: KeyboardEvent, actions: Actions): void => {
  const target = e.target as HTMLElement | null;
  if (e.defaultPrevented || target?.tagName === 'SELECT' || target?.tagName === 'TEXTAREA' || (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number'))) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const act: Readonly<Record<string, () => void>> = {
    ' ': () => actions.togglePlay(),
    ArrowLeft: () => { actions.pause(); actions.step(e.shiftKey ? -10 : -1); },
    ArrowRight: () => { actions.pause(); actions.step(e.shiftKey ? 10 : 1); },
    Home: () => { actions.pause(); actions.seek(0); },
    End: () => { actions.pause(); actions.seek(Number.MAX_SAFE_INTEGER); },
  };
  const run = act[e.key];
  if (!run) return;
  e.preventDefault();
  run();
};

export const mountTransport = (root: HTMLElement, store: Store, actions: Actions): void => {
  const c = build(root, actions);
  update(c, store.get(), undefined);
  store.subscribe((v, prev) => {
    if (v.frame !== prev.frame || v.state !== prev.state || v.playing !== prev.playing || v.lang !== prev.lang) update(c, v, prev);
  });
  document.addEventListener('keydown', (e) => keyboard(e, actions));
};
