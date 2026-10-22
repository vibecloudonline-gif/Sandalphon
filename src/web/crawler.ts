/**
 * Universal web crawler with a Firecrawl-style engine waterfall:
 *   1. fast HTTP + Cheerio for every page;
 *   2. pages that are blocked, fail, or need JavaScript are re-queued to a real Chromium
 *      (Crawlee fingerprints, cookie-modal dismissal, optional infinite scroll).
 */
import { CheerioCrawler, PlaywrightCrawler, log, playwrightUtils, Sitemap, RobotsTxtFile, type RequestQueue, type EnqueueLinksOptions } from 'crawlee';
import type { Input } from '../input.js';
import { detectBlock, needsJavaScript } from '../shared/antibot.js';
import type { FingerprintStore } from '../shared/adaptive.js';
import { CHROMIUM_ARGS, jobConfig, makeProxy, openQueue, type Emit, type FailedRequest } from '../shared/setup.js';
import { extractPage, type PageRecord } from './extract.js';

export interface WebRunResult {
    pages: number;
    escalatedToBrowser: number;
    failed: FailedRequest[];
}

interface Ud {
    depth: number;
    escalationReason?: string;
}

export async function runWeb(input: Input, emit: Emit<PageRecord>, fingerprints?: FingerprintStore, signal?: AbortSignal): Promise<WebRunResult> {
    const o = input.web;
    const config = jobConfig();
    const proxyConfiguration = await makeProxy(input);
    const httpQueue = await openQueue(config, 'web-http');
    const browserQueue = await openQueue(config, 'web-browser');
    const failed: FailedRequest[] = [];
    const done = new Set<string>();
    let pages = 0;
    let escalated = 0;

    const limitReached = () => pages >= o.maxPages || signal?.aborted === true;
    const key = (url: string) => url.split('#')[0].replace(/\/$/, '');

    const enqueueOptions = (depth: number): EnqueueLinksOptions => ({
        strategy: o.sameDomain ? 'same-domain' : 'all',
        globs: o.includeGlobs.length ? o.includeGlobs : undefined,
        exclude: o.excludeGlobs.length ? o.excludeGlobs : undefined,
        userData: { depth: depth + 1 } satisfies Ud,
        transformRequestFunction: (req) => (done.has(key(req.url)) ? false : req),
    });

    const handleHtml = async (args: { url: string; loadedUrl?: string; statusCode?: number; html: string; depth: number; via: 'http' | 'browser' }) => {
        if (limitReached()) return false;
        done.add(key(args.url));
        if (args.loadedUrl) done.add(key(args.loadedUrl));
        pages++;
        await emit(
            extractPage(args.html, {
                url: args.url,
                loadedUrl: args.loadedUrl,
                statusCode: args.statusCode,
                renderedWith: args.via,
                depth: args.depth,
                options: o,
                fingerprints,
            }),
        );
        return pages < o.maxPages && args.depth < o.maxDepth;
    };

    const escalate = async (url: string, depth: number, reason: string) => {
        if (o.renderingMode === 'http') return false;
        escalated++;
        log.info(`Escalating to browser (${reason}): ${url}`);
        await browserQueue.addRequest({ url, uniqueKey: `browser:${key(url)}`, userData: { depth, escalationReason: reason } satisfies Ud });
        return true;
    };

    // ---- Seed URLs (start URLs + optional sitemaps) ----
    const seedQueue: RequestQueue = o.renderingMode === 'browser' ? browserQueue : httpQueue;
    await seedQueue.addRequests(o.startUrls.map(({ url }) => ({ url, userData: { depth: 0 } satisfies Ud })));
    if (o.useSitemaps) {
        for (const url of await discoverSitemapUrls(o.startUrls.map((s) => s.url), o.maxPages, await proxyConfiguration?.newUrl())) {
            await seedQueue.addRequest({ url, userData: { depth: 1 } satisfies Ud });
        }
    }

    const common = {
        proxyConfiguration,
        maxConcurrency: input.maxConcurrency,
        respectRobotsTxtFile: o.respectRobotsTxt,
        requestHandlerTimeoutSecs: input.requestTimeoutSecs,
        navigationTimeoutSecs: input.requestTimeoutSecs,
        // A generous ceiling: the real page cap is enforced by `limitReached`.
        maxRequestsPerCrawl: o.maxPages * 3,
    };

    // ---- Phase 1: HTTP ----
    if (o.renderingMode !== 'browser') {
        const http = new CheerioCrawler(
            {
                ...common,
                requestQueue: httpQueue,
                // Few retries: in auto mode a stubborn page is cheaper to hand to the browser.
                maxRequestRetries: o.renderingMode === 'auto' ? 1 : input.maxRequestRetries,
                requestHandler: async ({ request, body, response, $, enqueueLinks }) => {
                    if (limitReached()) return;
                    const html = body.toString();
                    const ud = request.userData as Ud;
                    const block = detectBlock(html, response.statusCode);
                    if (block.blocked) {
                        if (await escalate(request.url, ud.depth, block.reason!)) return;
                        throw new Error(`Blocked: ${block.reason}`);
                    }
                    const jsOnly = needsJavaScript(html, $('body').text());
                    if (jsOnly && (await escalate(request.url, ud.depth, 'needs JavaScript'))) return;
                    if (o.waitForSelector && !$(o.waitForSelector).length && (await escalate(request.url, ud.depth, 'waitForSelector not in static HTML'))) return;

                    const more = await handleHtml({ url: request.url, loadedUrl: request.loadedUrl, statusCode: response.statusCode, html, depth: ud.depth, via: 'http' });
                    if (more) await enqueueLinks(enqueueOptions(ud.depth));
                },
                failedRequestHandler: async ({ request }, error) => {
                    const ud = request.userData as Ud;
                    const nonHtml = /content-type|mime/i.test(error.message);
                    if (!nonHtml && !limitReached() && (await escalate(request.url, ud.depth, error.message.slice(0, 120)))) return;
                    failed.push({ url: request.url, error: error.message, renderedWith: 'http' });
                },
            },
            config,
        );
        await http.run();
    }

    // ---- Phase 2: browser ----
    if (!(await browserQueue.isEmpty()) && !limitReached()) {
        const browser = new PlaywrightCrawler(
            {
                ...common,
                requestQueue: browserQueue,
                maxRequestRetries: input.maxRequestRetries,
                maxConcurrency: Math.min(input.maxConcurrency, Number(process.env.MAX_BROWSER_CONCURRENCY ?? 4)),
                headless: input.headless,
                launchContext: { launchOptions: { args: CHROMIUM_ARGS } },
                browserPoolOptions: { useFingerprints: true, maxOpenPagesPerBrowser: 4, retireBrowserAfterPageCount: 50 },
                preNavigationHooks: [
                    async ({ page }) => {
                        // Skip heavy assets: we only need the DOM.
                        await playwrightUtils.blockRequests(page, { extraUrlPatterns: ['.mp4', '.webm', '.woff', '.woff2', '.ttf'] });
                    },
                ],
                requestHandler: async ({ request, page, response, enqueueLinks, session }) => {
                    if (limitReached()) return;
                    const ud = request.userData as Ud;
                    await page.waitForLoadState('domcontentloaded');
                    await playwrightUtils.closeCookieModals(page).catch(() => undefined);
                    if (o.waitForSelector) await page.waitForSelector(o.waitForSelector, { timeout: 15_000 }).catch(() => undefined);
                    else await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
                    if (o.infiniteScroll) await playwrightUtils.infiniteScroll(page, { timeoutSecs: 20, waitForSecs: 2 });

                    const html = await page.content();
                    const block = detectBlock(html, response?.status());
                    if (block.blocked) {
                        // New session = new fingerprint + new proxy IP on retry.
                        session?.retire();
                        throw new Error(`Blocked in browser: ${block.reason}`);
                    }
                    const more = await handleHtml({ url: request.url, loadedUrl: page.url(), statusCode: response?.status(), html, depth: ud.depth, via: 'browser' });
                    if (more) await enqueueLinks({ ...enqueueOptions(ud.depth), transformRequestFunction: (req) => (done.has(key(req.url)) ? false : req) });
                },
                failedRequestHandler: async ({ request }, error) => {
                    failed.push({ url: request.url, error: error.message, renderedWith: 'browser' });
                },
            },
            config,
        );
        await browser.run();
    }

    await httpQueue.drop().catch(() => undefined);
    await browserQueue.drop().catch(() => undefined);
    fingerprints?.flush();
    return { pages, escalatedToBrowser: escalated, failed };
}

/** URLs from robots.txt sitemaps and /sitemap.xml of each start origin. */
async function discoverSitemapUrls(startUrls: string[], max: number, proxyUrl?: string): Promise<string[]> {
    const out = new Set<string>();
    for (const origin of new Set(startUrls.map((u) => new URL(u).origin))) {
        const sitemapUrls = new Set([`${origin}/sitemap.xml`]);
        try {
            const robots = await RobotsTxtFile.find(origin, proxyUrl);
            for (const s of robots.getSitemaps()) sitemapUrls.add(s);
        } catch {
            // no robots.txt
        }
        try {
            const sitemap = await Sitemap.load([...sitemapUrls], proxyUrl);
            for (const u of sitemap.urls) {
                out.add(u);
                if (out.size >= max) return [...out];
            }
        } catch (e) {
            log.warning(`Sitemap discovery failed for ${origin}: ${(e as Error).message}`);
        }
    }
    return [...out];
}
