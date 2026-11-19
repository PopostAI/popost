import { describe, expect, it } from 'vitest';
import { referenceForPage } from './reference-comparison';

describe('reference page correspondence', () => {
  const images = [{ src: '/first.png', name: 'First' }, { src: '/second.png', name: 'Second' }];
  it('follows the selected page in both directions', () => {
    expect(referenceForPage(images, 0)).toBe(images[0]);
    expect(referenceForPage(images, 1)).toBe(images[1]);
    expect(referenceForPage(images, 0)).toBe(images[0]);
  });
  it('keeps extra design pages and empty projects free of unrelated references', () => {
    expect(referenceForPage(images, 2)).toBeNull();
    expect(referenceForPage(images, -1)).toBeNull();
    expect(referenceForPage([], 0)).toBeNull();
  });
});
