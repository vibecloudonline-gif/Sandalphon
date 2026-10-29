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

/**
 * 29 oct 2026: cascada de 2 proveedores de proxy residencial. Confirmado con
 * evidencia real (job de prueba contra `POST /google`) que el único proveedor
 * configurado hasta hoy (Webshare, vía `PROXY_URLS`) está devolviendo
 * `net::ERR_PROXY_CONNECTION_FAILED` en el 100% de los intentos -- no es un
 * bloqueo de Google, es que el proxy mismo no conecta (probable: las
 * credenciales se rotaron por haber quedado expuestas en un chat, sin
 * actualizar la variable en Render).
 *
 * En vez de una lista plana (que Crawlee rota parejo entre todas las URLs,
 * sin preferir ninguna), se usa `tieredProxyUrls` -- feature nativa de
 * Crawlee (ProxyConfiguration) pensada exactamente para esto: el tier 0 se
 * prueba primero en cada sesión nueva, y Crawlee escala solo al tier 1
 * cuando el tier 0 viene fallando (y puede volver a bajar si el tier 0
 * se recupera) -- no hace falta llevar la cuenta de fallos a mano.
 *
 * `PROXY_URLS` (tier 0, el proveedor más barato/preferido) se mantiene
 * retrocompatible -- mismo nombre de variable que ya se usaba. `PROXY_URLS_TIER2`
 * es el proveedor de respaldo nuevo. Si solo hay tier 0, se arma la lista
 * plana de siempre (comportamiento idéntico al de antes). Sin ninguna de las
 * dos, sin proxy (igual que hoy).
 */
export async function makeProxy(input: Input): Promise<ProxyConfiguration | undefined> {
    const p = input.proxyConfiguration;
    if (p?.useApifyProxy) {
        // Only available on the Apify platform (or with APIFY_TOKEN); loaded lazily so Render doesn't need it.
        const { Actor } = await import('apify');
        return (await Actor.createProxyConfiguration({ groups: p.apifyProxyGroups, countryCode: p.apifyProxyCountry })) ?? undefined;
    }

    const splitUrls = (raw: string | undefined): string[] => raw?.split(/[\s,]+/).filter(Boolean) ?? [];
    const tier1 = p?.proxyUrls?.length ? p.proxyUrls : splitUrls(process.env.PROXY_URLS);
    const tier2 = splitUrls(process.env.PROXY_URLS_TIER2);

    if (!tier1.length && !tier2.length) return undefined;
    if (tier1.length && tier2.length) return new ProxyConfiguration({ tieredProxyUrls: [tier1, tier2] });
    return new ProxyConfiguration({ proxyUrls: tier1.length ? tier1 : tier2 });
}

/** Headless Chromium flags that keep memory down on small containers (Render, Docker). */
export const CHROMIUM_ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'];

export type Emit<T> = (record: T) => void | Promise<void>;

export interface FailedRequest {
    url: string;
    error: string;
    renderedWith: 'http' | 'browser';
}
