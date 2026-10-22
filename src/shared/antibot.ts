/**
 * Block-page and "needs JavaScript" detection, used to decide when to escalate from
 * plain HTTP to a real browser (or to retire a session/proxy).
 *
 * Layered like crawl4ai's antibot detector: false positives are cheap (we just render the
 * page in a browser), false negatives are expensive (the user gets a garbage record).
 */

export interface BlockVerdict {
    blocked: boolean;
    reason?: string;
}

// Tier 1: structural markers that only appear on block/challenge pages. One hit is enough.
const TIER1: [RegExp, string][] = [
    [/Reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i, 'Akamai block'],
    [/Pardon\s+Our\s+Interruption/i, 'Akamai challenge'],
    [/challenge-form[\s\S]*?__cf_chl_f_tk=/i, 'Cloudflare challenge form'],
    [/<span\s+class="cf-error-code">\d{4}<\/span>/i, 'Cloudflare firewall'],
    [/\/cdn-cgi\/challenge-platform\/\S+orchestrate/i, 'Cloudflare JS challenge'],
    [/<title>\s*Just a moment\.\.\.\s*<\/title>/i, 'Cloudflare interstitial'],
    [/window\._pxAppId\s*=/i, 'PerimeterX'],
    [/captcha\.px-cdn\.net/i, 'PerimeterX captcha'],
    [/captcha-delivery\.com/i, 'DataDome captcha'],
    [/_Incapsula_Resource/i, 'Imperva/Incapsula'],
    [/Incapsula\s+incident\s+ID/i, 'Imperva/Incapsula incident'],
    [/Sucuri\s+WebSite\s+Firewall/i, 'Sucuri firewall'],
    [/ips\.js\?.*KPSDK|x-kpsdk/i, 'Kasada'],
    [/google\.com\/sorry\/index|id="captcha-form"/i, 'Google unusual-traffic page'],
];

// Tier 2: generic phrases. Only trusted on short pages or together with an error status,
// because real articles can talk about "captchas" or "access denied".
const TIER2: [RegExp, string][] = [
    [/verify (that )?you are (a )?human/i, 'human verification'],
    [/are you a robot/i, 'robot check'],
    [/unusual traffic from your computer/i, 'unusual traffic'],
    [/access (to this page has been )?denied/i, 'access denied'],
    [/g-recaptcha|h-captcha|hcaptcha\.com|turnstile/i, 'captcha widget'],
    [/request (has been )?blocked/i, 'request blocked'],
    [/too many requests/i, 'rate limited'],
];

const SHORT_PAGE_CHARS = 15_000;

export function detectBlock(html: string, statusCode?: number): BlockVerdict {
    if (statusCode === 429) return { blocked: true, reason: 'HTTP 429 rate limit' };
    if ((statusCode === 403 || statusCode === 503) && /<html|<body/i.test(html)) {
        return { blocked: true, reason: `HTTP ${statusCode}` };
    }
    for (const [re, reason] of TIER1) if (re.test(html)) return { blocked: true, reason };

    const short = html.length < SHORT_PAGE_CHARS;
    const errorStatus = statusCode !== undefined && statusCode >= 400;
    if (short || errorStatus) {
        for (const [re, reason] of TIER2) if (re.test(html)) return { blocked: true, reason };
    }
    return { blocked: false };
}

/**
 * True when the HTML is an empty shell that only renders with JavaScript
 * (SPA root div, "enable JavaScript" notices, or almost no visible text but plenty of script).
 */
export function needsJavaScript(html: string, visibleText: string): boolean {
    const text = visibleText.replace(/\s+/g, ' ').trim();
    if (/please enable javascript|you need to enable javascript|requires javascript to run/i.test(text) && text.length < 2_000) {
        return true;
    }
    const scripts = (html.match(/<script\b/gi) ?? []).length;
    const spaRoot = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
    if (spaRoot && text.length < 500) return true;
    return text.length < 200 && scripts >= 3;
}
