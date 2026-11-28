/**
 * Captions stay legible when the reference's caption colour could not be measured: plain letters without a measured
 * colour are drawn as no measurement is, white with a dark outline, never bare white (which vanishes on a white page).
 */
import { describe, expect, it } from 'vitest';
import { captionStyle } from '../../src/video/retarget/caption-look';

describe('the caption style when the measurement is unsure', () => {
  it('outlines plain letters whose colour was not measured, as it does without a measurement', () => {
    const unsure = captionStyle({ kind: 'plain', samples: 12, confidence: 0, unsure: ['fill: not told'] }, {}, 0.05);
    expect(unsure).toEqual(captionStyle(undefined, {}, 0.05));
    expect(unsure.stroke?.color).toBe('#111111');
  });

  it('keeps plain letters of a measured colour plain, and the plan wins over both', () => {
    expect(captionStyle({ kind: 'plain', color: '#ffd21f', samples: 12, confidence: 0.9 }, {}, 0.05)).toEqual({ size: 0.05, weight: 800, color: '#ffd21f', align: 'center' });
    expect(captionStyle({ kind: 'plain', samples: 12 }, { captionColor: '#00ff00' }, 0.05).color).toBe('#00ff00');
  });
});
