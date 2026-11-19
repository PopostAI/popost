import { useCallback, useEffect, useRef, useState } from 'react';
import { clampZoom, fitZoom, stepZoom, wheelZoom } from './logic/zoom';

export interface ZoomState {
  /** Effective zoom in percent (fit result or the chosen value). */
  percent: number;
  fitting: boolean;
  /** Callback ref for the scrolling stage element (its size drives "fit"). */
  stageRef(el: HTMLDivElement | null): void;
  set(percent: number): void;
  fit(): void;
  step(direction: 1 | -1): void;
  wheel(deltaY: number): void;
  /** Current percent without re-rendering (for event handlers). */
  get(): number;
}

export function useZoom(page: { width: number; height: number }, comparing = false): ZoomState {
  const [mode, setMode] = useState<'fit' | number>('fit');
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const stageRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const read = (): void => setStage((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    read();
    if (typeof ResizeObserver === 'function') {
      observer.current = new ResizeObserver(read);
      observer.current.observe(el);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const viewport = comparing
    ? { width: (stage.width - 64 - 28) / 2 + 64, height: stage.height - 40 }
    : stage;
  const percent = mode === 'fit' ? fitZoom(viewport, page) : mode;
  const latest = useRef(percent);
  const destination = useRef<number | null>(null);
  const animation = useRef<number | null>(null);
  latest.current = percent;

  const cancel = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    destination.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const animate = useCallback((next: number) => {
    destination.current = next;
    if (animation.current !== null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      latest.current = next;
      destination.current = null;
      setMode(next);
      return;
    }
    const tick = () => {
      const target = destination.current;
      if (target === null) return;
      const delta = target - latest.current;
      const value = Math.abs(delta) < 0.12 ? target : latest.current + delta * 0.38;
      latest.current = value;
      setMode(value);
      if (value === target) {
        animation.current = null;
        destination.current = null;
      } else {
        animation.current = requestAnimationFrame(tick);
      }
    };
    animation.current = requestAnimationFrame(tick);
  }, []);

  const set = useCallback((value: number) => {
    cancel();
    setMode(clampZoom(value));
  }, [cancel]);
  const fit = useCallback(() => {
    cancel();
    setMode('fit');
  }, [cancel]);
  const step = useCallback((direction: 1 | -1) => {
    animate(stepZoom(destination.current ?? latest.current, direction));
  }, [animate]);
  const wheel = useCallback((deltaY: number) => {
    animate(wheelZoom(destination.current ?? latest.current, deltaY));
  }, [animate]);
  const get = useCallback(() => latest.current, []);
  return { percent, fitting: mode === 'fit', stageRef, set, fit, step, wheel, get };
}
