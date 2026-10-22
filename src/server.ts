/**
 * REST API for Render (or any container host).
 *
 *   GET    /                web interface (public/index.html; it asks for the API key)
 *   GET    /health
 *   GET    /config          what the server has configured (AI, proxies), for the web interface
 *   POST   /google          { queries, maxPagesPerQuery?, countryCode?, languageCode?, ... }
 *   POST   /scrape          { url | urls, fields?, renderingMode?, ... }   one page per URL, no crawling
 *   POST   /crawl           { startUrls, maxPages?, maxDepth?, ... }       always async
 *   POST   /instagram       { usernames?, discoverQuery?, maxPostsPerProfile?, timeZone?, ... }
 *   POST   /ask             { brief }   the AI plans the scrape from the client's words, runs it and answers
 *   Any POST also accepts "brief": with it, an AI answer to the brief is added to the job ("insights").
 *   GET    /jobs/:id
 *   GET    /jobs/:id/results?format=json|ndjson|csv&offset=0&limit=100
 *   DELETE /jobs/:id
 *
 * /google, /scrape and /instagram wait for the result (up to SYNC_TIMEOUT_SECS) unless `"async": true`.
 * Auth: `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>` when API_KEY is set.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { log } from 'crawlee';
import { abortJob, createJob, fingerprints, getJob, publicJob, type Job, type JobOptions } from './jobs.js';
import { llmConfig } from './ai/llm.js';
import { toCsv } from './shared/csv.js';

const PORT = Number(process.env.PORT ?? 10000);
const API_KEY = process.env.API_KEY ?? '';
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_SECS ?? 120) * 1000;
const MAX_BODY = 1_000_000;

// Read once at startup; works from src/ (tsx) and dist/ (node) alike.
const UI_HTML = (() => {
    try {
        return readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    } catch {
        return undefined;
    }
})();

if (!API_KEY) log.warning('API_KEY is not set: the API is open to anyone who knows the URL.');

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json') {
    const payload = contentType === 'application/json' ? JSON.stringify(body, null, 2) : String(body);
    res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8` });
    res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
        chunks.push(chunk as Buffer);
    }
    if (!chunks.length) return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
    } catch {
        throw new HttpError(400, 'Body must be a JSON object');
    }
}

function authorized(req: IncomingMessage): boolean {
    if (!API_KEY) return true;
    const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const given = Buffer.from(String(header));
    const expected = Buffer.from(API_KEY);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Wait for the job up to the sync timeout; past that, answer 202 with the job to poll. */
async function respondWhenDone(res: ServerResponse, job: Job, isAsync: boolean) {
    if (isAsync) return send(res, 202, publicJob(job));
    const timedOut = await Promise.race([job.done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), SYNC_TIMEOUT_MS).unref())]);
    if (timedOut) return send(res, 202, { ...publicJob(job), message: `Still running; poll GET /jobs/${job.id}` });
    send(res, job.status === 'failed' ? 500 : 200, { ...publicJob(job), results: job.results });
}

function jobOptions(body: Record<string, unknown>): JobOptions {
    const url = body.webhookUrl;
    if (url !== undefined && (typeof url !== 'string' || !/^https:\/\//.test(url))) throw new HttpError(400, 'webhookUrl must be an https URL');
    const brief = body.brief;
    if (brief !== undefined && (typeof brief !== 'string' || !brief.trim() || brief.length > 4000)) throw new HttpError(400, 'brief must be a non-empty string (max 4000 chars)');
    if (brief !== undefined && !llmConfig()) throw new HttpError(400, 'AI is not configured on the server (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY)');
    return { webhookUrl: url as string | undefined, brief: (brief as string | undefined)?.trim() };
}

async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/' && UI_HTML) {
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            // The page only talks to this same server.
            'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
        });
        return res.end(UI_HTML);
    }
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return send(res, 200, { ok: true, service: 'ultimate-scraper', endpoints: ['POST /ask', 'POST /google', 'POST /scrape', 'POST /crawl', 'POST /instagram', 'GET /jobs/:id', 'GET /jobs/:id/results'] });
    }
    if (!authorized(req)) throw new HttpError(401, 'Missing or invalid API key');

    if (req.method === 'GET' && path === '/config') {
        return send(res, 200, { ai: Boolean(llmConfig()), proxies: Boolean(process.env.PROXY_URLS?.trim()) });
    }

    if (req.method === 'POST' && path === '/google') {
        const body = await readJson(req);
        const job = createJob({ ...body, mode: 'google' }, jobOptions(body));
        return respondWhenDone(res, job, body.async === true);
    }
    if (req.method === 'POST' && path === '/scrape') {
        const body = await readJson(req);
        const urls = (body.urls ?? (body.url ? [body.url] : [])) as string[];
        if (!Array.isArray(urls) || !urls.length) throw new HttpError(400, '"url" or "urls" is required');
        if (urls.length > 100) throw new HttpError(400, 'At most 100 URLs per /scrape call; use /crawl for more');
        const job = createJob({ ...body, mode: 'web', startUrls: urls, maxDepth: 0, maxPages: urls.length, useSitemaps: false }, jobOptions(body));
        return respondWhenDone(res, job, body.async === true);
    }
    if (req.method === 'POST' && path === '/ask') {
        const body = await readJson(req);
        const opts = jobOptions(body);
        if (!opts.brief) throw new HttpError(400, '"brief" is required');
        // Always async: planning + scraping + analysis takes minutes.
        return send(res, 202, publicJob(createJob(null, opts)));
    }
    if (req.method === 'POST' && path === '/instagram') {
        const body = await readJson(req);
        const job = createJob({ ...body, mode: 'instagram' }, jobOptions(body));
        return respondWhenDone(res, job, body.async === true);
    }
    if (req.method === 'POST' && path === '/crawl') {
        const body = await readJson(req);
        const job = createJob({ ...body, mode: 'web' }, jobOptions(body));
        return send(res, 202, publicJob(job));
    }

    const m = path.match(/^\/jobs\/([0-9a-f-]{36})(\/results)?$/);
    if (m) {
        const job = req.method === 'DELETE' ? abortJob(m[1]) : getJob(m[1]);
        if (!job) throw new HttpError(404, 'Job not found (jobs expire after JOB_TTL_MINUTES)');
        if (req.method === 'DELETE' || !m[2]) return send(res, 200, publicJob(job));
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get('limit') ?? 1000)));
        const slice = job.results.slice(offset, offset + limit);
        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'csv') return send(res, 200, toCsv(slice, job.mode === 'ask' ? 'web' : job.mode, url.searchParams.get('view') === 'profiles' ? 'profiles' : 'posts'), 'text/csv');
        if (format === 'ndjson') return send(res, 200, slice.map((r) => JSON.stringify(r)).join('\n'), 'application/x-ndjson');
        return send(res, 200, { total: job.results.length, offset, limit, items: slice });
    }
    throw new HttpError(404, 'Not found');
}

const server = createServer((req, res) => {
    route(req, res).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : /^Input error/.test(e.message) ? 400 : 500;
        if (status === 500) log.exception(e, 'Unhandled API error');
        if (!res.headersSent) send(res, status, { error: e.message });
    });
});

server.listen(PORT, () => log.info(`ultimate-scraper API listening on :${PORT}`));

const shutdown = () => {
    fingerprints.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
