import { isIP } from 'node:net';
import type { ProxyConfigurationOptions } from 'crawlee';

/**
 * SSRF guard (added 23 oct 2026, per the deploy guide's own note: "haz una
 * revisión de seguridad específica de SSRF/redirecciones... API_KEY
 * protege el acceso, pero no sustituye esa revisión"). Synchronous by
 * design -- normalizeInput() is called synchronously from server.ts/jobs.ts
 * and making this async would mean threading `await` through the whole
 * request path. This blocks the common, cheap case (a literal private/
 * loopback/link-local IP, or a known-internal hostname) -- it does NOT
 * protect against a public hostname that resolves to a private IP at
 * request time (DNS rebinding), which would need an async check at the
 * point crawlee actually dials the connection.
 */
function assertPublicHost(url: string): void {
    // vitest setea NODE_ENV=test automáticamente (confirmado corriendo la
    // suite) -- tests/web.test.ts levanta un servidor HTTP real en
    // localhost (tests/site.js) y rastrea CONTRA él a propósito, caso de
    // uso legítimo que esta guardia bloquearía si no se exceptuara. No
    // se toca en ningún entorno real (Docker/Render nunca corre con
    // NODE_ENV=test).
    if (process.env.NODE_ENV === 'test') return;
    const hostname = new URL(url).hostname;
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
        throw new Error(`Input error: internal host not allowed: ${hostname}`);
    }
    const kind = isIP(hostname);
    if (kind === 4) {
        const [a, b] = hostname.split('.').map(Number);
        const isPrivate = a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
        if (isPrivate) throw new Error(`Input error: private/internal IP not allowed: ${hostname}`);
    } else if (kind === 6) {
        const low = hostname.toLowerCase();
        if (low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('::ffff:127.')) {
            throw new Error(`Input error: private/internal IP not allowed: ${hostname}`);
        }
    }
}

/** A field to extract with a CSS selector. A plain string is shorthand for `{ selector }`. */
export interface FieldSpec {
    selector: string;
    /** Attribute to read instead of the text (e.g. `href`, `src`, `content`). */
    attr?: string;
    /** Return every match instead of the first one. */
    all?: boolean;
}

export interface WebInput {
    startUrls: { url: string }[];
    maxPages: number;
    maxDepth: number;
    sameDomain: boolean;
    includeGlobs: string[];
    excludeGlobs: string[];
    useSitemaps: boolean;
    respectRobotsTxt: boolean;
    /** `auto` tries plain HTTP first and escalates to a browser when the page is blocked or needs JavaScript. */
    renderingMode: 'auto' | 'http' | 'browser';
    waitForSelector?: string;
    infiniteScroll: boolean;
    removeSelectors: string[];
    fields: Record<string, string | FieldSpec>;
    /** Relocate `fields` by similarity when their selector stops matching (Scrapling-style). */
    adaptiveSelectors: boolean;
    saveMarkdown: boolean;
    saveHtml: boolean;
    saveLinks: boolean;
    extractContacts: boolean;
}

export interface GoogleInput {
    queries: string[];
    maxPagesPerQuery: number;
    countryCode?: string;
    languageCode: string;
    googleDomain: string;
    /** `auto` tries the no-JavaScript HTML first, then a real browser. */
    renderingMode: 'auto' | 'http' | 'browser';
    saveHtml: boolean;
}

export interface InstagramInput {
    /** Usernames, @handles or profile URLs. */
    usernames: string[];
    maxPostsPerProfile: number;
    /** Only analyze posts from the last N days. */
    daysBack?: number;
    /** IANA timezone for "best day / hour" (e.g. America/Mexico_City). */
    timeZone: string;
    /** Find more profiles of the niche with Google: site:instagram.com <discoverQuery>. */
    discoverQuery?: string;
    discoverMaxProfiles: number;
    includePosts: boolean;
    renderingMode: 'auto' | 'http' | 'browser';
}

/**
 * 29 oct 2026: Facebook Pages (negocios/creadores), público, sin login.
 * A diferencia de Instagram, acá no hay un endpoint JSON anónimo documentado
 * y estable -- en vez de parsear HTML a mano (frágil, sin forma de probarlo
 * contra Facebook real desde acá), esto delega en el motor `web` genérico
 * (extractPage(): OpenGraph, JSON-LD, selectores adaptativos, contactos),
 * apuntado a la sección "About" de cada página -- ver facebook/crawler.ts.
 */
export interface FacebookInput {
    /** Usernames, @handles o URLs completas de facebook.com/<page>. */
    pages: string[];
    /** `auto` cae a 'browser' -- la sección About casi siempre necesita JS. */
    renderingMode: 'auto' | 'http' | 'browser';
}

/**
 * 30 oct 2026 -- Fase 1 del plan de integración de Harvey (ver osm/discover.ts
 * para el detalle completo y el disclaimer de cobertura real). Gratis, sin
 * proxy, sin API key -- API pública de OpenStreetMap (Nominatim + Overpass).
 */
export interface OsmInput {
    /** Rubro -- debe matchear un término de osm/discover.ts's TAG_MAP. */
    term: string;
    /** Ciudad/zona a geocodificar, ej. "Los Angeles, CA". */
    location: string;
    radiusKm: number;
    maxResults: number;
}

export interface Input {
    mode: 'web' | 'google' | 'instagram' | 'facebook' | 'osm';
    web: WebInput;
    google: GoogleInput;
    instagram: InstagramInput;
    facebook: FacebookInput;
    osm: OsmInput;
    maxConcurrency: number;
    maxRequestRetries: number;
    requestTimeoutSecs: number;
    headless: boolean;
    proxyConfiguration?: ProxyConfigurationOptions & { useApifyProxy?: boolean; apifyProxyGroups?: string[]; apifyProxyCountry?: string };
}

const WEB_DEFAULTS: WebInput = {
    startUrls: [],
    maxPages: 100,
    maxDepth: 2,
    sameDomain: true,
    includeGlobs: [],
    excludeGlobs: [],
    useSitemaps: false,
    respectRobotsTxt: true,
    renderingMode: 'auto',
    waitForSelector: undefined,
    infiniteScroll: false,
    removeSelectors: [],
    fields: {},
    adaptiveSelectors: true,
    saveMarkdown: true,
    saveHtml: false,
    saveLinks: false,
    extractContacts: false,
};

const GOOGLE_DEFAULTS: GoogleInput = {
    queries: [],
    maxPagesPerQuery: 1,
    countryCode: undefined,
    languageCode: 'en',
    googleDomain: 'google.com',
    renderingMode: 'auto',
    saveHtml: false,
};

const INSTAGRAM_DEFAULTS: InstagramInput = {
    usernames: [],
    maxPostsPerProfile: 36,
    daysBack: undefined,
    timeZone: 'UTC',
    discoverQuery: undefined,
    discoverMaxProfiles: 10,
    includePosts: true,
    renderingMode: 'auto',
};

const FACEBOOK_DEFAULTS: FacebookInput = {
    pages: [],
    renderingMode: 'auto',
};

const OSM_DEFAULTS: OsmInput = {
    term: '',
    location: '',
    radiusKm: 25,
    maxResults: 50,
};

type RawInput = Partial<Omit<Input, 'web' | 'google' | 'instagram' | 'facebook' | 'osm'>> & Partial<WebInput> & Partial<GoogleInput> & Partial<InstagramInput> & Partial<FacebookInput> & Partial<OsmInput> & {
    web?: Partial<WebInput>;
    google?: Partial<GoogleInput>;
    instagram?: Partial<InstagramInput>;
    facebook?: Partial<FacebookInput>;
    osm?: Partial<OsmInput>;
    usernames?: string | string[];
    queries?: string | string[];
    startUrls?: (string | { url: string })[];
    pages?: string | string[];
};

/**
 * Accepts both a flat input (Apify console style) and a nested `{ web, google, instagram }` input,
 * applies defaults and validates the few things that would otherwise fail deep inside a crawler.
 */
export function normalizeInput(raw: RawInput | null | undefined): Input {
    const r: RawInput = raw ?? {};
    const pick = <T extends object>(defaults: T, nested?: Partial<T>): T => {
        const out = { ...defaults };
        for (const key of Object.keys(defaults) as (keyof T)[]) {
            const flat = (r as Record<string, unknown>)[key as string];
            if (flat !== undefined) out[key] = flat as T[keyof T];
            if (nested?.[key] !== undefined) out[key] = nested[key] as T[keyof T];
        }
        return out;
    };

    const web = pick(WEB_DEFAULTS, r.web as Partial<WebInput>);
    web.startUrls = ((r.web?.startUrls ?? r.startUrls ?? []) as (string | { url: string })[])
        .map((u) => (typeof u === 'string' ? { url: u } : u))
        .filter((u) => u?.url);

    const google = pick(GOOGLE_DEFAULTS, r.google as Partial<GoogleInput>);
    const queries: string | string[] = (r.google?.queries as string | string[] | undefined) ?? r.queries ?? [];
    google.queries = (Array.isArray(queries) ? queries : queries.split('\n')).map((q: string) => q.trim()).filter(Boolean);

    const instagram = pick(INSTAGRAM_DEFAULTS, r.instagram as Partial<InstagramInput>);
    const users: string | string[] = (r.instagram?.usernames as string | string[] | undefined) ?? r.usernames ?? [];
    instagram.usernames = (Array.isArray(users) ? users : users.split(/[\n,]/)).map((u: string) => u.trim()).filter(Boolean);
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: instagram.timeZone });
    } catch {
        throw new Error(`Input error: unknown timeZone "${instagram.timeZone}"`);
    }

    const facebook = pick(FACEBOOK_DEFAULTS, r.facebook as Partial<FacebookInput>);
    const fbPages: string | string[] = (r.facebook?.pages as string | string[] | undefined) ?? r.pages ?? [];
    facebook.pages = (Array.isArray(fbPages) ? fbPages : fbPages.split(/[\n,]/)).map((u: string) => u.trim()).filter(Boolean);

    // osm: sin heurística de auto-detección (a diferencia de facebook/instagram,
    // "term" + "location" no son señales exclusivas de este modo) -- siempre
    // explícito vía `mode: 'osm'`.
    const osm = pick(OSM_DEFAULTS, r.osm as Partial<OsmInput>);
    osm.term = osm.term.trim();
    osm.location = osm.location.trim();

    const mode =
        r.mode ??
        (facebook.pages.length
            ? 'facebook'
            : instagram.usernames.length || instagram.discoverQuery
              ? 'instagram'
              : google.queries.length && !web.startUrls.length
                ? 'google'
                : 'web');
    if (mode === 'instagram' && !instagram.usernames.length && !instagram.discoverQuery) {
        throw new Error('Input error: "usernames" or "discoverQuery" is required in instagram mode.');
    }
    if (mode === 'facebook' && !facebook.pages.length) throw new Error('Input error: "pages" is required in facebook mode.');
    if (mode === 'osm' && (!osm.term || !osm.location)) throw new Error('Input error: "term" and "location" are required in osm mode.');
    if (mode === 'web' && !web.startUrls.length) throw new Error('Input error: "startUrls" is required in web mode.');
    if (mode === 'google' && !google.queries.length) throw new Error('Input error: "queries" is required in google mode.');
    for (const { url } of web.startUrls) {
        if (!/^https?:\/\//i.test(url)) throw new Error(`Input error: start URL must be http(s): ${url}`);
        assertPublicHost(url);
    }

    return {
        mode,
        web,
        google,
        instagram,
        facebook,
        osm,
        maxConcurrency: r.maxConcurrency ?? 10,
        maxRequestRetries: r.maxRequestRetries ?? 3,
        requestTimeoutSecs: r.requestTimeoutSecs ?? 60,
        headless: r.headless ?? true,
        proxyConfiguration: r.proxyConfiguration,
    };
}
