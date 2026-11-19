import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_ORIGINS, parseImageOrigin, sanitizeImageOrigins } from './image-origins';

describe('parseImageOrigin', () => {
  it('accepts a bare https origin, with or without a port, and normalizes case and the default port', () => {
    expect(parseImageOrigin('https://img.example.com')).toBe('https://img.example.com');
    expect(parseImageOrigin('https://bucket.acct.r2.cloudflarestorage.com')).toBe('https://bucket.acct.r2.cloudflarestorage.com');
    expect(parseImageOrigin('https://cdn.example.com:8443')).toBe('https://cdn.example.com:8443');
    expect(parseImageOrigin('HTTPS://CDN.Example.COM')).toBe('https://cdn.example.com');
    expect(parseImageOrigin('https://cdn.example.com:443')).toBe('https://cdn.example.com');
    expect(parseImageOrigin(' https://cdn.example.com ')).toBe('https://cdn.example.com');
  });

  it.each([
    ['http scheme', 'http://img.example.com'],
    ['no scheme', 'img.example.com'],
    ['other scheme', 'data:'],
    ['wildcard host', 'https://*.example.com'],
    ['bare wildcard', '*'],
    ['https wildcard', 'https:'],
    ['path', 'https://img.example.com/bucket'],
    ['trailing slash', 'https://img.example.com/'],
    ['query', 'https://img.example.com?x=1'],
    ['fragment', 'https://img.example.com#x'],
    ['credentials', 'https://user:pass@img.example.com'],
    ['user only', 'https://user@img.example.com'],
    ['port out of range', 'https://img.example.com:99999'],
    ['port zero', 'https://img.example.com:0'],
    ['empty port', 'https://img.example.com:'],
    ['IPv6 literal', 'https://[::1]'],
    ['CSP delimiter', "https://a.example.com;img-src"],
    ['CSP quote', "https://a.example.com'"],
    ['space', 'https://a.example.com *'],
    ['underscore host', 'https://a_b.example.com'],
    ['empty label', 'https://a..example.com'],
    ['empty', ''],
  ])('rejects %s', (_name, value) => {
    expect(parseImageOrigin(value)).toBeNull();
  });
});

describe('sanitizeImageOrigins', () => {
  it('drops invalid entries, de-duplicates and keeps order', () => {
    expect(sanitizeImageOrigins(['https://a.example.com', 'http://b.example.com', '*', 'https://a.example.com', 'https://c.example.com'])).toEqual([
      'https://a.example.com',
      'https://c.example.com',
    ]);
  });

  it('caps the list at four valid origins', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `https://${n}.example.com`);
    expect(MAX_IMAGE_ORIGINS).toBe(4);
    expect(sanitizeImageOrigins(many)).toEqual(many.slice(0, 4));
    expect(sanitizeImageOrigins(['*', ...many])).toEqual(many.slice(0, 4));
  });
});
