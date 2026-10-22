/**
 * Adaptive selectors, after Scrapling's `auto_save` / `relocate`:
 * when a selector matches, we store a fingerprint of the element (tag, text, attributes,
 * DOM path, parent, siblings). When the selector later stops matching because the site
 * changed its markup, we score every element on the page against that fingerprint and
 * return the best candidate above a threshold.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { dictRatio, ratio } from './similarity.js';

export interface Fingerprint {
    tag: string;
    text: string;
    attributes: Record<string, string>;
    path: string[];
    parentTag?: string;
    parentAttributes?: Record<string, string>;
    parentText?: string;
    siblings?: string[];
}

const isElement = (n: AnyNode | null | undefined): n is Element => !!n && (n as Element).type === 'tag';

const ownText = (el: Element): string =>
    el.children
        .filter((c) => c.type === 'text')
        .map((c) => (c as unknown as { data: string }).data)
        .join('')
        .trim();

function pathOf(el: Element): string[] {
    const path: string[] = [];
    let cur: AnyNode | null = el;
    while (isElement(cur)) {
        path.unshift(cur.name);
        cur = cur.parent;
    }
    return path;
}

export function fingerprint(el: Element): Fingerprint {
    const fp: Fingerprint = { tag: el.name, text: ownText(el), attributes: { ...el.attribs }, path: pathOf(el) };
    if (isElement(el.parent)) {
        fp.parentTag = el.parent.name;
        fp.parentAttributes = { ...el.parent.attribs };
        fp.parentText = ownText(el.parent);
        const siblings = el.parent.children.filter((c): c is Element => isElement(c) && c !== el).map((c) => c.name);
        if (siblings.length) fp.siblings = siblings;
    }
    return fp;
}

/** 0..100 similarity between a stored fingerprint and a candidate element. */
export function score(original: Fingerprint, candidate: Element): number {
    const data = fingerprint(candidate);
    let total = original.tag === data.tag ? 1 : 0;
    let checks = 1;
    if (original.text) {
        total += ratio(original.text, data.text);
        checks++;
    }
    total += dictRatio(original.attributes, data.attributes);
    checks++;
    for (const attr of ['class', 'id', 'href', 'src', 'itemprop', 'data-testid']) {
        if (original.attributes[attr]) {
            total += ratio(original.attributes[attr], data.attributes[attr] ?? '');
            checks++;
        }
    }
    total += ratio(original.path, data.path);
    checks++;
    if (original.parentTag && data.parentTag) {
        total += ratio(original.parentTag, data.parentTag);
        total += dictRatio(original.parentAttributes ?? {}, data.parentAttributes ?? {});
        checks += 2;
        if (original.parentText) {
            total += ratio(original.parentText, data.parentText ?? '');
            checks++;
        }
    }
    if (original.siblings) {
        total += ratio(original.siblings, data.siblings ?? []);
        checks++;
    }
    return Math.round((total / checks) * 10_000) / 100;
}

/** Best-scoring elements for a fingerprint, or [] when nothing reaches `threshold` (0..100). */
export function relocate($: CheerioAPI, original: Fingerprint, threshold = 40): Element[] {
    let best = -1;
    let winners: Element[] = [];
    // Only compare elements with the same tag first: cheap and right almost always.
    const pool = $(original.tag).toArray().filter(isElement);
    const candidates = pool.length ? pool : $('body *').toArray().filter(isElement);
    for (const el of candidates) {
        const s = score(original, el);
        if (s > best) {
            best = s;
            winners = [el];
        } else if (s === best) {
            winners.push(el);
        }
    }
    return best >= threshold ? winners : [];
}

/** Fingerprints keyed by `host::field`. Kept in memory and, optionally, mirrored to a JSON file. */
export class FingerprintStore {
    private data = new Map<string, Fingerprint>();
    private dirty = false;

    constructor(private readonly filePath?: string) {
        if (filePath && existsSync(filePath)) {
            try {
                const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Fingerprint>;
                for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
            } catch {
                // A corrupt store only costs us the relocation history.
            }
        }
    }

    get(key: string): Fingerprint | undefined {
        return this.data.get(key);
    }

    set(key: string, fp: Fingerprint): void {
        this.data.set(key, fp);
        this.dirty = true;
    }

    flush(): void {
        if (!this.filePath || !this.dirty) return;
        mkdirSync(dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.data)));
        this.dirty = false;
    }
}
