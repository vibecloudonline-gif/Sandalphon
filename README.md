# Ultimate Scraper — Google SERP + Web + Instagram + IA

Scraper de **resultados de Google**, **crawler web universal** y **análisis de competencia en Instagram**,
con una **IA que entiende el encargo del cliente**: planea qué scrapear y responde a su objetivo.
Combina las mejores ideas de los proyectos open source líderes. Corre como **API REST en Render** (o cualquier host Docker), como
**Actor de Apify** o desde la **línea de comandos**.

## Qué tomamos de cada proyecto

| Idea | Origen | Dónde está |
|---|---|---|
| Colas, reintentos, sesiones, rotación de proxies y huellas de navegador | [Crawlee](https://github.com/apify/crawlee) / [Apify Web Scraper](https://github.com/apify/actor-scraper) | toda la base |
| Cascada de motores: HTTP barato primero, Chromium solo cuando hace falta | [Firecrawl](https://github.com/mendableai/firecrawl) | `src/web/crawler.ts`, `src/google/crawler.ts` |
| Detección anti-bot por niveles (Cloudflare, Akamai, DataDome, PerimeterX, Imperva…) | [crawl4ai](https://github.com/unclecode/crawl4ai) | `src/shared/antibot.ts` |
| Markdown limpio solo con el contenido principal (sin menús, banners, cookies) | crawl4ai / Firecrawl | `src/web/extract.ts` |
| **Selectores adaptativos**: si la web cambia su HTML, el campo se reubica por similitud | [Scrapling](https://github.com/D4Vinci/Scrapling) | `src/shared/adaptive.ts` |
| Google sin JavaScript (UA de navegador de texto + cookies de consentimiento) | [googlesearch](https://github.com/Nv7-GitHub/googlesearch), [Search-Engines-Scraper](https://github.com/tasos-py/Search-Engines-Scraper) | `src/google/crawler.ts` |
| Google con navegador: varios juegos de selectores, consentimiento y detección de CAPTCHA | [mcp_web_search](https://github.com/giveen/mcp_web_search) | `src/google/parse.ts` |
| Formato de salida compatible con el Google Search Scraper oficial de Apify | Apify Store | `SerpRecord` |
| Extracción de contactos (emails, teléfonos, redes) para leads | Actors de leads de Apify | `extractContacts` |
| Instagram sin login: `web_profile_info` con la app-id pública de la web | Actors "No Login" de Apify, [Instaloader](https://github.com/instaloader/instaloader) | `src/instagram/crawler.ts` |
| Paginación anónima por GraphQL `doc_id` con el CSRF de la portada | Instaloader | `graphqlPage()` |
| Respaldo con navegador que lee el GraphQL que carga la propia página (sin `doc_id` fijo) | [instagram-graphql-scraper](https://github.com/FaustRen/instagram-graphql-scraper) | `src/instagram/crawler.ts` |
| Descubrir perfiles del nicho con Google `site:instagram.com` | (propio, reutiliza el scraper de Google) | `discoverQuery` |

## API (Render)

Todas las rutas salvo `/health` requieren `x-api-key: <API_KEY>` o `Authorization: Bearer <API_KEY>`.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Estado del servicio |
| `POST` | `/google` | Busca en Google. Espera el resultado (hasta `SYNC_TIMEOUT_SECS`) salvo `"async": true` |
| `POST` | `/scrape` | Extrae 1–100 URLs concretas, sin seguir enlaces. Síncrono salvo `"async": true` |
| `POST` | `/crawl` | Rastrea un sitio siguiendo enlaces. Siempre asíncrono → devuelve un `id` |
| `POST` | `/instagram` | Analiza perfiles públicos de Instagram (y/o los descubre). Síncrono salvo `"async": true` |
| `POST` | `/ask` | **IA**: `{ "brief": "…" }` → planea el scraping, lo ejecuta y responde. Siempre asíncrono |
| `GET` | `/jobs/:id` | Estado y estadísticas del trabajo |
| `GET` | `/jobs/:id/results?format=json\|ndjson\|csv&offset=0&limit=1000` | Resultados |
| `DELETE` | `/jobs/:id` | Cancela un trabajo |

Cualquier petición acepta `"webhookUrl": "https://..."`: se llama con un `POST` al terminar (útil con n8n, Make o Zapier).
Cualquier petición acepta también `"brief": "…"`: al terminar, la IA escribe en `insights` (Markdown) la respuesta a ese encargo.

### Ejemplos

```bash
API=https://ultimate-scraper.onrender.com
KEY=tu-api-key

# Google: 2 páginas, España, en español
curl -X POST $API/google -H "x-api-key: $KEY" -d '{
  "queries": ["mejores cafeterías madrid", "web scraping python"],
  "maxPagesPerQuery": 2, "countryCode": "es", "languageCode": "es", "googleDomain": "google.es"
}'

# Extraer campos concretos de páginas de producto
curl -X POST $API/scrape -H "x-api-key: $KEY" -d '{
  "urls": ["https://tienda.com/p/1", "https://tienda.com/p/2"],
  "fields": { "precio": ".price", "imagen": { "selector": "img.main", "attr": "src" }, "tallas": { "selector": ".size", "all": true } }
}'

# Rastrear un sitio entero buscando contactos
curl -X POST $API/crawl -H "x-api-key: $KEY" -d '{
  "startUrls": ["https://empresa.com"], "maxPages": 200, "maxDepth": 3,
  "useSitemaps": true, "extractContacts": true, "saveMarkdown": false
}'
# → { "id": "…", "status": "queued" }
curl $API/jobs/<id> -H "x-api-key: $KEY"
curl "$API/jobs/<id>/results?format=csv" -H "x-api-key: $KEY" > contactos.csv
```

```bash
# IA: el cliente escribe lo que quiere, la IA decide qué scrapear y responde
curl -X POST $API/ask -H "x-api-key: $KEY" -d '{
  "brief": "Tengo una pastelería vegana en CDMX. ¿Qué contenido les funciona a mis competidores en Instagram y qué debería publicar yo?"
}'
# → { "id": "…" }. Al terminar, GET /jobs/<id> trae "plan" (lo que decidió la IA) e "insights" (la respuesta).

# Instagram: competidores concretos + descubrir más del nicho
curl -X POST $API/instagram -H "x-api-key: $KEY" -d '{
  "usernames": ["competidor1", "@competidor2", "https://www.instagram.com/competidor3/"],
  "discoverQuery": "pastelería vegana cdmx", "discoverMaxProfiles": 10,
  "maxPostsPerProfile": 36, "daysBack": 90, "timeZone": "America/Mexico_City",
  "brief": "¿Qué formatos y horarios funcionan mejor en mi nicho?", "async": true
}'
curl "$API/jobs/<id>/results?format=csv&view=profiles" -H "x-api-key: $KEY" > competidores.csv
curl "$API/jobs/<id>/results?format=csv" -H "x-api-key: $KEY" > posts.csv
```

### Parámetros principales

**Google:** `queries` (texto o URL completa de Google), `maxPagesPerQuery` (10 resultados por página),
`countryCode` (`gl`), `languageCode` (`hl`), `googleDomain`, `renderingMode`, `saveHtml`.

Salida por página: `searchQuery`, `organicResults[]` (`position`, `title`, `url`, `displayedUrl`,
`description`, `date`, `siteLinks`), `paidResults[]`, `peopleAlsoAsk[]`, `relatedQueries[]`,
`resultsTotal`, `hasNextPage`, `renderedWith`.

**Web:** `startUrls`, `maxPages`, `maxDepth`, `sameDomain`, `includeGlobs`, `excludeGlobs`,
`useSitemaps`, `respectRobotsTxt` (activado por defecto), `renderingMode` (`auto` | `http` | `browser`),
`waitForSelector`, `infiniteScroll`, `fields`, `adaptiveSelectors`, `removeSelectors`,
`saveMarkdown`, `saveHtml`, `saveLinks`, `extractContacts`.

Salida por página: `url`, `statusCode`, `renderedWith`, `metadata` (title, description, canonical,
Open Graph, Twitter…), `headings`, `jsonLd`, `fields`, `relocatedFields`, `markdown`, `links`, `contacts`.

**Instagram:** `usernames` (handles o URLs), `discoverQuery`, `discoverMaxProfiles`, `maxPostsPerProfile`,
`daysBack`, `timeZone` (para mejores días/horas), `includePosts`, `renderingMode`.

Salida: un registro `type: "profile"` por perfil (`profile`, `posts[]`, `analysis` con engagement rate,
posts por semana, mezcla de formatos con su rendimiento, mejores días y horas, hashtags, duración de
captions, % de colaboraciones y top posts) y al final un `type: "nicheReport"` con el ranking del nicho,
benchmarks (medianas), formatos que mejor funcionan **normalizados por seguidores**, mejores días/horas,
hashtags compartidos entre competidores y los 10 mejores posts del nicho.

**Comunes:** `maxConcurrency`, `maxRequestRetries`, `requestTimeoutSecs`,
`proxyConfiguration: { "proxyUrls": ["http://user:pass@host:port"] }`.

## Desplegar en Render

1. Sube este proyecto a un repositorio de GitHub.
2. En Render: **New → Blueprint** → elige el repo. Render lee `render.yaml` y crea el servicio Docker.
3. Copia el `API_KEY` generado (Environment) y, si vas a usar Google, añade `PROXY_URLS`.
4. Health check: `GET /health`.

**Plan:** Chromium necesita ~1 GB. El plan *Standard* (2 GB) es el mínimo cómodo; en *Starter*
(512 MB) usa `renderingMode: "http"` y `MAX_BROWSER_CONCURRENCY=1`.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `API_KEY` | — | Clave de la API (sin ella la API queda abierta) |
| `PROXY_URLS` | — | Proxies separados por coma; se rotan por sesión |
| `MAX_CONCURRENT_JOBS` | 2 | Trabajos simultáneos; el resto espera en cola |
| `MAX_BROWSER_CONCURRENCY` | 4 (web) / 2 (Google) | Pestañas de Chromium simultáneas |
| `SYNC_TIMEOUT_SECS` | 120 | Tras este tiempo, `/google` y `/scrape` devuelven 202 + `id` |
| `JOB_TTL_MINUTES` | 60 | Tiempo que se guardan los resultados en memoria |
| `MAX_RESULTS_PER_JOB` | 10000 | Límite de registros en memoria por trabajo |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | — | Proveedor de IA (ver tabla de arriba) |
| `LLM_TIMEOUT_SECS` | 120 | Tiempo máximo por llamada a la IA |
| `IG_POSTS_DOC_ID` | 7950326061742207 | `doc_id` de GraphQL para paginar posts; Instagram lo rota. Si falla, el scraper usa el navegador |
| `ADAPTIVE_STORE_PATH` | — | Archivo JSON para guardar las huellas de los selectores adaptativos (usa un Render Disk) |

### IA (cualquier proveedor compatible con OpenAI)

Configura 3 variables en Render y listo; cambiar de proveedor no requiere tocar código.
Los nombres de modelo cambian seguido: confirma el actual en la web de cada proveedor.

| Proveedor | `LLM_BASE_URL` | `LLM_MODEL` (ejemplo) | Notas |
|---|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | Plan gratuito; en el gratuito Google puede usar los datos para mejorar sus modelos |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Plan gratuito con límites por minuto |
| OpenRouter | `https://openrouter.ai/api/v1` | un modelo con sufijo `:free` | Muchos modelos gratuitos y de pago |
| DeepSeek (China) | `https://api.deepseek.com` | `deepseek-chat` | Muy barato; datos procesados en China |
| Qwen / Alibaba (China) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | Barato; región internacional |
| Ollama (tu servidor) | `http://<host>:11434/v1` | `qwen2.5:14b` | Gratis y privado, pero necesitas una máquina con GPU |

A la IA solo se le envía un **resumen** de los resultados (métricas, hashtags y fragmentos de los
mejores posts, máx. `LLM_MAX_INPUT_CHARS`), nunca el dataset completo. El plan que propone la IA pasa
por una lista blanca de campos y límites duros (p. ej. máx. 25 perfiles descubiertos, 60 posts por perfil).

Los trabajos se guardan **en memoria**: un reinicio o un nuevo deploy los borra. Descarga los
resultados (o usa `webhookUrl`) antes de que caduquen.

## Apify y línea de comandos

```bash
npm install
npm start -- input.json --out resultados.ndjson   # CLI
npm run serve                                     # API local en :10000
npm test                                          # 24 pruebas (servidores locales + Chromium)
```

En Apify: `apify push` (usa `.actor/`). Los registros van al dataset, la respuesta de la IA a la clave
`INSIGHTS` y las estadísticas a `STATS`. En la CLI, la respuesta de la IA se guarda en `*.insights.md`.

## Límites y avisos legales

- **Google** prohíbe las consultas automatizadas en sus términos y bloquea rápido las IPs de centros de
  datos (Render incluido). Sin **proxies residenciales** verás CAPTCHAs (`/sorry`) en pocas consultas.
  El scraper los detecta, cambia de sesión/IP y reintenta, pero no resuelve CAPTCHAs. Sin proxies, limita
  Google a 2 peticiones en paralelo y 20 por minuto.
- El HTML de Google cambia a menudo. El parser prueba varios juegos de selectores y alternativas
  estructurales, pero las pruebas usan páginas de ejemplo locales, **no Google real**: valida con tus
  propias búsquedas tras desplegar.
- **Instagram:** solo perfiles **públicos** y lo que Instagram muestra a un visitante **sin cuenta**
  (como los Actors "No Login" de Apify). No inicia sesión, no usa cuentas, no resuelve CAPTCHAs ni
  accede a perfiles privados. Sus términos prohíben el scraping automatizado: úsalo para análisis de
  mercado agregado y bajo tu responsabilidad. Instagram bloquea IPs de centros de datos casi de
  inmediato: **necesitas proxies residenciales**. Sin proxies el scraper va a 1 perfil a la vez y
  6 peticiones/minuto. Los endpoints internos cambian sin aviso; las pruebas usan respuestas de ejemplo
  locales con la forma que documenta Instaloader, **no Instagram real**.
- Facebook y LinkedIn no están incluidos.
- Respeta `robots.txt` por defecto. Si guardas datos personales (emails, teléfonos), aplica la ley de
  protección de datos de tu país (GDPR, LFPDPPP, etc.).

## Licencia

MIT. Ideas inspiradas en los proyectos citados arriba. Ningún código fue copiado: se reimplementó en
TypeScript (Scrapling: BSD-3; crawl4ai: Apache-2.0; Crawlee: Apache-2.0).
