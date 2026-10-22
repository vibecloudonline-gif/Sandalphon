/**
 * Batch entry point: runs one job and exits.
 *   - On Apify: reads the Actor input, pushes records to the default dataset, AI insights to the
 *               INSIGHTS key (Markdown) and stats to STATS.
 *   - Locally:  `npm start -- input.json [--out results.ndjson]` (or INPUT_JSON env).
 * Input may include "brief" (AI insights); a brief alone lets the AI plan the scrape.
 */
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { log } from 'crawlee';
import { createJob, fingerprints, publicJob } from './jobs.js';

const onApify = Boolean(process.env.APIFY_IS_AT_HOME);

async function run(raw: Record<string, unknown>) {
    const brief = typeof raw.brief === 'string' && raw.brief.trim() ? raw.brief.trim() : undefined;
    const { brief: _b, ...rest } = raw;
    // Only a brief (plus maybe defaults from the Apify console) → let the AI plan.
    const hasScrapeInput = ['startUrls', 'queries', 'usernames', 'discoverQuery'].some((k) => {
        const v = rest[k];
        return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';
    });
    const job = createJob(brief && !hasScrapeInput ? null : rest, { brief });
    await job.done;
    fingerprints.flush();
    return job;
}

if (onApify) {
    const { Actor } = await import('apify');
    await Actor.init();
    const job = await run(((await Actor.getInput()) ?? {}) as Record<string, unknown>);
    for (let i = 0; i < job.results.length; i += 500) await Actor.pushData(job.results.slice(i, i + 500) as Record<string, unknown>[]);
    if (job.insights) await Actor.setValue('INSIGHTS', job.insights, { contentType: 'text/markdown' });
    await Actor.setValue('STATS', publicJob(job));
    if (job.status === 'failed') await Actor.fail(job.error);
    else await Actor.exit();
} else {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? args.splice(outIdx, 2)[1] : undefined;
    const raw = args[0] ? readFileSync(args[0], 'utf8') : process.env.INPUT_JSON;
    if (!raw) {
        console.error('Usage: npm start -- input.json [--out results.ndjson]   (or set INPUT_JSON)');
        process.exit(1);
    }
    const job = await run(JSON.parse(raw));
    const out = outPath ? createWriteStream(outPath) : process.stdout;
    for (const r of job.results) out.write(`${JSON.stringify(r)}\n`);
    if (outPath) (out as ReturnType<typeof createWriteStream>).end();
    if (job.insights) {
        const mdPath = outPath ? outPath.replace(/(\.\w+)?$/, '.insights.md') : 'insights.md';
        writeFileSync(mdPath, job.insights);
        log.info(`AI insights written to ${mdPath}`);
    }
    log.info(`Job ${job.status}`, publicJob(job) as unknown as Record<string, unknown>);
    if (job.status === 'failed') process.exit(1);
}
