/**
 * Drives the web interface in Chromium: API key, the AI tab (brief → plan → scrape → answer),
 * the web tab, rendering of scraped text (must stay inert) and CSV download.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { startSite } from './site.js';

let site: { url: string; server: Server };
let llm: Server;
let api: ChildProcess;
let browser: Browser;
const PORT = 10600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
    site = await startSite();
    llm = createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const system = JSON.parse(body).messages[0].content as string;
        const content = system.includes('You plan scraping jobs')
            ? JSON.stringify({ goal: 'Conocer la tienda de tazas', mode: 'web', startUrls: [`${site.url}/products/mug`], maxPages: 1, maxDepth: 0 })
            : '## Respuesta corta\n- La taza cuesta **12.50 €**.\n- <img src=x onerror="window.__xss=1">';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    api = spawn('npx', ['tsx', 'src/server.ts'], {
        env: { ...process.env, PORT: String(PORT), API_KEY: 'secret', LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}`, LLM_MODEL: 'm', LLM_API_KEY: 'k' },
        stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
        if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
    await browser?.close();
    api?.kill();
    llm?.close();
    site?.server.close();
});

describe('web interface', () => {
    it('asks for the key, then runs an AI brief end to end', async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.goto(BASE);
        await expect(page.locator('#configNotice').textContent()).resolves.toContain('Escribe tu API key');

        await page.fill('#apiKey', 'wrong');
        await page.click('#keyForm button');
        await page.waitForSelector('#configNotice .notice.err');
        await page.fill('#apiKey', 'secret');
        await page.click('#keyForm button');
        // AI configured, no proxies → only the proxy warning.
        await page.waitForFunction(() => document.querySelector('#configNotice')?.textContent?.includes('Sin proxies'));
        expect(await page.locator('#configNotice').textContent()).not.toContain('La IA no está configurada');

        await page.fill('#askBrief', '¿Cuánto cuesta la taza azul?');
        await page.click('form[data-panel="ask"] button[type="submit"]');
        await page.waitForSelector('#results .md', { timeout: 60_000 });
        expect(await page.locator('#jobCard').textContent()).toContain('La IA entendió: Conocer la tienda de tazas');
        expect(await page.locator('#results .md strong').first().textContent()).toBe('12.50 €');
        // HTML from the model is shown as text, never executed.
        expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
        expect(await page.locator('#results .md').textContent()).toContain('<img src=x');
        expect(await page.locator('#results').textContent()).toContain('Blue Mug');
        expect(await page.locator('#history button').count()).toBe(1);
        // The only expected error is the 401 from the wrong key typed on purpose above.
        expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
        await page.close();
    }, 90_000);

    it('scrapes from the web tab, shows contacts and downloads a CSV', async () => {
        const ctx = await browser.newContext({ acceptDownloads: true });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.evaluate(() => localStorage.setItem('apiKey', JSON.stringify('secret')));
        await page.reload();
        await page.click('.tab[data-tab="web"]');
        await page.fill('#wUrls', `${site.url}/\n${site.url}/about`);
        await page.click('form[data-panel="web"] button[type="submit"]');
        await page.waitForSelector('#results table', { timeout: 60_000 });
        expect(await page.locator('#results').textContent()).toContain('hello@test-shop.dev');
        expect(await page.locator('#results h2').last().textContent()).toBe('2 páginas');

        const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl="csv"]')]);
        const path = await download.path();
        const csv = (await import('node:fs')).readFileSync(path!, 'utf8');
        expect(csv.split('\n')[0]).toContain('url,statusCode,renderedWith,title');
        expect(csv).toContain('/about');

        // Validation happens before calling the API.
        await page.fill('#wUrls', 'empresa.com');
        await page.click('form[data-panel="web"] button[type="submit"]');
        expect(await page.locator('#jobCard .notice.err').textContent()).toContain('deben empezar con http');
        await ctx.close();
    }, 90_000);
});
