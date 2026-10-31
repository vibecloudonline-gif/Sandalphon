/**
 * SERP parsing for both kinds of page Google serves:
 *  - the basic no-JavaScript HTML (what a Lynx user agent gets), and
 *  - the full JavaScript-rendered page (what a real browser gets).
 * Several selector sets are tried and merged, because Google rotates class names often;
 * the structural fallbacks (an <a> holding an <h3>, `/url?q=` links) survive most redesigns.
 * Output shape follows Apify's Google Search Results Scraper.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { clean } from '../web/extract.js';
import { unwrapGoogleHref } from './url.js';

export interface OrganicResult {
    position: number;
    title: string;
    url: string;
    displayedUrl?: string;
    description?: string;
    date?: string;
    siteLinks?: { title: string; url: string }[];
    /** Local Pack results only (star rating + review count) -- see addOrganic(). */
    rating?: number;
    reviewsCount?: number;
}

export interface PaidResult {
    adPosition: number;
    title: string;
    url: string;
    displayedUrl?: string;
    description?: string;
}

export interface SerpParse {
    organicResults: OrganicResult[];
    paidResults: PaidResult[];
    peopleAlsoAsk: { question: string }[];
    relatedQueries: { title: string; url: string }[];
    resultsTotal?: number;
    hasNextPage: boolean;
}

const SNIPPET_SELECTORS = ['.VwiC3b', '[data-sncf="1"]', '[data-sncf="2"]', 'div[style*="-webkit-line-clamp"]', '.IsZvec', '.s3v9rd', '.BNeawe.s3v9rd', '.FrIlee', 'span.st'];
const CONTAINER_SELECTORS = '[data-hveid], .g, .MjjYud, .tF2Cxc, .ezO2md, .Gx5Zad, .xpd';
const DATE_RE = /^(\d{1,2} \w{3,9} \d{4}|\w{3,9} \d{1,2}, \d{4}|\d+ (hours?|days?|weeks?|minutes?) ago)\s*[—–-]\s*/i;

export function parseSerp(html: string, base = 'https://www.google.com'): SerpParse {
    const $ = load(html);
    const paidResults = parseAds($, base);
    const adUrls = new Set(paidResults.map((a) => a.url));
    const organic = new Map<string, Omit<OrganicResult, 'position'>>();

    // Strategy 1 (full page): every result title is an <h3> inside a link.
    $('#search a:has(h3), #rso a:has(h3), #center_col a:has(h3)').each((_, a) => {
        if ($(a).closest('#tads, #bottomads, [data-text-ad], .commercial-unit-desktop-top').length) return;
        addOrganic($, organic, a as Element, clean($(a).find('h3').first().text()), base, adUrls);
    });

    // Strategy 1b (Local Pack, confirmed real 30 oct 2026 against a live search
    // for "nutritionist private practice California"): Google now also answers
    // local-intent queries with a block of real businesses under a "Places"
    // heading, using `[role="heading"]` instead of a literal <h3>, and wrapping
    // the outbound link in an opaque `/goto?url=<encoded blob>` that can't be
    // decoded client-side -- but each card also carries a plain `<a data-url>`
    // with the real destination, which addOrganic() now prefers over the
    // encoded href. Each business actually has 2 `data-url` anchors (its real
    // site, and a `/maps/dir/...` "directions" link) -- filtering to `http`
    // keeps only the real one. The title isn't a DOM ancestor/descendant of
    // this anchor (confirmed against the real markup), so both are located
    // independently via the same CONTAINER_SELECTORS scope addOrganic()
    // already uses for the description/siteLinks/rating lookup below.
    //
    // CORRECCIÓN (31 oct 2026, bug real encontrado con evidencia -- una
    // búsqueda real de "nutritionist Los Angeles CA" devolvía 0 resultados
    // pese a tener un Local Pack real en el HTML, confirmado con grep de
    // `rllt__details`/ratings/Directions): el widget de Local Pack NO
    // siempre vive dentro de `#search`/`#rso` -- esta vez estaba en otro
    // contenedor del documento (confirmado trazando los ancestros del
    // anchor real hasta la raíz). Restringir a esos 2 IDs es una suposición
    // de estructura que no siempre se cumple; `data-url^="http"` ya es un
    // atributo lo bastante específico de Google (solo lo emite para links
    // de negocios del Local Pack) como para no necesitar ese scope --
    // verificado sin regresión contra un HTML real previo que sí tenía el
    // Local Pack dentro de #search (3/3 resultados idénticos antes/después).
    $('a[data-url^="http"]').each((_, a) => {
        if ($(a).closest('#tads, #bottomads, [data-text-ad], .commercial-unit-desktop-top').length) return;
        const scope = $(a).closest(CONTAINER_SELECTORS);
        const title = clean(scope.find('[role="heading"]').first().text());
        if (!title) return; // not a Local Pack card (People Also Ask, AI Overview, etc. have no heading in this scope)
        addOrganic($, organic, a as Element, title, base, adUrls);
    });

    // Strategy 1c (Local Pack sin sitio web -- confirmado real 31 oct 2026
    // contra búsquedas de "gym"/"supplement store": muchos negocios reales
    // (sobre todo gimnasios independientes chicos, que es justo el rubro
    // objetivo) no tienen botón "Website", solo "Directions" -- Strategy 1b
    // los pierde por completo porque solo mira el anchor `data-url^="http"`,
    // aunque el nombre/teléfono/rating están igual en texto plano dentro de
    // la misma card. El anchor de "Directions" (`data-url^="/maps/dir/"`)
    // SÍ está presente en el 100% de las cards del Local Pack, con o sin
    // sitio web -- sirve de ancla universal. Se usa ese link de Maps como
    // `url` del lead solo cuando la card no tiene sitio real (si lo tiene,
    // Strategy 1b ya la agregó con la url real, deduplicado por `title`).
    const titlesWithRealSite = new Set([...organic.values()].map((r) => r.title));
    $('a[data-url^="/maps/dir/"]').each((_, a) => {
        const $a = $(a);
        if ($a.closest('#tads, #bottomads, [data-text-ad], .commercial-unit-desktop-top').length) return;
        const scope = $a.closest(CONTAINER_SELECTORS);
        const title = clean(scope.find('[role="heading"]').first().text());
        if (!title || titlesWithRealSite.has(title)) return;
        const mapsHref = $a.attr('data-url');
        if (!mapsHref) return;
        addOrganic($, organic, a as Element, title, base, adUrls, new URL(mapsHref, base).href);
    });

    // Strategy 1d (Local Pack sin ningún link navegable -- confirmado real
    // 31 oct 2026 contra "supplement store Los Angeles CA"): esta variante
    // del widget (carrusel horizontal, confirmado con evidencia real contra
    // el HTML en vivo) no envuelve cada card en un <a> en absoluto -- la
    // navegación es vía JS sobre un <div>, sin href ni data-url, así que ni
    // 1b ni 1c encuentran nada. Mismo texto plano que las otras variantes
    // (nombre, rating, categoría, ciudad, teléfono) -- se extrae directo del
    // contenedor usando [role="heading"] + el aria-label de rating como
    // ancla doble (evita falsos positivos: controles de UI como "Choose
    // what you're giving feedback on" también son role="heading" pero
    // nunca tienen un rating al lado). Clave sintética (nombre+teléfono),
    // no hay url real para deduplicar.
    //
    // Scope restringido a `[class*="rllt"]` (no al CONTAINER_SELECTORS
    // genérico de más arriba): confirmado con evidencia real que ese
    // selector ancho matchea también el wrapper de TODO el widget (ej. el
    // heading de grupo "Places"/"Businesses"), y como `.find()` busca
    // hacia abajo, ese wrapper "hereda" el rating del primer negocio real
    // dentro -- generaba un lead falso con el nombre del heading de grupo.
    // `rllt__details`/`rllt__borderless` son las clases que Google usa
    // específicamente por card individual, confirmado 1:1 contra los 3
    // negocios reales de esta variante (sin falsos positivos).
    const titlesSeen = new Set([...organic.values()].map((r) => r.title));
    $('[role="heading"]').each((_, h) => {
        const $h = $(h);
        const title = clean($h.text());
        if (!title || titlesSeen.has(title)) return;
        const scope = $h.closest('[class*="rllt"]');
        if (!scope.length) return;
        const ratingLabel = scope.find('[aria-label*="Rated" i], [aria-label*="Calificado" i]').first().attr('aria-label');
        if (!ratingLabel) return; // sin rating al lado, no es una card de negocio del Local Pack
        titlesSeen.add(title);
        const text = clean(scope.text());
        const phone = text.match(/\(\d{3}\)\s?\d{3}-\d{4}/)?.[0];
        addOrganic($, organic, h as unknown as Element, title, base, adUrls, `local-pack:${title}::${phone ?? ''}`);
    });

    // Strategy 2 (basic HTML / Lynx): /url?q= links whose text is the title.
    if (organic.size === 0) {
        $('a[href^="/url?q="], a[href*="google.com/url?q="]').each((_, a) => {
            const $a = $(a);
            const title = clean($a.find('h3, .CVA68e, .BNeawe.vvjwJb, .DKV0Md, span').first().text() || $a.text());
            if (!title || title.length < 3) return;
            // Skip "Cached", "Similar" and pagination-style links.
            if (/^(cached|similar|more results|next|previous|images|maps|news|videos)$/i.test(title)) return;
            addOrganic($, organic, a as Element, title, base, adUrls);
        });
    }

    const organicResults = [...organic.values()].map((r, i) => ({ position: i + 1, ...r }));

    const peopleAlsoAsk: { question: string }[] = [];
    const seenQ = new Set<string>();
    $('.related-question-pair, [jsname="yEVEwb"], [data-q]').each((_, el) => {
        const q = clean($(el).attr('data-q') ?? $(el).find('[role="button"] span, .CSkcDe').first().text() ?? '');
        if (q && q.endsWith('?') && !seenQ.has(q)) {
            seenQ.add(q);
            peopleAlsoAsk.push({ question: q });
        }
    });

    const relatedQueries: { title: string; url: string }[] = [];
    const seenRel = new Set<string>();
    const currentQuery = clean(new URL(base).searchParams.get('q') ?? '').toLowerCase();
    $('#botstuff a[href^="/search"], #bres a[href^="/search"], a.ngTNl, a.k8XOCe, .s75CSd a, a[href^="/search?"][data-ved], #main a[href^="/search?q="]').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        // Skip vertical tabs (images, news…), pagination and tool links.
        if (!/[?&]q=/.test(href) || /[?&](start|tbm|udm|tbs|uule)=/.test(href)) return;
        const title = clean($(a).text());
        if (!title || title.length > 120 || seenRel.has(title) || title.toLowerCase() === currentQuery) return;
        if (/^(all|todo|images|imágenes|news|noticias|videos|vídeos|maps|mapas|shopping|books|more|más|tools|herramientas|next|siguiente)\b/i.test(title)) return;
        seenRel.add(title);
        relatedQueries.push({ title, url: new URL(href, base).href });
    });

    const statsText = clean($('#result-stats').text());
    const total = statsText.match(/([\d.,\s]+)\s*(results|resultados|Ergebnisse|résultats)/i)?.[1];

    const hasNextPage = $('#pnnext, a[aria-label="Next page"], a[aria-label="Página siguiente"], footer a[href*="start="], a[href*="&start="]').length > 0;

    return {
        organicResults,
        paidResults,
        peopleAlsoAsk,
        relatedQueries,
        resultsTotal: total ? Number(total.replace(/[^\d]/g, '')) || undefined : undefined,
        hasNextPage,
    };
}

function addOrganic($: CheerioAPI, out: Map<string, Omit<OrganicResult, 'position'>>, a: Element, title: string, base: string, adUrls: Set<string>, forcedUrl?: string) {
    // `data-url` (confirmed real 30 oct 2026, Local Pack results) is the plain,
    // already-decoded destination Google ships alongside the opaque
    // `/goto?url=<encoded blob>` href -- prefer it outright when present; it's
    // never wrong and needs no unwrapping. Classic results (still /url?q=, or
    // no wrapper at all) fall back to unwrapGoogleHref() as before.
    // `forcedUrl` (31 oct 2026, Strategy 1c): el link de Maps ya resuelto,
    // para cards del Local Pack sin sitio web -- se usa tal cual, sin pasar
    // por la lógica de arriba (que en ese caso miraría el anchor de
    // "Directions", no el de la card real).
    const dataUrl = $(a).attr('data-url');
    const url = forcedUrl ?? (dataUrl && /^https?:\/\//i.test(dataUrl) ? dataUrl : undefined) ?? unwrapGoogleHref($(a).attr('href'), base);
    if (!url || !title || out.has(url) || adUrls.has(url)) return;
    const container = $(a).closest(CONTAINER_SELECTORS);
    const scope = container.length ? container : $(a).parent().parent();

    let description: string | undefined;
    for (const sel of SNIPPET_SELECTORS) {
        const t = clean(scope.find(sel).first().text());
        if (t && t !== title) {
            description = t;
            break;
        }
    }
    if (!description) {
        // Fallback: container text minus the title and the URL breadcrumb.
        const t = clean(scope.text()).replace(title, '').trim();
        if (t.length > 30) description = t.slice(0, 400);
    }
    let date: string | undefined;
    const dm = description?.match(DATE_RE);
    if (description && dm) {
        date = dm[1];
        description = description.slice(dm[0].length);
    }
    const displayedUrl = clean(scope.find('cite').first().text()) || undefined;

    // Local Pack rating -- e.g. aria-label="Rated 5.0 out of 5, 61 user
    // reviews" (an accessibility attribute, not a class name -- survives
    // redesigns better than most of this file's other selectors).
    let rating: number | undefined;
    let reviewsCount: number | undefined;
    const ratingLabel = scope.find('[aria-label*="Rated" i], [aria-label*="Calificado" i]').first().attr('aria-label');
    const ratingMatch = ratingLabel?.match(/([\d.,]+)\s*(?:out of|de)\s*5,?\s*([\d.,]+)?/i);
    if (ratingMatch) {
        rating = Number(ratingMatch[1].replace(',', '.')) || undefined;
        if (ratingMatch[2]) reviewsCount = Number(ratingMatch[2].replace(/[.,]/g, '')) || undefined;
    }

    const siteLinks: { title: string; url: string }[] = [];
    scope.find('table a, .HiHjCd a, .usJj9c a').each((_, sl) => {
        const slUrl = unwrapGoogleHref($(sl).attr('href'), base);
        const slTitle = clean($(sl).text());
        if (slUrl && slTitle && slUrl !== url) siteLinks.push({ title: slTitle, url: slUrl });
    });

    out.set(url, {
        title,
        url,
        displayedUrl,
        description,
        date,
        ...(rating !== undefined ? { rating } : {}),
        ...(reviewsCount !== undefined ? { reviewsCount } : {}),
        ...(siteLinks.length ? { siteLinks } : {}),
    });
}

function parseAds($: CheerioAPI, base: string): PaidResult[] {
    const ads: PaidResult[] = [];
    $('#tads [data-text-ad], #tads .uEierd, #bottomads [data-text-ad], #tvcap [data-text-ad]').each((_, el) => {
        const $el = $(el);
        const a = $el.find('a[data-rw], a[data-pcu], a:has([role="heading"]), a').first();
        const url = unwrapGoogleHref(a.attr('data-pcu')?.split(',')[0] ?? a.attr('href'), base) ?? a.attr('href');
        const title = clean($el.find('[role="heading"], h3').first().text());
        if (!url || !title) return;
        ads.push({
            adPosition: ads.length + 1,
            title,
            url,
            displayedUrl: clean($el.find('.x2VHCd, .Zu0yb, cite').first().text()) || undefined,
            description: clean($el.find('.MUxGbd, .yDYNvb, .Va3FIb').first().text()) || undefined,
        });
    });
    return ads;
}
