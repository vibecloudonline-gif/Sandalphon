/**
 * Public Facebook Pages (businesses/creators), logged out.
 *
 * Unlike Instagram, there is no documented/stable anonymous JSON endpoint for
 * a Facebook Page's "About" info -- hand-parsing Facebook's obfuscated,
 * frequently-rotated HTML classes would be fragile and, critically, cannot be
 * verified from this environment against a live Facebook page. Instead this
 * is a thin preset over the already-proven generic `web` engine
 * (`web/crawler.ts` + `web/extract.ts`): same proxy/escalation/adaptive-
 * selector machinery used for every other site, pointed at each Page's
 * `/about` URL, with:
 *   - `renderingMode: 'browser'` by default -- the About section is almost
 *     always client-rendered.
 *   - OpenGraph metadata (title/description/image) and JSON-LD, which
 *     `extractPage()` already pulls for free -- Facebook invented and still
 *     relies on OG tags for link previews, so these are usually reliable.
 *   - `extractContacts: true` for phone/email/website links.
 *   - best-effort CSS selectors for the handful of About-section fields that
 *     are NOT in OpenGraph (phone, address, hours, category). These WILL
 *     need upkeep as Facebook's markup changes -- `adaptiveSelectors`
 *     (shared/adaptive.ts) already covers a selector silently relocating to
 *     a different element between crawls, same safety net Instagram and the
 *     generic web crawler already rely on.
 */
import type { FieldSpec, FacebookInput, Input } from '../input.js';
import { runWeb, type WebRunResult } from '../web/crawler.js';
import type { PageRecord } from '../web/extract.js';
import type { Emit } from '../shared/setup.js';

/** Best-effort -- Facebook's class names are obfuscated/rotated; `aria-label`s tend to outlive them. */
const ABOUT_FIELDS: Record<string, string | FieldSpec> = {
    phone: { selector: 'a[href^="tel:"]', attr: 'href' },
    website: { selector: 'a[href^="http"]:not([href*="facebook.com"])', attr: 'href' },
    address: 'div[aria-label="Address"], span:has(> a[href*="/maps"])',
    hours: 'div[aria-label*="Hours" i]',
    category: 'a[href*="/pages/category/"], a[href*="/pg/"][href*="category"]',
    priceRange: 'span:contains("Price range")',
    rating: '[aria-label*="stars" i], [aria-label*="estrellas" i]',
    likes: 'a[href*="friends_likes"], a[href*="/followers/"]',
};

export function normalizeFacebookPageUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
            return u.pathname.endsWith('/about') ? u.href : `${u.href.replace(/\/$/, '')}/about`;
        } catch {
            return null;
        }
    }
    const handle = s.replace(/^@/, '').replace(/^facebook\.com\//i, '');
    return handle ? `https://www.facebook.com/${handle}/about` : null;
}

/** Builds the `web` mode Input that actually drives the crawl -- `runFacebook()` is the only exported entry point jobs.ts needs. */
export function toFacebookWebInput(input: Input): Input {
    const fb = input.facebook;
    const startUrls = fb.pages
        .map(normalizeFacebookPageUrl)
        .filter((u): u is string => !!u)
        .map((url) => ({ url }));
    if (!startUrls.length) throw new Error('Input error: no valid facebook.com page in "pages" (usernames, @handles or full URLs).');

    return {
        ...input,
        mode: 'web',
        web: {
            ...input.web,
            startUrls,
            maxPages: startUrls.length,
            maxDepth: 0,
            sameDomain: true,
            renderingMode: fb.renderingMode === 'auto' ? 'browser' : fb.renderingMode,
            fields: { ...ABOUT_FIELDS, ...input.web.fields },
            extractContacts: true,
            saveMarkdown: true,
            adaptiveSelectors: true,
        },
    };
}

export async function runFacebook(input: Input, emit: Emit<PageRecord>, signal?: AbortSignal): Promise<WebRunResult> {
    return runWeb(toFacebookWebInput(input), emit, undefined, signal);
}
