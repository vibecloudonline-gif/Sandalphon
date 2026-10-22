import { describe, expect, it } from 'vitest';
import { detectBlock, needsJavaScript } from '../src/shared/antibot.js';
import { ratio } from '../src/shared/similarity.js';
import { buildSerpUrls, unwrapGoogleHref } from '../src/google/url.js';
import { normalizeInput } from '../src/input.js';
import { toCsv } from '../src/shared/csv.js';

describe('similarity', () => {
    it('matches difflib.SequenceMatcher.ratio', () => {
        // Values computed with Python's difflib.
        expect(ratio('abcd', 'bcde')).toBeCloseTo(0.75);
        expect(ratio('price', 'amount-now')).toBe(0);
        expect(ratio('product-price', 'product-cost')).toBeCloseTo(0.72, 2);
        expect(ratio(['html', 'body', 'div'], ['html', 'body', 'main', 'div'])).toBeCloseTo(0.857, 3);
        expect(ratio('', '')).toBe(1);
    });
});

describe('antibot', () => {
    it('flags structural block markers and error statuses', () => {
        expect(detectBlock('<html><title>Just a moment...</title></html>', 200).blocked).toBe(true);
        expect(detectBlock('<html>ok</html>', 429)).toEqual({ blocked: true, reason: 'HTTP 429 rate limit' });
        expect(detectBlock('<form id="captcha-form" action="/sorry/index">', 200).blocked).toBe(true);
    });
    it('only trusts generic phrases on short pages', () => {
        expect(detectBlock('<p>Please verify you are human</p>', 200).blocked).toBe(true);
        const article = `<p>${'An essay about how captchas ask: are you a robot? '.repeat(400)}</p>`;
        expect(detectBlock(article, 200).blocked).toBe(false);
    });
    it('detects JavaScript-only shells', () => {
        expect(needsJavaScript('<div id="root"></div><script></script>', '')).toBe(true);
        expect(needsJavaScript('<p>x</p>', 'Hello '.repeat(100))).toBe(false);
    });
});

describe('google urls', () => {
    it('builds paginated URLs with locale', () => {
        const urls = buildSerpUrls('web scraping', { maxPages: 3, countryCode: 'ES', languageCode: 'es', googleDomain: 'google.es' });
        expect(urls.map((u) => u.page)).toEqual([1, 2, 3]);
        const p2 = new URL(urls[1].url);
        expect(p2.hostname).toBe('www.google.es');
        expect(Object.fromEntries(p2.searchParams)).toMatchObject({ q: 'web scraping', hl: 'es', gl: 'es', start: '10' });
    });
    it('accepts a full Google URL as the query', () => {
        expect(buildSerpUrls('https://www.google.com/search?q=hola&tbs=qdr:d', { maxPages: 5, languageCode: 'en', googleDomain: 'google.com' })).toEqual([
            { term: 'hola', page: 1, url: 'https://www.google.com/search?q=hola&tbs=qdr:d' },
        ]);
    });
    it('unwraps redirect links and drops Google-internal ones', () => {
        expect(unwrapGoogleHref('/url?q=https://example.com/a%3Fb%3D1&sa=U&ved=x')).toBe('https://example.com/a?b=1');
        expect(unwrapGoogleHref('https://example.com/x')).toBe('https://example.com/x');
        expect(unwrapGoogleHref('/search?q=other')).toBeUndefined();
        expect(unwrapGoogleHref('https://accounts.google.com/login')).toBeUndefined();
    });
});

describe('input', () => {
    it('accepts flat and nested input and picks the mode', () => {
        expect(normalizeInput({ queries: 'a\nb\n' }).mode).toBe('google');
        expect(normalizeInput({ queries: 'a\nb\n' }).google.queries).toEqual(['a', 'b']);
        const web = normalizeInput({ startUrls: ['https://a.dev'], web: { maxPages: 5 } });
        expect(web.mode).toBe('web');
        expect(web.web.startUrls).toEqual([{ url: 'https://a.dev' }]);
        expect(web.web.maxPages).toBe(5);
        // Optional keys without a default still come through from flat input (API / Apify console).
        expect(normalizeInput({ queries: ['a'], countryCode: 'mx' }).google.countryCode).toBe('mx');
        expect(normalizeInput({ startUrls: ['https://a.dev'], waitForSelector: '.x' }).web.waitForSelector).toBe('.x');
        expect(() => normalizeInput({ mode: 'web' })).toThrow(/startUrls/);
        expect(() => normalizeInput({ startUrls: ['ftp://x'] })).toThrow(/http/);
    });
});

describe('csv', () => {
    it('one row per organic result and neutralizes formulas', () => {
        const csv = toCsv([{ searchQuery: { term: 'q', page: 1 }, organicResults: [{ position: 1, title: '=HYPERLINK("x")', url: 'https://a.dev' }] }], 'google');
        expect(csv.split('\n')).toEqual(['query,page,position,title,url,displayedUrl,description,date', `q,1,1,"'=HYPERLINK(""x"")",https://a.dev,,,`]);
    });
});
