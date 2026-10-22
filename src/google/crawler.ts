/**
 * Google SERP scraper.
 *   1. HTTP with a text-browser user agent + consent cookies: Google then serves its basic
 *      no-JavaScript HTML (trick used by googlesearch-python and Search-Engines-Scraper). Cheap.
 *   2. If Google answers with a CAPTCHA / "enable JavaScript" page, the request moves to a real
 *      Chromium with Crawlee fingerprints; consent screens are accepted and a CAPTCHA retires the
 *      session (new fingerprint, new proxy IP) before retrying.
 * Pagination follows the "next page" link one page at a time, so we never ask for pages that don't exist.
 */
import { CheerioCrawler, PlaywrightCrawler, log, type RequestQueue } from 'crawlee';
import type { Page } from 'playwright';
import type { Input } from '../input.js';
import { detectBlock } from '../shared/antibot.js';
import { CHROMIUM_ARGS, jobConfig, makeProxy, openQueue, type Emit, type FailedRequest } from '../shared/setup.js';
import { parseSerp, type SerpParse } from './parse.js';
import { buildSerpUrls } from './url.js';

export interface SerpRecord extends SerpParse {
    searchQuery: { term: string; page: number; url: string; countryCode?: string; languageCode: string };
    url: string;
    renderedWith: 'http' | 'browser';
    scrapedAt: string;
    html?: string;
}

interface Ud {
    term: string;
    page: number;
    escalationReason?: string;
}

const TEXT_BROWSER_UA = 'Lynx/2.9.0dev.12 libwww-FM/2.14 SSL-MM/1.4.1 GNUTLS/3.7.8';
const CONSENT_COOKIES = 'CONSENT=PENDING+987; SOCS=CAESHAgBEhIaAB';

export interface GoogleRunResult {
    pages: number;
    results: number;
    escalatedToBrowser: number;
    failed: FailedRequest[];
}

export async function runGoogle(input: Input, emit: Emit<SerpRecord>, signal?: AbortSignal): Promise<GoogleRunResult> {
    const g = input.google;
    const config = jobConfig();
    const proxyConfiguration = await makeProxy(input);
    const httpQueue = await openQueue(config, 'serp-http');
    const browserQueue = await openQueue(config, 'serp-browser');
    const failed: FailedRequest[] = [];
    let pages = 0;
    let results = 0;
    let escalated = 0;

    const urlOpts = { maxPages: g.maxPagesPerQuery, countryCode: g.countryCode, languageCode: g.languageCode, googleDomain: g.googleDomain };
    const first: RequestQueue = g.renderingMode === 'browser' ? browserQueue : httpQueue;
    for (const q of g.queries) {
        const [p1] = buildSerpUrls(q, urlOpts);
        await first.addRequest({ url: p1.url, userData: { term: p1.term, page: 1 } satisfies Ud });
    }

    const onParsed = async (ud: Ud, url: string, html: string, parsed: SerpParse, via: 'http' | 'browser', queue: RequestQueue) => {
        pages++;
        results += parsed.organicResults.length;
        await emit({
            searchQuery: { term: ud.term, page: ud.page, url, countryCode: g.countryCode, languageCode: g.languageCode },
            url,
            renderedWith: via,
            scrapedAt: new Date().toISOString(),
            ...parsed,
            ...(g.saveHtml ? { html } : {}),
        });
        if (ud.page < g.maxPagesPerQuery && parsed.hasNextPage && !signal?.aborted) {
            const next = buildSerpUrls(ud.term, { ...urlOpts, maxPages: ud.page + 1 })[ud.page];
            await queue.addRequest({ url: next.url, userData: { term: ud.term, page: ud.page + 1 } satisfies Ud });
        }
    };

    const escalate = async (url: string, ud: Ud, reason: string) => {
        if (g.renderingMode === 'http') return false;
        escalated++;
        log.info(`Google: escalating "${ud.term}" p${ud.page} to browser (${reason})`);
        await browserQueue.addRequest({ url, uniqueKey: `browser:${url}`, userData: { ...ud, escalationReason: reason } });
        return true;
    };

    const common = {
        proxyConfiguration,
        requestHandlerTimeoutSecs: input.requestTimeoutSecs,
        navigationTimeoutSecs: input.requestTimeoutSecs,
        // Google punishes bursts from one IP; keep it polite unless the user has a proxy pool.
        maxConcurrency: proxyConfiguration ? input.maxConcurrency : Math.min(input.maxConcurrency, 2),
        maxRequestsPerMinute: proxyConfiguration ? undefined : 20,
    };

    if (g.renderingMode !== 'browser') {
        const http = new CheerioCrawler(
            {
                ...common,
                requestQueue: httpQueue,
                maxRequestRetries: g.renderingMode === 'auto' ? 1 : input.maxRequestRetries,
                persistCookiesPerSession: false,
                preNavigationHooks: [
                    (_ctx, gotOptions) => {
                        gotOptions.useHeaderGenerator = false;
                        gotOptions.headers = { ...gotOptions.headers, 'user-agent': TEXT_BROWSER_UA, accept: 'text/html,*/*', cookie: CONSENT_COOKIES };
                    },
                ],
                requestHandler: async ({ request, body, response }) => {
                    if (signal?.aborted) return;
                    const html = body.toString();
                    const ud = request.userData as Ud;
                    const block = detectBlock(html, response.statusCode);
                    if (block.blocked) {
                        if (await escalate(request.url, ud, block.reason!)) return;
                        throw new Error(`Google blocked the request: ${block.reason}`);
                    }
                    const parsed = parseSerp(html, request.loadedUrl ?? request.url);
                    if (!parsed.organicResults.length && !isGenuinelyEmpty(html)) {
                        if (await escalate(request.url, ud, 'no results in basic HTML')) return;
                    }
                    await onParsed(ud, request.url, html, parsed, 'http', httpQueue);
                },
                failedRequestHandler: async ({ request }, error) => {
                    if (await escalate(request.url, request.userData as Ud, error.message.slice(0, 120))) return;
                    failed.push({ url: request.url, error: error.message, renderedWith: 'http' });
                },
            },
            config,
        );
        await http.run();
    }

    if (!(await browserQueue.isEmpty()) && !signal?.aborted) {
        const browser = new PlaywrightCrawler(
            {
                ...common,
                requestQueue: browserQueue,
                maxRequestRetries: input.maxRequestRetries,
                maxConcurrency: Math.min(common.maxConcurrency, Number(process.env.MAX_BROWSER_CONCURRENCY ?? 2)),
                headless: input.headless,
                launchContext: { launchOptions: { args: CHROMIUM_ARGS } },
                browserPoolOptions: {
                    useFingerprints: true,
                    fingerprintOptions: { fingerprintGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['windows', 'macos'], devices: ['desktop'], locales: [g.languageCode] } },
                },
                requestHandler: async ({ request, page, response, session }) => {
                    if (signal?.aborted) return;
                    const ud = request.userData as Ud;
                    await acceptConsent(page);
                    if (!page.url().includes('/sorry/')) {
                        await page.waitForSelector('#search, #rso, #botstuff, #captcha-form, form[action*="sorry"]', { state: 'attached', timeout: 15_000 }).catch(() => undefined);
                    }
                    const html = await page.content();
                    const block = page.url().includes('/sorry/') ? { blocked: true, reason: 'Google CAPTCHA (/sorry)' } : detectBlock(html, response?.status());
                    if (block.blocked) {
                        session?.retire();
                        throw new Error(`Google blocked the browser: ${block.reason}. Use residential proxies for reliable results.`);
                    }
                    const parsed = parseSerp(html, page.url());
                    await onParsed(ud, request.url, html, parsed, 'browser', browserQueue);
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
    return { pages, results, escalatedToBrowser: escalated, failed };
}

/** "Your search did not match any documents" (in several languages). */
function isGenuinelyEmpty(html: string): boolean {
    return /did not match any documents|no results found for|no se han encontrado resultados|não encontrou nenhum documento|ergab keine Treffer|aucun document ne correspond/i.test(html);
}

async function acceptConsent(page: Page): Promise<void> {
    if (!/consent\.google\./.test(page.url()) && !(await page.$('form[action*="consent.google"]'))) return;
    const button = page.locator('button, input[type="submit"]').filter({ hasText: /accept all|aceptar todo|alle akzeptieren|tout accepter|accetta tutto|aceitar tudo|i agree|acepto/i });
    if (await button.count()) {
        await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => undefined), button.first().click()]);
        await page.waitForURL(/\/search\?/, { timeout: 15_000 }).catch(() => undefined);
    }
}
