import type { ProxyConfigurationOptions } from 'crawlee';

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

export interface Input {
    mode: 'web' | 'google' | 'instagram';
    web: WebInput;
    google: GoogleInput;
    instagram: InstagramInput;
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

type RawInput = Partial<Omit<Input, 'web' | 'google' | 'instagram'>> & Partial<WebInput> & Partial<GoogleInput> & Partial<InstagramInput> & {
    web?: Partial<WebInput>;
    google?: Partial<GoogleInput>;
    instagram?: Partial<InstagramInput>;
    usernames?: string | string[];
    queries?: string | string[];
    startUrls?: (string | { url: string })[];
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

    const mode =
        r.mode ??
        (instagram.usernames.length || instagram.discoverQuery ? 'instagram' : google.queries.length && !web.startUrls.length ? 'google' : 'web');
    if (mode === 'instagram' && !instagram.usernames.length && !instagram.discoverQuery) {
        throw new Error('Input error: "usernames" or "discoverQuery" is required in instagram mode.');
    }
    if (mode === 'web' && !web.startUrls.length) throw new Error('Input error: "startUrls" is required in web mode.');
    if (mode === 'google' && !google.queries.length) throw new Error('Input error: "queries" is required in google mode.');
    for (const { url } of web.startUrls) {
        if (!/^https?:\/\//i.test(url)) throw new Error(`Input error: start URL must be http(s): ${url}`);
    }

    return {
        mode,
        web,
        google,
        instagram,
        maxConcurrency: r.maxConcurrency ?? 10,
        maxRequestRetries: r.maxRequestRetries ?? 3,
        requestTimeoutSecs: r.requestTimeoutSecs ?? 60,
        headless: r.headless ?? true,
        proxyConfiguration: r.proxyConfiguration,
    };
}
