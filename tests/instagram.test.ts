/**
 * Instagram pipeline against local stand-ins for instagram.com, Google and an OpenAI-compatible LLM.
 * Payload shapes follow what Instaloader parses (legacy GraphQL nodes and v1 items); they are not
 * captured from today's live Instagram.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeInput } from '../src/input.js';
import { runInstagram, type ProfileRecord } from '../src/instagram/crawler.js';
import { analyzeProfile, type NicheReport } from '../src/instagram/analyze.js';
import { findPosts, normalizePost, normalizeProfile, parseUsername } from '../src/instagram/normalize.js';
import { createJob } from '../src/jobs.js';
import { toCsv } from '../src/shared/csv.js';

const DAY = 86_400;
const NOW = Math.floor(Date.parse('2026-10-20T18:00:00Z') / 1000);

/** Legacy node; i=0 is the newest post. Every third post is a reel, every fifth a carousel. */
function node(user: string, i: number, likes: number) {
    const typename = i % 5 === 4 ? 'GraphSidecar' : i % 3 === 0 ? 'GraphVideo' : 'GraphImage';
    return {
        __typename: typename,
        shortcode: `${user}_${i}`,
        taken_at_timestamp: NOW - i * 2 * DAY,
        is_video: typename === 'GraphVideo',
        product_type: typename === 'GraphVideo' ? 'clips' : 'feed',
        video_view_count: typename === 'GraphVideo' ? likes * 10 : undefined,
        edge_media_to_caption: { edges: [{ node: { text: `Post ${i} de @${user} #vegano #cdmx${i % 2 ? ' #postres' : ''}` } }] },
        edge_liked_by: { count: likes },
        edge_media_to_comment: { count: Math.round(likes / 10) },
        display_url: `https://cdn.example/${user}/${i}.jpg`,
        ...(i === 30 ? { pinned_for_users: [{ id: '1' }] } : {}),
        // Carousel children must not be counted as posts.
        ...(typename === 'GraphSidecar' ? { edge_sidecar_to_children: { edges: [{ node: { shortcode: `child_${user}_${i}`, taken_at_timestamp: NOW } }] } } : {}),
    };
}

function user(username: string, followers: number, posts: unknown[], hasNext: boolean) {
    return {
        id: `id_${username}`,
        username,
        full_name: username.toUpperCase(),
        biography: `Bio de ${username}`,
        bio_links: [{ url: `https://${username}.example` }],
        edge_followed_by: { count: followers },
        edge_follow: { count: 10 },
        is_business_account: true,
        category_name: 'Bakery',
        is_verified: false,
        edge_owner_to_timeline_media: { count: 40, page_info: { has_next_page: hasNext, end_cursor: hasNext ? 'cursor12' : null }, edges: posts.map((n) => ({ node: n })) },
    };
}

const profiles: Record<string, { followers: number; likes: (i: number) => number }> = {
    dulce_vegano: { followers: 10_000, likes: (i) => (i % 3 === 0 ? 900 : 300) }, // reels win
    pan_verde: { followers: 2_000, likes: () => 100 },
    browseronly: { followers: 5_000, likes: () => 250 },
};

let ig: Server;
let google: Server;
let llm: Server;
const llmCalls: { system: string; user: string }[] = [];
const graphqlCalls: { csrf?: string; docId?: string }[] = [];

const listen = async (s: Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
    ig = createServer(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        let body = '';
        for await (const c of req) body += c;
        const json = (status: number, data: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (u.pathname === '/') {
            res.writeHead(200, { 'set-cookie': 'csrftoken=tok123; Path=/', 'content-type': 'text/html' });
            return res.end('<html>home</html>');
        }
        if (u.pathname === '/api/v1/users/web_profile_info/') {
            const name = u.searchParams.get('username')!;
            if (name === 'browseronly' && req.headers['x-from-page'] !== '1') {
                // Datacenter IP treatment: a login-wall HTML page instead of JSON.
                res.writeHead(429, { 'content-type': 'text/html' });
                return res.end('<html>Please wait a few minutes before you try again.</html>');
            }
            const p = profiles[name];
            if (!p) return json(404, { status: 'fail' });
            const first = Array.from({ length: 12 }, (_, i) => node(name, i, p.likes(i)));
            return json(200, { data: { user: user(name, p.followers, first, true) }, status: 'ok' });
        }
        if (u.pathname === '/graphql/query' && req.method === 'POST') {
            const form = new URLSearchParams(body);
            const vars = JSON.parse(form.get('variables') ?? '{}');
            graphqlCalls.push({ csrf: req.headers['x-csrftoken'] as string, docId: form.get('doc_id') ?? undefined });
            const name = Object.keys(profiles).find((n) => vars.id === `id_${n}`) ?? 'browseronly';
            if (req.headers['x-csrftoken'] !== 'tok123' && req.headers['x-from-page'] !== '1') return json(403, { message: 'CSRF', status: 'fail' });
            const p = profiles[name];
            // Second page in the newer v1 item shape, ending the feed.
            const items = Array.from({ length: 12 }, (_, k) => {
                const n = node(name, 12 + k, p.likes(12 + k));
                return { code: n.shortcode, taken_at: n.taken_at_timestamp, media_type: n.__typename === 'GraphSidecar' ? 8 : n.is_video ? 2 : 1, product_type: n.product_type, like_count: n.edge_liked_by.count, comment_count: n.edge_media_to_comment.count, caption: { text: n.edge_media_to_caption.edges[0].node.text }, play_count: n.video_view_count };
            });
            return json(200, { data: { user: { edge_owner_to_timeline_media: { page_info: { has_next_page: false, end_cursor: null }, edges: items.map((n) => ({ node: n })) } } }, status: 'ok' });
        }
        const page = u.pathname.match(/^\/([a-z0-9._]+)\/$/)?.[1];
        if (page === 'browseronly') {
            // Profile page that loads its data with fetch and paginates on scroll; shows a login dialog.
            res.writeHead(200, { 'content-type': 'text/html' });
            return res.end(`<html><body style="height:5000px"><div role="dialog"><button aria-label="Close" onclick="this.parentNode.remove()">x</button>Log in to see more</div>
<script>
fetch('/api/v1/users/web_profile_info/?username=browseronly', { headers: { 'x-from-page': '1' } });
let loaded = false;
window.addEventListener('scroll', () => { if (loaded) return; loaded = true;
  fetch('/graphql/query', { method: 'POST', headers: { 'x-from-page': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'variables=' + encodeURIComponent(JSON.stringify({ id: 'id_browseronly' })) + '&doc_id=999' });
});
</script></body></html>`);
        }
        res.writeHead(404).end();
    });
    process.env.IG_BASE_URL = await listen(ig);

    google = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body><div id="main">
<div class="ezO2md"><a href="/url?q=https://www.instagram.com/dulce_vegano/&amp;sa=U"><span class="CVA68e">Dulce Vegano (@dulce_vegano)</span></a></div>
<div class="ezO2md"><a href="/url?q=https://www.instagram.com/p/ABC123/&amp;sa=U"><span class="CVA68e">A post, not a profile</span></a></div>
<div class="ezO2md"><a href="/url?q=https://www.instagram.com/pan_verde/?hl=es&amp;sa=U"><span class="CVA68e">Pan Verde</span></a></div>
</div></body></html>`);
    });
    process.env.GOOGLE_BASE_URL = await listen(google);

    llm = createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const { messages } = JSON.parse(body);
        const system = messages[0].content as string;
        llmCalls.push({ system, user: messages[1].content });
        const content = system.includes('You plan scraping jobs')
            ? JSON.stringify({ goal: 'Saber qué contenido funciona a pastelerías veganas en CDMX', mode: 'instagram', discoverQuery: 'pastelería vegana cdmx', discoverMaxProfiles: 999, maxPostsPerProfile: 12, timeZone: 'America/Mexico_City', usernames: [], startUrls: ['javascript:alert(1)'] })
            : '## Respuesta corta\n- Los reels funcionan mejor.';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    process.env.LLM_BASE_URL = await listen(llm);
    process.env.LLM_MODEL = 'test-model';
    process.env.LLM_API_KEY = 'k';
});

afterAll(() => {
    for (const k of ['IG_BASE_URL', 'GOOGLE_BASE_URL', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];
    ig.close();
    google.close();
    llm.close();
});

const run = async (raw: Record<string, unknown>) => {
    const out: (ProfileRecord | NicheReport)[] = [];
    const stats = await runInstagram(normalizeInput({ mode: 'instagram', maxRequestRetries: 1, ...raw }), (r) => void out.push(r));
    return { profiles: out.filter((r): r is ProfileRecord => r.type === 'profile'), report: out.find((r): r is NicheReport => r.type === 'nicheReport'), stats };
};

describe('normalize', () => {
    it('parses usernames from handles and URLs, rejecting non-profile paths', () => {
        expect(['@Dulce_Vegano', 'https://www.instagram.com/pan_verde/?hl=es', 'instagram.com/x.y', 'https://www.instagram.com/p/ABC/', 'no spaces allowed'].map(parseUsername)).toEqual(['dulce_vegano', 'pan_verde', 'x.y', undefined, undefined]);
    });
    it('normalizes both post shapes and skips carousel children', () => {
        const legacy = normalizePost(node('a', 3, 50))!;
        expect(legacy).toMatchObject({ shortcode: 'a_3', type: 'reel', likes: 50, comments: 5, views: 500, hashtags: ['vegano', 'cdmx', 'postres'], mentions: ['a'], url: 'https://www.instagram.com/reel/a_3/' });
        const v1 = normalizePost({ code: 'z', taken_at: NOW, media_type: 8, like_count: 7, comment_count: 1, caption: { text: 'hi' } })!;
        expect(v1).toMatchObject({ type: 'carousel', likes: 7, comments: 1, views: null });
        expect([...findPosts({ any: { nesting: [node('a', 4, 1)] } }).keys()]).toEqual(['a_4']);
    });
});

describe('analysis', () => {
    it('computes engagement, frequency, formats and local posting times', () => {
        const posts = Array.from({ length: 12 }, (_, i) => normalizePost(node('d', i, i % 3 === 0 ? 900 : 300))!);
        const a = analyzeProfile(normalizeProfile(user('d', 10_000, [], false)), posts, 'America/Mexico_City');
        expect(a.postsAnalyzed).toBe(12);
        expect(a.periodDays).toBe(22);
        expect(a.postsPerWeek).toBe(3.5);
        // Reels are i = 0, 3, 6 (i = 9 is a carousel): 900 likes + 90 comments each.
        expect(a.formatMix.reel).toEqual({ share: 25, avgEngagement: 990 });
        // 4 posts at 990 and 8 at 330 → 550 avg / 10,000 followers.
        expect(a.engagementRate).toBe(5.5);
        // 18:00 UTC is 12:00 in Mexico City (UTC-6, no DST since 2022).
        expect(a.bestHours[0].hour).toBe(12);
        expect(a.topHashtags[0]).toEqual({ tag: 'vegano', uses: 12 });
    });
});

describe('instagram crawler', () => {
    it('gets profiles and paginates over HTTP, builds the niche report', async () => {
        const { profiles: ps, report, stats } = await run({ usernames: ['dulce_vegano', '@pan_verde', 'ghost_account'], maxPostsPerProfile: 20, timeZone: 'America/Mexico_City' });
        expect(ps.map((p) => [p.username, p.renderedWith, p.posts!.length]).sort()).toEqual([
            ['dulce_vegano', 'http', 20],
            ['pan_verde', 'http', 20],
        ]);
        expect(graphqlCalls.every((c) => c.csrf === 'tok123' && c.docId === '7950326061742207')).toBe(true);
        const dv = ps.find((p) => p.username === 'dulce_vegano')!;
        expect(dv.profile).toMatchObject({ followers: 10_000, category: 'Bakery', bioLinks: ['https://dulce_vegano.example'] });
        expect(stats.failed.map((f) => f.error)).toEqual(['Profile @ghost_account does not exist']);

        // dulce_vegano: 7 posts at 990 + 13 at 330 over 20 → 561 / 10,000 = 5.61 %. pan_verde: 110 / 2,000 = 5.5 %.
        expect(report!.ranking.map((r) => [r.username, r.engagementRate])).toEqual([
            ['dulce_vegano', 5.61],
            ['pan_verde', 5.5],
        ]);
        expect(report!.formats[0].type).toBe('reel');
        expect(report!.sharedHashtags.map((t) => t.tag)).toContain('vegano');
        expect(report!.benchmarks.medianFollowers).toBe(6_000);
    }, 120_000);

    it('falls back to the browser and reads the JSON the page loads itself', async () => {
        const { profiles: ps, stats } = await run({ usernames: ['browseronly'], maxPostsPerProfile: 24 });
        expect(stats.escalatedToBrowser).toBe(1);
        expect(ps).toHaveLength(1);
        expect(ps[0].renderedWith).toBe('browser');
        expect(ps[0].profile.followers).toBe(5_000);
        expect(ps[0].posts!.length).toBe(24);
    }, 120_000);

    it('discovers niche profiles through Google', async () => {
        const { stats, profiles: ps } = await run({ discoverQuery: 'pastelería vegana cdmx', discoverMaxProfiles: 5, maxPostsPerProfile: 12 });
        expect(stats.discovered).toEqual(['dulce_vegano', 'pan_verde']);
        expect(ps).toHaveLength(2);
    }, 120_000);
});

describe('AI brief → plan → scrape → insights', () => {
    it('plans a bounded scrape from the brief and answers it', async () => {
        llmCalls.length = 0;
        const job = createJob(null, { brief: 'Tengo una pastelería vegana en CDMX, ¿qué contenido les funciona a mis competidores?' });
        await job.done;
        expect(job.status).toBe('succeeded');
        expect(job.mode).toBe('instagram');
        expect(job.plan!.goal).toMatch(/pastelerías veganas/);
        // The model asked for 999 profiles: capped at 25. Its bogus URL never reached the scraper.
        expect(job.plan!.input.instagram.discoverMaxProfiles).toBe(25);
        expect(job.plan!.input.web.startUrls).toEqual([]);
        expect(job.plan!.input.instagram.timeZone).toBe('America/Mexico_City');
        expect(job.insights).toContain('Los reels funcionan mejor');
        // Insights get the brief and the compact digest, not raw posts.
        const insightsCall = llmCalls[1];
        expect(insightsCall.user).toContain('Tengo una pastelería vegana');
        expect(insightsCall.user).toContain('nicheReport');
        expect(insightsCall.user).not.toContain('display_url');
        expect(toCsv(job.results, 'instagram', 'profiles').split('\n')[0]).toContain('engagementRatePct');
    }, 120_000);
});
