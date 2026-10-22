/**
 * Turns one HTML page into a clean record: metadata, JSON-LD, readable Markdown,
 * custom fields (with adaptive relocation), links and contacts.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import TurndownService from 'turndown';
import { FingerprintStore, fingerprint, relocate } from '../shared/adaptive.js';
import type { FieldSpec, WebInput } from '../input.js';

export interface PageRecord {
    url: string;
    loadedUrl: string;
    statusCode?: number;
    renderedWith: 'http' | 'browser';
    depth: number;
    crawledAt: string;
    metadata: Record<string, string | undefined>;
    headings: { h1: string[]; h2: string[] };
    jsonLd: unknown[];
    fields?: Record<string, string | string[] | null>;
    relocatedFields?: string[];
    markdown?: string;
    html?: string;
    links?: string[];
    contacts?: { emails: string[]; phones: string[]; social: string[] };
}

// Boilerplate stripped before Markdown conversion (crawl4ai/Firecrawl "only main content" idea).
const ALWAYS_REMOVE = 'script, style, noscript, template, svg, canvas, iframe, object, embed, link, meta, form, button, input, select, textarea';
const LAYOUT_REMOVE = 'header, footer, nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-modal="true"], [hidden]';
const BOILERPLATE_RE = /(^|[\s_-])(cookie|consent|gdpr|banner|advert|ads?|sponsor|promo|popup|modal|newsletter|subscribe|share|social|breadcrumb|sidebar|related|recommend|comment-form|skip-link|sr-only|visually-hidden)([\s_-]|$)/i;

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style']);

export interface ExtractContext {
    url: string;
    loadedUrl?: string;
    statusCode?: number;
    renderedWith: 'http' | 'browser';
    depth: number;
    options: WebInput;
    fingerprints?: FingerprintStore;
}

export function extractPage(html: string, ctx: ExtractContext): PageRecord {
    const $ = load(html);
    const loadedUrl = ctx.loadedUrl ?? ctx.url;
    const record: PageRecord = {
        url: ctx.url,
        loadedUrl,
        statusCode: ctx.statusCode,
        renderedWith: ctx.renderedWith,
        depth: ctx.depth,
        crawledAt: new Date().toISOString(),
        metadata: extractMetadata($, loadedUrl),
        headings: {
            h1: $('h1').toArray().map((e) => clean($(e).text())).filter(Boolean),
            h2: $('h2').toArray().map((e) => clean($(e).text())).filter(Boolean).slice(0, 30),
        },
        jsonLd: extractJsonLd($),
    };

    const o = ctx.options;
    if (Object.keys(o.fields).length) {
        const { values, relocated } = extractFields($, o.fields, hostOf(loadedUrl), o.adaptiveSelectors ? ctx.fingerprints : undefined);
        record.fields = values;
        if (relocated.length) record.relocatedFields = relocated;
    }
    if (o.saveLinks || o.extractContacts) {
        const links = extractLinks($, loadedUrl);
        if (o.saveLinks) record.links = links;
        if (o.extractContacts) record.contacts = extractContacts($, links);
    }
    if (o.saveHtml) record.html = html;
    if (o.saveMarkdown) record.markdown = toMarkdown($, o.removeSelectors, loadedUrl);
    return record;
}

export const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
};

function extractMetadata($: CheerioAPI, url: string): Record<string, string | undefined> {
    const meta = (sel: string) => $(sel).attr('content')?.trim() || undefined;
    const out: Record<string, string | undefined> = {
        title: clean($('title').first().text()) || meta('meta[property="og:title"]'),
        description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
        canonical: absolutize($('link[rel="canonical"]').attr('href'), url),
        language: $('html').attr('lang') || meta('meta[http-equiv="content-language"]'),
        author: meta('meta[name="author"]'),
        keywords: meta('meta[name="keywords"]'),
        publishedTime: meta('meta[property="article:published_time"]'),
        image: absolutize(meta('meta[property="og:image"]'), url),
    };
    $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
        const key = $(el).attr('property') ?? $(el).attr('name');
        const val = $(el).attr('content');
        if (key && val && !(key in out)) out[key] = val.trim();
    });
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

function extractJsonLd($: CheerioAPI): unknown[] {
    const out: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text().trim();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            const graph = (parsed as { '@graph'?: unknown[] })?.['@graph'];
            if (Array.isArray(parsed)) out.push(...parsed);
            else if (Array.isArray(graph)) out.push(...graph);
            else out.push(parsed);
        } catch {
            // Sites often ship invalid JSON-LD; skip it rather than fail the page.
        }
    });
    return out;
}

function readField($: CheerioAPI, els: Element[], spec: FieldSpec): string | string[] | null {
    const read = (el: Element) => (spec.attr ? $(el).attr(spec.attr)?.trim() ?? '' : clean($(el).text()));
    if (spec.all) return els.map(read).filter(Boolean);
    return els.length ? read(els[0]) || null : null;
}

export function extractFields(
    $: CheerioAPI,
    fields: Record<string, string | FieldSpec>,
    host: string,
    store?: FingerprintStore,
): { values: Record<string, string | string[] | null>; relocated: string[] } {
    const values: Record<string, string | string[] | null> = {};
    const relocated: string[] = [];
    for (const [name, raw] of Object.entries(fields)) {
        const spec: FieldSpec = typeof raw === 'string' ? { selector: raw } : raw;
        const key = `${host}::${name}::${spec.selector}`;
        let els: Element[] = [];
        try {
            els = $(spec.selector).toArray() as Element[];
        } catch {
            // Invalid selector: fall through to relocation / null.
        }
        if (els.length) {
            store?.set(key, fingerprint(els[0]));
        } else if (store?.get(key)) {
            els = relocate($, store.get(key)!);
            if (els.length) relocated.push(name);
        }
        values[name] = readField($, els, spec);
    }
    return { values, relocated };
}

function absolutize(href: string | undefined, base: string): string | undefined {
    if (!href) return undefined;
    try {
        return new URL(href, base).href;
    } catch {
        return undefined;
    }
}

export function extractLinks($: CheerioAPI, base: string): string[] {
    const set = new Set<string>();
    $('a[href]').each((_, el) => {
        const abs = absolutize($(el).attr('href'), base);
        if (abs && /^(https?|mailto|tel):/i.test(abs)) set.add(abs.split('#')[0]);
    });
    return [...set];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const SOCIAL_RE = /^https?:\/\/(www\.)?(facebook|instagram|linkedin|twitter|x|tiktok|youtube|pinterest|github|t)\.(com|me)\//i;

function extractContacts($: CheerioAPI, links: string[]) {
    const emails = new Set<string>();
    const phones = new Set<string>();
    const social = new Set<string>();
    for (const l of links) {
        if (l.startsWith('mailto:')) emails.add(decodeURIComponent(l.slice(7).split('?')[0]).toLowerCase());
        else if (l.startsWith('tel:')) phones.add(decodeURIComponent(l.slice(4)).replace(/[^\d+]/g, ''));
        else if (SOCIAL_RE.test(l)) social.add(l);
    }
    const text = $('body').text();
    for (const m of text.match(EMAIL_RE) ?? []) {
        if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(m)) emails.add(m.toLowerCase());
    }
    return { emails: [...emails], phones: [...phones].filter((p) => p.replace('+', '').length >= 7), social: [...social] };
}

function toMarkdown($: CheerioAPI, removeSelectors: string[], base: string): string {
    const $c = load($.html());
    $c(ALWAYS_REMOVE).remove();
    for (const sel of removeSelectors) {
        try {
            $c(sel).remove();
        } catch {
            // ignore invalid user selector
        }
    }
    const root = $c('main, article, [role="main"], #content, #main, .content, .post, .entry-content').first();
    const scope = root.length ? root : $c('body');
    scope.find(LAYOUT_REMOVE).remove();
    scope.find('[class], [id]').each((_, el) => {
        const e = $c(el);
        const tag = (el as Element).name;
        if (tag === 'main' || tag === 'article' || tag === 'body') return;
        const sig = `${e.attr('class') ?? ''} ${e.attr('id') ?? ''}`;
        if (BOILERPLATE_RE.test(sig)) e.remove();
    });
    // Absolute URLs so the Markdown still works outside the site.
    scope.find('a[href]').each((_, el) => {
        const abs = absolutize($c(el).attr('href'), base);
        if (abs) $c(el).attr('href', abs);
    });
    scope.find('img[src]').each((_, el) => {
        const abs = absolutize($c(el).attr('src'), base);
        if (abs) $c(el).attr('src', abs);
    });
    const html = scope.html() ?? '';
    return turndown
        .turndown(html)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
