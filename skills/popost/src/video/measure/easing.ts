/**
 * The closest named easing of a measured move. The move's progress (0 at its first frame, 1 where it comes to rest)
 * is held against a named set by least squares: linear, power1-4 in / out / inOut, sine, expo, circ, back.out with
 * its overshoot amount, elastic.out, bounce.out, and a spring with its damping ratio and stiffness. A spring is a
 * closed form of the time, so any frame can be drawn on its own.
 *
 * The idea and the set of power, back and elastic curves follow the `measure curve` command of HyperFrames
 * (https://github.com/heygen-com/hyperframes, packages/cli/src/measure/curve.ts, Copyright HeyGen, Apache-2.0),
 * adapted to this engine's Runtime; bounce, expo.in / inOut and the spring family with its fitted damping are added
 * here, with the names of the Skill's motion helper (assets/video/motion.js) beside GSAP's.
 */

export type EaseFn = (u: number) => number;
export interface NamedEase {
  /** The name the Skill's motion helper takes: popostMotion.ease(name). */
  name: string;
  /** The nearest GSAP ease string. exact: GSAP has this curve; false: the nearest built-in. */
  gsap: string;
  exact: boolean;
  f: EaseFn;
}

/**
 * A spring from rest at 0 to rest at 1, mass 1, time in units of the move's length: damping is the damping ratio
 * (1 never overshoots, 0.5 overshoots by 16%, 0.2 rings), stiffness the spring constant (the natural frequency is
 * its square root, in radians per move length: 100 gives about one and a half swings).
 */
export const spring = (damping: number, stiffness: number): EaseFn => {
  const w = Math.sqrt(Math.max(1e-6, stiffness)), z = Math.max(0.01, damping);
  return (u) => {
    if (u <= 0) return 0;
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + ((z * w) / wd) * Math.sin(wd * u));
    }
    return 1 - Math.exp(-w * u) * (1 + w * u);
  };
};

export const bounceOut: EaseFn = (u) => {
  const n = 7.5625, d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) { const v = u - 1.5 / d; return n * v * v + 0.75; }
  if (u < 2.5 / d) { const v = u - 2.25 / d; return n * v * v + 0.9375; }
  const v = u - 2.625 / d;
  return n * v * v + 0.984375;
};

export const backOut = (s: number): EaseFn => (u) => 1 + (s + 1) * (u - 1) ** 3 + s * (u - 1) ** 2;
export const elasticOut = (p: number): EaseFn => (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin(((u - p / 4) * 2 * Math.PI) / p) + 1);

const r1 = (v: number): number => Math.round(v * 10) / 10;
const same = (name: string, f: EaseFn): NamedEase => ({ name, gsap: name === 'linear' ? 'none' : name, exact: true, f });

const powers = (): NamedEase[] => [1, 2, 3, 4].flatMap((k) => [
  same('power' + k + '.in', (u) => u ** (k + 1)),
  same('power' + k + '.out', (u) => 1 - (1 - u) ** (k + 1)),
  same('power' + k + '.inOut', (u) => (u < 0.5 ? 2 ** k * u ** (k + 1) : 1 - (-2 * u + 2) ** (k + 1) / 2)),
]);

/** The GSAP ease nearest to a spring: back.out for one overshoot, elastic.out when it rings. */
const springGsap = (damping: number, stiffness: number): string => {
  if (damping >= 0.95) return 'power3.out';
  const over = Math.exp((-damping * Math.PI) / Math.sqrt(1 - damping * damping));
  if (damping >= 0.45) return 'back.out(' + r1(Math.min(4, Math.max(0.5, over * 14))) + ')';
  return 'elastic.out(1,' + r1(Math.min(1, Math.max(0.2, (2 * Math.PI) / Math.sqrt(stiffness)))) + ')';
};

const springs = (): NamedEase[] => [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].flatMap((z) =>
  [40, 60, 90, 130, 180, 250, 350, 500, 700, 1000, 1500].map((k): NamedEase => ({ name: 'spring(' + z + ',' + k + ')', gsap: springGsap(z, k), exact: false, f: spring(z, k) })));

/** The named set, in the order ties are broken: the plain curves first. */
export const EASES: readonly NamedEase[] = [
  same('linear', (u) => u),
  ...powers(),
  same('sine.out', (u) => Math.sin((u * Math.PI) / 2)),
  same('sine.inOut', (u) => -(Math.cos(Math.PI * u) - 1) / 2),
  same('expo.in', (u) => (u <= 0 ? 0 : 2 ** (10 * u - 10))),
  same('expo.out', (u) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u))),
  same('expo.inOut', (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 ** (20 * u - 10) / 2 : (2 - 2 ** (-20 * u + 10)) / 2)),
  same('circ.out', (u) => Math.sqrt(1 - (u - 1) ** 2)),
  ...Array.from({ length: 26 }, (_v, i) => { const s = r1(0.5 + i * 0.1); return same('back.out(' + s + ')', backOut(s)); }),
  ...[0.2, 0.25, 0.3, 0.4, 0.5].map((p) => same('elastic.out(1,' + p + ')', elasticOut(p))),
  same('bounce.out', bounceOut),
  ...springs(),
];

/** The ease of a name of the set (also any spring(damping,stiffness) and back.out(s)); undefined for a name it does not know. */
export const easeNamed = (name: string): EaseFn | undefined => {
  const hit = EASES.find((e) => e.name === name);
  if (hit) return hit.f;
  const m = /^(spring|back\.out|elastic\.out)\(([^)]*)\)$/.exec(name.replace(/\s+/g, ''));
  const args = m?.[2]?.split(',').map(Number) ?? [];
  if (!m || args.some((v) => !Number.isFinite(v))) return undefined;
  if (m[1] === 'spring' && args.length === 2) return spring(args[0] as number, args[1] as number);
  if (m[1] === 'back.out' && args.length === 1) return backOut(args[0] as number);
  if (m[1] === 'elastic.out' && args.length === 2) return elasticOut(args[1] as number);
  return undefined;
};

export interface EaseFit {
  /** The helper's name of the closest ease, and the GSAP string to paste (gsapExact: false when it is only the nearest built-in). */
  ease: string;
  gsap: string;
  gsapExact: boolean;
  /** Root mean square error of the fit, in units of the move (0.02 is a close fit, 0.1 a loose one). */
  error: number;
  /** The next two, with their errors, to see how clear the choice is. */
  next: { ease: string; error: number }[];
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The closest ease of a move's progress, sampled evenly over its length (first value 0, last 1). A family is
 * preferred to a neighbour only when it fits clearly better: a spring must beat the best plain curve by a tenth of
 * its error, so that an ordinary ease-out is not called a spring.
 */
export const fitEase = (progress: readonly number[]): EaseFit => {
  const n = Math.max(1, progress.length - 1);
  const scored = EASES.map((e, order) => {
    let sum = 0;
    progress.forEach((p, i) => { sum += (p - e.f(i / n)) ** 2; });
    const rmse = Math.sqrt(sum / Math.max(1, progress.length));
    // Springs carry two free numbers; a plain curve within a tenth of a spring's error wins.
    return { e, rmse, key: e.name.startsWith('spring(') ? rmse * 1.1 + 0.002 : rmse, order };
  }).sort((a, b) => a.key - b.key || a.order - b.order);
  const best = scored[0] as (typeof scored)[number];
  // The next two of other families: twenty back.out curves in a row say nothing.
  const family = (name: string): string => name.replace(/\(.*\)$/, '').replace(/\d/, '');
  const next: { ease: string; error: number }[] = [];
  for (const s of scored.slice(1)) {
    if (next.length >= 2) break;
    if (family(s.e.name) !== family(best.e.name) && !next.some((x) => family(x.ease) === family(s.e.name))) next.push({ ease: s.e.name, error: r3(s.rmse) });
  }
  return { ease: best.e.name, gsap: best.e.gsap, gsapExact: best.e.exact, error: r3(best.rmse), next };
};
