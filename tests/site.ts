/** Tiny local website used by the tests: static pages, a JS-only SPA, a block page and a redesign. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const layout = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="Description of ${title}"><meta property="og:title" content="${title} OG">${head}</head>
<body><header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<div class="cookie-banner">We use cookies. Accept?</div>
<main>${body}</main>
<footer>© Test Shop · <a href="mailto:hello@test-shop.dev">hello@test-shop.dev</a> · <a href="tel:+34 600 123 456">call</a>
<a href="https://www.instagram.com/testshop/">IG</a></footer></body></html>`;

const product = (v: 1 | 2) =>
    v === 1
        ? `<article class="product"><h1 class="product-title">Blue Mug</h1><div class="box"><span class="price" itemprop="price">12.50 €</span><span>in stock</span></div>
           <p>A very nice mug for coffee and tea, made of ceramic. ${'Lorem ipsum dolor sit amet. '.repeat(10)}</p></article>`
        : `<article class="product"><h1 class="product-title">Blue Mug</h1><div class="box"><span class="amount-now" itemprop="price">12.50 €</span><span>in stock</span></div>
           <p>A very nice mug for coffee and tea, made of ceramic. ${'Lorem ipsum dolor sit amet. '.repeat(10)}</p></article>`;

export const pages: Record<string, () => { status?: number; html: string }> = {
    '/': () => ({
        html: layout(
            'Home',
            `<h1>Welcome</h1><p>${'Static content that does not need JavaScript. '.repeat(10)}</p>
             <ul><li><a href="/products/mug">Mug</a></li><li><a href="/spa">SPA</a></li><li><a href="/blocked">Blocked</a></li>
             <li><a href="/deep/1">Deep</a></li><li><a href="https://external.example/">External</a></li></ul>`,
            `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Test Shop"}</script>`,
        ),
    }),
    '/about': () => ({ html: layout('About', `<h1>About us</h1><p>${'We sell mugs. '.repeat(30)}</p>`) }),
    '/products/mug': () => ({ html: layout('Blue Mug', product(1)) }),
    '/products/mug-v2': () => ({ html: layout('Blue Mug', product(2)) }),
    '/deep/1': () => ({ html: layout('Deep 1', `<p>${'Level one. '.repeat(30)}</p><a href="/deep/2">next</a>`) }),
    '/deep/2': () => ({ html: layout('Deep 2', `<p>${'Level two. '.repeat(30)}</p><a href="/deep/3">next</a>`) }),
    '/deep/3': () => ({ html: layout('Deep 3', `<p>${'Level three. '.repeat(30)}</p>`) }),
    // Empty shell: content only exists after JavaScript runs.
    '/spa': () => ({
        html: `<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div>
<script>window.__a=1</script><script>window.__b=2</script>
<script>document.getElementById('root').innerHTML='<main><h1>Rendered by JS</h1><p class="js-content">This text only exists after rendering. ${'More rendered text. '.repeat(15)}</p></main>';</script>
</body></html>`,
    }),
    // Cloudflare-style interstitial, served to everyone (HTTP and browser).
    '/blocked': () => ({
        status: 403,
        html: `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form"></div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`,
    }),
};

export async function startSite(): Promise<{ url: string; server: Server; hits: Map<string, number> }> {
    const hits = new Map<string, number>();
    const server = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        hits.set(path, (hits.get(path) ?? 0) + 1);
        const page = pages[path];
        if (!page) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            return res.end('not found');
        }
        const { status = 200, html } = page();
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}
