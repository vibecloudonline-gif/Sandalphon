import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { normalizeInput } from '../src/input.js';
import { FingerprintStore } from '../src/shared/adaptive.js';
import { runWeb } from '../src/web/crawler.js';
import type { PageRecord } from '../src/web/extract.js';
import { startSite } from './site.js';

let base: string;
let server: Server;

beforeAll(async () => {
    ({ url: base, server } = await startSite());
});
afterAll(() => server.close());

async function crawl(raw: Record<string, unknown>, store?: FingerprintStore) {
    const records: PageRecord[] = [];
    const stats = await runWeb(normalizeInput({ mode: 'web', respectRobotsTxt: false, maxConcurrency: 4, ...raw }), (r) => void records.push(r), store);
    const byPath = new Map(records.map((r) => [new URL(r.url).pathname, r]));
    return { records, stats, byPath };
}

describe('web crawler (auto mode)', () => {
    it('crawls static pages over HTTP, escalates the SPA to a browser and reports the blocked page', async () => {
        const { byPath, stats } = await crawl({ startUrls: [`${base}/`], maxDepth: 1, maxPages: 20, extractContacts: true });

        const home = byPath.get('/')!;
        expect(home.renderedWith).toBe('http');
        expect(home.metadata.title).toBe('Home');
        expect(home.metadata.description).toBe('Description of Home');
        expect(home.jsonLd).toEqual([expect.objectContaining({ '@type': 'Organization', name: 'Test Shop' })]);
        expect(home.contacts).toEqual({ emails: ['hello@test-shop.dev'], phones: ['+34600123456'], social: ['https://www.instagram.com/testshop/'] });
        // Main content only: no nav, footer or cookie banner in the Markdown.
        expect(home.markdown).toContain('# Welcome');
        expect(home.markdown).not.toMatch(/We use cookies|© Test Shop/);

        const spa = byPath.get('/spa')!;
        expect(spa.renderedWith).toBe('browser');
        expect(spa.markdown).toContain('This text only exists after rendering');

        expect(byPath.has('/blocked')).toBe(false);
        expect(stats.failed.map((f) => new URL(f.url).pathname)).toContain('/blocked');
        expect(stats.failed.find((f) => f.url.endsWith('/blocked'))?.renderedWith).toBe('browser');

        // Depth 1 from home: /deep/1 is crawled, /deep/2 is not. External links are skipped.
        expect(byPath.has('/deep/1')).toBe(true);
        expect(byPath.has('/deep/2')).toBe(false);
        expect([...byPath.keys()].every((p) => !p.includes('external'))).toBe(true);
    }, 120_000);

    it('honours maxPages and exclude globs', async () => {
        const { records } = await crawl({ startUrls: [`${base}/`], maxDepth: 3, maxPages: 3, excludeGlobs: [`${base}/spa`, `${base}/blocked`], renderingMode: 'http' });
        expect(records).toHaveLength(3);
        expect(records.every((r) => r.renderedWith === 'http' && !r.url.endsWith('/spa'))).toBe(true);
    }, 60_000);

    it('extracts custom fields and relocates them after a redesign (adaptive selectors)', async () => {
        const store = new FingerprintStore();
        const fields = { title: '.product-title', price: '.price', priceAttr: { selector: '.price', attr: 'itemprop' } };

        const v1 = await crawl({ startUrls: [`${base}/products/mug`], maxDepth: 0, fields }, store);
        expect(v1.records[0].fields).toEqual({ title: 'Blue Mug', price: '12.50 €', priceAttr: 'price' });

        // Same host, the price element changed class from .price to .amount-now.
        const v2 = await crawl({ startUrls: [`${base}/products/mug-v2`], maxDepth: 0, fields }, store);
        expect(v2.records[0].fields).toEqual({ title: 'Blue Mug', price: '12.50 €', priceAttr: 'price' });
        expect(v2.records[0].relocatedFields).toEqual(['price', 'priceAttr']);

        // Without a stored fingerprint the field is simply missing.
        const cold = await crawl({ startUrls: [`${base}/products/mug-v2`], maxDepth: 0, fields }, new FingerprintStore());
        expect(cold.records[0].fields?.price).toBeNull();
    }, 60_000);

    it('renders everything in the browser when renderingMode is "browser"', async () => {
        const { records } = await crawl({ startUrls: [`${base}/spa`], maxDepth: 0, renderingMode: 'browser', waitForSelector: '.js-content' });
        expect(records).toHaveLength(1);
        expect(records[0].renderedWith).toBe('browser');
        expect(records[0].headings.h1).toEqual(['Rendered by JS']);
    }, 60_000);
});
