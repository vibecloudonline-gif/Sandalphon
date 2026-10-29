/**
 * 29 oct 2026: diagnóstico directo de los proxies configurados (PROXY_URLS /
 * PROXY_URLS_TIER2), sin correr un job de scraping completo. Nace del bug
 * real de hoy: un job de /google terminó "succeeded" con 0 resultados y el
 * error real (`net::ERR_PROXY_CONNECTION_FAILED`) solo apareció mirando el
 * detalle de `failed[]` -- nada en el panel avisa de esto de forma directa.
 *
 * Usa Playwright (ya es dependencia, no agrega ninguna nueva) para abrir el
 * proxy real y navegar a un servicio de verificación de IP -- el mismo
 * camino exacto que toma una scrape real escalada a browser, así que un
 * "ok" acá es una garantía real, no un chequeo distinto que podría decir
 * "todo bien" mientras los jobs reales siguen fallando.
 *
 * Límite honesto: esto confirma SI el proxy conecta y, si conecta, con qué
 * IP/país sale -- no puede distinguir con certeza "se quedó sin crédito" de
 * "credenciales mal" o "IP del servidor no está en la whitelist del
 * proveedor" (todos dan un error de conexión/auth parecido del lado del
 * cliente). El mensaje de error crudo (`net::ERR_...`) queda en la
 * respuesta para cruzarlo con el panel del proveedor de proxy.
 */
import { chromium } from 'playwright';
import { CHROMIUM_ARGS } from './setup.js';

export interface ProxyHealthResult {
    tier: number;
    /** host:puerto, sin credenciales. */
    proxyHost: string;
    sampledOf: number;
    ok: boolean;
    ip?: string;
    latencyMs: number;
    error?: string;
}

function redact(proxyUrl: string): string {
    try {
        const u = new URL(proxyUrl);
        return `${u.protocol}//${u.hostname}:${u.port || '(default)'}`;
    } catch {
        return '(URL de proxy inválida)';
    }
}

function parseProxy(proxyUrl: string): { server: string; username?: string; password?: string } {
    const u = new URL(proxyUrl);
    return {
        server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
    };
}

async function testOne(proxyUrl: string, tier: number, sampledOf: number, timeoutMs: number): Promise<ProxyHealthResult> {
    const proxyHost = redact(proxyUrl);
    const start = Date.now();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        const proxy = parseProxy(proxyUrl);
        browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS, proxy, timeout: timeoutMs });
        const page = await (await browser.newContext()).newPage();
        page.setDefaultNavigationTimeout(timeoutMs);
        const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: timeoutMs });
        const json = JSON.parse((await res?.text()) ?? '{}');
        return { tier, proxyHost, sampledOf, ok: true, ip: json.ip, latencyMs: Date.now() - start };
    } catch (e) {
        return { tier, proxyHost, sampledOf, ok: false, error: (e as Error).message.split('\n')[0].slice(0, 200), latencyMs: Date.now() - start };
    } finally {
        await browser?.close().catch(() => undefined);
    }
}

/**
 * Prueba UN proxy de cada tier configurado (el primero de la lista) -- no
 * todos, para no tardar/gastar de más: si un tier está mal configurado
 * (credenciales, host), es un problema del tier entero, no de una URL
 * puntual dentro de él.
 */
export async function checkProxyHealth(timeoutMs = 15_000): Promise<ProxyHealthResult[]> {
    const splitUrls = (raw: string | undefined) => raw?.split(/[\s,]+/).filter(Boolean) ?? [];
    const tiers = [splitUrls(process.env.PROXY_URLS), splitUrls(process.env.PROXY_URLS_TIER2)];
    const results: ProxyHealthResult[] = [];
    for (let tier = 0; tier < tiers.length; tier++) {
        const urls = tiers[tier];
        if (!urls.length) continue;
        results.push(await testOne(urls[0], tier, urls.length, timeoutMs));
    }
    return results;
}
