export interface SerpPageRequest {
    term: string;
    page: number; // 1-based
    url: string;
}

/**
 * Google ignores `num` since late 2025, so results are always paginated 10 at a time with `start`.
 * A query that is already a Google search URL is used as-is (page 1).
 */
export function buildSerpUrls(query: string, opts: { maxPages: number; countryCode?: string; languageCode: string; googleDomain: string }): SerpPageRequest[] {
    if (/^https?:\/\/(www\.)?google\.[a-z.]+\/search\?/i.test(query)) {
        const term = new URL(query).searchParams.get('q') ?? query;
        return [{ term, page: 1, url: query }];
    }
    const out: SerpPageRequest[] = [];
    for (let page = 1; page <= opts.maxPages; page++) {
        // GOOGLE_BASE_URL only exists for the local test server.
        const origin = process.env.GOOGLE_BASE_URL ?? `https://www.${opts.googleDomain.replace(/^www\./, '')}`;
        const u = new URL('/search', origin);
        u.searchParams.set('q', query);
        u.searchParams.set('hl', opts.languageCode);
        if (opts.countryCode) u.searchParams.set('gl', opts.countryCode.toLowerCase());
        if (page > 1) u.searchParams.set('start', String((page - 1) * 10));
        // Exact results, no autocorrection to a different query.
        u.searchParams.set('pws', '0');
        out.push({ term: query, page, url: u.href });
    }
    return out;
}

/** Google wraps outbound links as /url?q=<target>&sa=...; unwrap them and drop Google-internal links. */
export function unwrapGoogleHref(href: string | undefined, base = 'https://www.google.com'): string | undefined {
    if (!href) return undefined;
    let url: URL;
    try {
        url = new URL(href, base);
    } catch {
        return undefined;
    }
    const fromSerpHost = /(^|\.)google\.[a-z.]+$/i.test(url.hostname) || url.host === new URL(base).host;
    if (fromSerpHost && url.pathname === '/url') {
        const target = url.searchParams.get('q') ?? url.searchParams.get('url');
        if (!target) return undefined;
        try {
            url = new URL(target);
        } catch {
            return undefined;
        }
    }
    if (!/^https?:$/.test(url.protocol)) return undefined;
    if (/(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|googleadservices\.com)$/i.test(url.hostname) && !/^(maps|books|support|developers|cloud|blog)\./.test(url.hostname)) {
        return undefined;
    }
    return url.href;
}
