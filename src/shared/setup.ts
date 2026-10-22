import { randomUUID } from 'node:crypto';
import { Configuration, ProxyConfiguration, RequestQueue } from 'crawlee';
import type { Input } from '../input.js';

/**
 * Every job gets in-memory storage and its own queues, so several jobs can run in the same
 * process (the Render web service) without sharing or purging each other's state.
 */
export function jobConfig(): Configuration {
    return new Configuration({ persistStorage: false, purgeOnStart: false });
}

export async function openQueue(config: Configuration, label: string): Promise<RequestQueue> {
    return RequestQueue.open(`${label}-${randomUUID()}`, { config });
}

export async function makeProxy(input: Input): Promise<ProxyConfiguration | undefined> {
    const p = input.proxyConfiguration;
    if (p?.useApifyProxy) {
        // Only available on the Apify platform (or with APIFY_TOKEN); loaded lazily so Render doesn't need it.
        const { Actor } = await import('apify');
        return (await Actor.createProxyConfiguration({ groups: p.apifyProxyGroups, countryCode: p.apifyProxyCountry })) ?? undefined;
    }
    const envUrls = process.env.PROXY_URLS?.split(/[\s,]+/).filter(Boolean) ?? [];
    const urls = p?.proxyUrls?.length ? p.proxyUrls : envUrls;
    return urls.length ? new ProxyConfiguration({ proxyUrls: urls }) : undefined;
}

/** Headless Chromium flags that keep memory down on small containers (Render, Docker). */
export const CHROMIUM_ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'];

export type Emit<T> = (record: T) => void | Promise<void>;

export interface FailedRequest {
    url: string;
    error: string;
    renderedWith: 'http' | 'browser';
}
