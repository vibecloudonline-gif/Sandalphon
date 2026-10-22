/**
 * Public Instagram profiles, logged out, for competitor analysis. No accounts, no login.
 *   1. HTTP  web_profile_info (public web app id): profile + latest 12 posts.         [Apify "no login" actors, Instaloader]
 *   2. HTTP  anonymous GraphQL by doc_id with the homepage CSRF cookie: more posts.  [Instaloader]
 *   3. Browser fallback: open the profile, dismiss the login dialog, scroll and read the
 *      GraphQL/JSON the page itself loads — no hard-coded doc_id needed.             [instagram-graphql-scraper]
 * Optional niche discovery via Google `site:instagram.com <query>`.
 */
import { BasicCrawler, PlaywrightCrawler, log, type BasicCrawlingContext } from 'crawlee';
import type { Page } from 'playwright';
import type { Input } from '../input.js';
import { runGoogle } from '../google/crawler.js';
import { CHROMIUM_ARGS, jobConfig, makeProxy, openQueue, type Emit, type FailedRequest } from '../shared/setup.js';
import { analyzeProfile, nicheReport, type NicheReport, type ProfileAnalysis } from './analyze.js';
import { findPosts, findUser, normalizeProfile, parseUsername, type IgPost, type IgProfile } from './normalize.js';

export interface ProfileRecord {
    type: 'profile';
    username: string;
    renderedWith: 'http' | 'browser';
    scrapedAt: string;
    profile: IgProfile;
    analysis: ProfileAnalysis;
    posts?: IgPost[];
}

export interface InstagramRunResult {
    profiles: number;
    posts: number;
    discovered: string[];
    escalatedToBrowser: number;
    failed: FailedRequest[];
}

// Public app id of instagram.com's own web client (sent by every logged-out visitor's browser).
const WEB_APP_ID = '936619743392459';
// Anonymous "profile posts" query used by Instaloader; Instagram rotates these, so it is overridable.
const POSTS_DOC_ID = process.env.IG_POSTS_DOC_ID ?? '7950326061742207';
const base = () => process.env.IG_BASE_URL ?? 'https://www.instagram.com';

class NotFound extends Error {}

interface Collected {
    user?: Record<string, any>;
    posts: Map<string, IgPost>;
    pageInfo?: { has_next_page?: boolean; end_cursor?: string };
}

export async function runInstagram(input: Input, emit: Emit<ProfileRecord | NicheReport>, signal?: AbortSignal): Promise<InstagramRunResult> {
    const ig = input.instagram;
    const config = jobConfig();
    const proxyConfiguration = await makeProxy(input);
    const failed: FailedRequest[] = [];
    const done: { profile: IgProfile; posts: IgPost[]; analysis: ProfileAnalysis }[] = [];
    let escalated = 0;

    // ---- Discovery through Google ----
    const usernames = new Set(ig.usernames.map(parseUsername).filter((u): u is string => !!u));
    const discovered: string[] = [];
    if (ig.discoverQuery) {
        const want = ig.discoverMaxProfiles;
        await runGoogle(
            {
                ...input,
                mode: 'google',
                google: { ...input.google, queries: [`site:instagram.com ${ig.discoverQuery}`], maxPagesPerQuery: Math.min(5, Math.ceil(want / 8)) },
            },
            (serp) => {
                for (const r of serp.organicResults) {
                    const u = parseUsername(r.url);
                    if (u && !usernames.has(u) && discovered.length < want) {
                        usernames.add(u);
                        discovered.push(u);
                    }
                }
            },
            signal,
        );
        log.info(`Instagram: discovered ${discovered.length} profiles for "${ig.discoverQuery}"`);
    }
    if (!usernames.size) throw new Error('Input error: no valid Instagram usernames (give "usernames" or a "discoverQuery" that finds some).');

    const cutoff = ig.daysBack ? Date.now() - ig.daysBack * 86_400_000 : 0;
    const enough = (c: Collected) => {
        if (c.posts.size >= ig.maxPostsPerProfile) return true;
        if (!cutoff) return false;
        const unpinned = [...c.posts.values()].filter((p) => !p.isPinned);
        return unpinned.length > 0 && Math.min(...unpinned.map((p) => Date.parse(p.takenAt))) < cutoff;
    };

    const finish = async (username: string, c: Collected, via: 'http' | 'browser') => {
        const profile = normalizeProfile(c.user!);
        const posts = [...c.posts.values()]
            .filter((p) => !cutoff || Date.parse(p.takenAt) >= cutoff || p.isPinned)
            .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))
            .slice(0, ig.maxPostsPerProfile);
        const analysis = analyzeProfile(profile, posts, ig.timeZone);
        done.push({ profile, posts, analysis });
        await emit({ type: 'profile', username, renderedWith: via, scrapedAt: new Date().toISOString(), profile, analysis, ...(ig.includePosts ? { posts } : {}) });
    };

    const httpQueue = await openQueue(config, 'ig-http');
    const browserQueue = await openQueue(config, 'ig-browser');
    const partial = new Map<string, Collected>();

    const escalate = async (username: string, reason: string) => {
        if (ig.renderingMode === 'http') return false;
        escalated++;
        log.info(`Instagram: @${username} → browser (${reason})`);
        await browserQueue.addRequest({ url: `${base()}/${username}/`, uniqueKey: `browser:${username}`, userData: { username, reason } });
        return true;
    };

    const politeness = {
        // Instagram rate-limits each exit IP after a handful of anonymous lookups.
        maxConcurrency: proxyConfiguration ? Math.min(input.maxConcurrency, 5) : 1,
        maxRequestsPerMinute: proxyConfiguration ? undefined : 6,
        requestHandlerTimeoutSecs: Math.max(input.requestTimeoutSecs, 120),
    };

    if (ig.renderingMode !== 'browser') {
        await httpQueue.addRequests([...usernames].map((username) => ({ url: `${base()}/${username}/`, userData: { username } })));
        const http = new BasicCrawler(
            {
                ...politeness,
                requestQueue: httpQueue,
                maxRequestRetries: ig.renderingMode === 'auto' ? 1 : input.maxRequestRetries,
                useSessionPool: true,
                requestHandler: async ({ request, sendRequest, session }) => {
                    if (signal?.aborted) return;
                    const { username } = request.userData as { username: string };
                    const headers = { 'x-ig-app-id': WEB_APP_ID, 'x-requested-with': 'XMLHttpRequest', accept: '*/*', referer: `${base()}/${username}/` };

                    const res = await sendRequest({ url: `${base()}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, headers, throwHttpErrors: false, followRedirect: false });
                    if (res.statusCode === 404) throw new NotFound(`Profile @${username} does not exist`);
                    const json = parseJson(res.body);
                    if (res.statusCode !== 200 || !json) {
                        session?.retire();
                        throw new Error(`web_profile_info answered ${res.statusCode}${json ? '' : ' (not JSON: login wall or rate limit)'}`);
                    }
                    const user = json?.data?.user;
                    if (!user) throw new NotFound(`Profile @${username} does not exist`);
                    if (user.is_private) throw new NotFound(`Profile @${username} is private`);

                    const c: Collected = { user, posts: findPosts(user.edge_owner_to_timeline_media), pageInfo: user.edge_owner_to_timeline_media?.page_info };
                    partial.set(username, c);

                    // More posts via anonymous GraphQL.
                    let pages = 0;
                    while (!enough(c) && c.pageInfo?.has_next_page && c.pageInfo.end_cursor && pages < 20 && !signal?.aborted) {
                        pages++;
                        const before = c.posts.size;
                        try {
                            await graphqlPage(sendRequest, username, String(user.id), c);
                        } catch (e) {
                            if (await escalate(username, `pagination failed: ${(e as Error).message.slice(0, 80)}`)) return;
                            break;
                        }
                        if (c.posts.size === before) break;
                        await sleep(1500 + Math.random() * 1500);
                    }
                    partial.delete(username);
                    await finish(username, c, 'http');
                },
                failedRequestHandler: async ({ request }, error) => {
                    const { username } = request.userData as { username: string };
                    if (!(error instanceof NotFound) && (await escalate(username, error.message.slice(0, 100)))) return;
                    failed.push({ url: request.url, error: error.message, renderedWith: 'http' });
                },
            },
            config,
        );
        await http.run();
    } else {
        await browserQueue.addRequests([...usernames].map((username) => ({ url: `${base()}/${username}/`, uniqueKey: `browser:${username}`, userData: { username } })));
    }

    if (!(await browserQueue.isEmpty()) && !signal?.aborted) {
        const browser = new PlaywrightCrawler(
            {
                ...politeness,
                proxyConfiguration,
                requestQueue: browserQueue,
                maxRequestRetries: input.maxRequestRetries,
                headless: input.headless,
                navigationTimeoutSecs: input.requestTimeoutSecs,
                launchContext: { launchOptions: { args: CHROMIUM_ARGS } },
                browserPoolOptions: { useFingerprints: true },
                preNavigationHooks: [
                    async ({ page, request }) => {
                        // Capture the JSON the profile page loads by itself.
                        const { username } = request.userData as { username: string };
                        const c: Collected = partial.get(username) ?? { posts: new Map() };
                        partial.set(username, c);
                        page.on('response', async (resp) => {
                            if (!/\/graphql|\/api\/v1\//.test(resp.url())) return;
                            const json = await resp.json().catch(() => undefined);
                            if (!json) return;
                            c.user ??= findUser(json, username);
                            findPosts(json, c.posts);
                        });
                    },
                ],
                requestHandler: async ({ request, page, session }) => {
                    const { username } = request.userData as { username: string };
                    const c = partial.get(username)!;
                    await page.waitForLoadState('domcontentloaded');
                    if (/\/accounts\/login|\/challenge\//.test(page.url())) {
                        session?.retire();
                        throw new Error('Redirected to the login wall (rate-limited IP). Use residential proxies.');
                    }
                    if (await page.locator('text=/Sorry, this page isn.t available|Esta página no está disponible/i').count()) {
                        throw new NotFound(`Profile @${username} does not exist`);
                    }
                    readEmbeddedJson(await page.content(), username, c);
                    await dismissLoginDialog(page);

                    let stale = 0;
                    for (let i = 0; i < 25 && !enough(c) && stale < 3 && !signal?.aborted; i++) {
                        const before = c.posts.size;
                        await page.mouse.wheel(0, 2500);
                        await page.waitForTimeout(1200 + Math.random() * 800);
                        await dismissLoginDialog(page);
                        stale = c.posts.size === before ? stale + 1 : 0;
                    }
                    readEmbeddedJson(await page.content(), username, c);
                    if (!c.user) {
                        session?.retire();
                        throw new Error('No profile data in the page (blocked or layout change)');
                    }
                    if (c.user.is_private) throw new NotFound(`Profile @${username} is private`);
                    partial.delete(username);
                    await finish(username, c, 'browser');
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
    if (done.length) await emit(nicheReport(done, ig.timeZone));
    return { profiles: done.length, posts: done.reduce((n, d) => n + d.posts.length, 0), discovered, escalatedToBrowser: escalated, failed };
}

type SendRequest = BasicCrawlingContext['sendRequest'];

async function graphqlPage(sendRequest: SendRequest, username: string, userId: string, c: Collected): Promise<void> {
    // The CSRF cookie a logged-out visitor gets from the homepage.
    const home = await sendRequest({ url: `${base()}/`, throwHttpErrors: false });
    const setCookie = ([] as string[]).concat(home.headers['set-cookie'] ?? []);
    const csrf = setCookie.map((c) => c.match(/csrftoken=([^;]+)/)?.[1]).find(Boolean) ?? '';
    const variables = {
        data: { count: 12, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
        id: userId,
        __relay_internal__pv__PolarisFeedShareMenurelayprovider: false,
        after: c.pageInfo!.end_cursor,
        before: null,
        first: 12,
        last: null,
    };
    const res = await sendRequest({
        url: `${base()}/graphql/query`,
        method: 'POST',
        throwHttpErrors: false,
        headers: {
            'x-ig-app-id': WEB_APP_ID,
            'x-csrftoken': csrf,
            'x-requested-with': 'XMLHttpRequest',
            'content-type': 'application/x-www-form-urlencoded',
            cookie: csrf ? `csrftoken=${csrf}` : '',
            referer: `${base()}/${username}/`,
        },
        body: new URLSearchParams({ variables: JSON.stringify(variables), doc_id: POSTS_DOC_ID, server_timestamps: 'true' }).toString(),
    });
    const json = parseJson(res.body);
    if (res.statusCode !== 200 || !json || json.status === 'fail' || json.errors) {
        throw new Error(`GraphQL ${res.statusCode} ${json?.message ?? json?.errors?.[0]?.message ?? ''}`.trim());
    }
    const media = json?.data?.user?.edge_owner_to_timeline_media ?? json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    findPosts(media ?? json, c.posts);
    c.pageInfo = media?.page_info;
}

function parseJson(body: unknown): any {
    if (typeof body !== 'string') return body ?? undefined;
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

/** Profiles and first posts are also embedded as JSON in the HTML (<script type="application/json">). */
function readEmbeddedJson(html: string, username: string, c: Collected) {
    for (const m of html.matchAll(/<script[^>]+type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/g)) {
        const json = parseJson(m[1]);
        if (!json) continue;
        c.user ??= findUser(json, username);
        findPosts(json, c.posts);
    }
}

async function dismissLoginDialog(page: Page) {
    const close = page.locator('[role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="Cerrar"], [role="dialog"] button:has-text("Not now"), [role="dialog"] button:has-text("Ahora no")');
    if (await close.count()) await close.first().click({ timeout: 2000 }).catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
