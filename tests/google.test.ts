/**
 * Google waterfall against a local stand-in server. The two page shapes are hand-written
 * approximations of Google's basic (no-JS) and full SERP markup — they exercise the parsing
 * strategies and the HTTP → browser → CAPTCHA logic, not today's exact live markup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeInput } from '../src/input.js';
import { runGoogle, type SerpRecord } from '../src/google/crawler.js';
import { parseSerp } from '../src/google/parse.js';

const basicHtml = (q: string, start: number) => `<html><body><div id="main">
${[1, 2, 3]
    .map(
        (i) => `<div class="ezO2md"><a href="/url?q=https://site${start + i}.example/${q}&amp;sa=U&amp;ved=x"><span class="CVA68e">Result ${start + i} for ${q}</span><span class="dXDvrc">site${start + i}.example › ${q}</span></a>
<table><tr><td><span class="FrIlee"><span class="fYyStc">Mar 3, 2026 — Snippet number ${start + i} about ${q}.</span></span></td></tr></table></div>`,
    )
    .join('\n')}
<a href="/search?q=${q}+tutorial&amp;ie=UTF-8">${q} tutorial</a>
<footer><a href="/search?q=${q}&amp;start=${start + 10}" aria-label="Next page">Next &gt;</a></footer>
</div></body></html>`;

const fullHtml = (q: string) => `<html><body><div id="center_col">
<div id="tads"><div data-text-ad="1"><a href="https://ad.example/landing" data-rw="x"><div role="heading">Buy ${q} now</div></a><span class="x2VHCd">ad.example</span><div class="MUxGbd">Best deal.</div></div></div>
<div id="search"><div id="rso">
  <div class="MjjYud"><div class="g" data-hveid="1"><a href="https://first.example/"><h3>First full result</h3><cite>first.example</cite></a><div class="VwiC3b">Full snippet one.</div></div></div>
  <div class="MjjYud"><div class="related-question-pair" data-q="What is ${q}?"></div><div class="related-question-pair" data-q="Is ${q} legal?"></div></div>
  <div class="MjjYud"><div class="g" data-hveid="2"><a href="https://second.example/page"><h3>Second full result</h3><cite>second.example › page</cite></a><div class="VwiC3b">Full snippet two.</div></div></div>
</div></div>
<div id="botstuff"><a href="/search?q=${q}+python" data-ved="y">${q} python</a></div>
</div></body></html>`;

let server: Server;
let base: string;
const seenUa: string[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        const q = u.searchParams.get('q') ?? '';
        const start = Number(u.searchParams.get('start') ?? 0);
        const textBrowser = /Lynx/.test(req.headers['user-agent'] ?? '');
        seenUa.push(textBrowser ? 'lynx' : 'browser');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (u.pathname.startsWith('/sorry')) return res.end('<html><form id="captcha-form" action="/sorry/index"></form></html>');
        if (q === 'captcha') {
            res.writeHead(302, { location: '/sorry/index?continue=x' });
            return res.end();
        }
        if (q === 'jsonly' && textBrowser) return res.end('<html><body><noscript>Please click here if you are not redirected</noscript><a href="/httpservice/retry/enablejs">enable</a></body></html>');
        res.end(textBrowser ? basicHtml(q, start) : fullHtml(q));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GOOGLE_BASE_URL = base;
});
afterAll(() => {
    delete process.env.GOOGLE_BASE_URL;
    server.close();
});

const run = async (raw: Record<string, unknown>) => {
    const records: SerpRecord[] = [];
    const stats = await runGoogle(normalizeInput({ mode: 'google', maxRequestRetries: 1, ...raw }), (r) => void records.push(r));
    records.sort((a, b) => a.searchQuery.term.localeCompare(b.searchQuery.term) || a.searchQuery.page - b.searchQuery.page);
    return { records, stats };
};

describe('google parser', () => {
    it('parses the basic (no-JS) layout', () => {
        const p = parseSerp(basicHtml('mugs', 0), 'https://www.google.com/search?q=mugs');
        expect(p.organicResults.map((r) => [r.position, r.url, r.title])).toEqual([
            [1, 'https://site1.example/mugs', 'Result 1 for mugs'],
            [2, 'https://site2.example/mugs', 'Result 2 for mugs'],
            [3, 'https://site3.example/mugs', 'Result 3 for mugs'],
        ]);
        expect(p.organicResults[0]).toMatchObject({ description: 'Snippet number 1 about mugs.', date: 'Mar 3, 2026' });
        expect(p.relatedQueries.map((r) => r.title)).toEqual(['mugs tutorial']);
        expect(p.hasNextPage).toBe(true);
    });

    it('parses the full layout with ads and People Also Ask', () => {
        const p = parseSerp(fullHtml('mugs'));
        expect(p.organicResults.map((r) => r.url)).toEqual(['https://first.example/', 'https://second.example/page']);
        expect(p.organicResults[1]).toMatchObject({ title: 'Second full result', displayedUrl: 'second.example › page', description: 'Full snippet two.' });
        expect(p.paidResults).toEqual([{ adPosition: 1, title: 'Buy mugs now', url: 'https://ad.example/landing', displayedUrl: 'ad.example', description: 'Best deal.' }]);
        expect(p.peopleAlsoAsk).toEqual([{ question: 'What is mugs?' }, { question: 'Is mugs legal?' }]);
        expect(p.relatedQueries.map((r) => r.title)).toEqual(['mugs python']);
    });
});

describe('google waterfall', () => {
    it('uses cheap HTTP when possible and paginates via the next link', async () => {
        const { records, stats } = await run({ queries: ['mugs'], maxPagesPerQuery: 2 });
        expect(records.map((r) => [r.searchQuery.page, r.renderedWith, r.organicResults[0].url])).toEqual([
            [1, 'http', 'https://site1.example/mugs'],
            [2, 'http', 'https://site11.example/mugs'],
        ]);
        expect(stats).toMatchObject({ pages: 2, results: 6, escalatedToBrowser: 0, failed: [] });
    }, 60_000);

    it('escalates to the browser when the basic page has no results, and reports CAPTCHAs as failures', async () => {
        const { records, stats } = await run({ queries: ['jsonly', 'captcha'], maxPagesPerQuery: 1 });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ renderedWith: 'browser', searchQuery: { term: 'jsonly', page: 1 } });
        expect(records[0].organicResults.map((r) => r.title)).toEqual(['First full result', 'Second full result']);
        expect(stats.failed).toHaveLength(1);
        expect(stats.failed[0]).toMatchObject({ renderedWith: 'browser' });
        expect(stats.failed[0].error).toMatch(/CAPTCHA|unusual-traffic/);
        expect(seenUa).toContain('browser');
    }, 120_000);
});
