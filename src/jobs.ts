import { randomUUID } from 'node:crypto';
import { log } from 'crawlee';
import { normalizeInput, type Input } from './input.js';
import { FingerprintStore } from './shared/adaptive.js';
import { runGoogle } from './google/crawler.js';
import { runWeb } from './web/crawler.js';
import { runInstagram } from './instagram/crawler.js';
import { planScrape, writeInsights } from './ai/brief.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';

export interface Job {
    id: string;
    mode: Input['mode'] | 'ask';
    /** The client's request in natural language (AI planning + insights). */
    brief?: string;
    plan?: { goal: string; reasoning?: string; input: Input };
    /** AI answer to the brief, in Markdown. */
    insights?: string;
    insightsError?: string;
    status: JobStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    stats?: Record<string, unknown>;
    results: unknown[];
    webhookUrl?: string;
    controller: AbortController;
    done: Promise<void>;
}

const MAX_RESULTS_IN_MEMORY = Number(process.env.MAX_RESULTS_PER_JOB ?? 10_000);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MINUTES ?? 60) * 60_000;
const MAX_RUNNING = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

/** Shared across jobs so adaptive selectors learn over time. Mirror to disk with ADAPTIVE_STORE_PATH. */
export const fingerprints = new FingerprintStore(process.env.ADAPTIVE_STORE_PATH);

const jobs = new Map<string, Job>();
const waiting: (() => void)[] = [];
let running = 0;

async function slot(): Promise<void> {
    if (running < MAX_RUNNING) {
        running++;
        return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
    const next = waiting.shift();
    if (next) next();
    else running--;
}

/** Runs a scrape directly (CLI / Apify), streaming each record to `emit`. */
export async function runInput(input: Input, emit: (r: unknown) => void | Promise<void>, signal?: AbortSignal) {
    if (input.mode === 'google') return runGoogle(input, emit, signal);
    if (input.mode === 'instagram') return runInstagram(input, emit, signal);
    return runWeb(input, emit, fingerprints, signal);
}

export interface JobOptions {
    webhookUrl?: string;
    /** With a brief and no input, the AI plans the scrape; with both, it only writes the insights. */
    brief?: string;
}

export function createJob(rawInput: unknown | null, { webhookUrl, brief }: JobOptions = {}): Job {
    // Validate eagerly so bad input is a 400, not a failed job.
    let input = rawInput === null ? undefined : normalizeInput(rawInput as Parameters<typeof normalizeInput>[0]);
    const controller = new AbortController();
    const job: Job = {
        id: randomUUID(),
        mode: input?.mode ?? 'ask',
        brief,
        status: 'queued',
        createdAt: new Date().toISOString(),
        results: [],
        webhookUrl,
        controller,
        done: Promise.resolve(),
    };
    job.done = (async () => {
        await slot();
        try {
            if (controller.signal.aborted) return;
            job.status = 'running';
            job.startedAt = new Date().toISOString();
            if (!input) {
                const plan = await planScrape(brief!);
                job.plan = plan;
                job.mode = plan.input.mode;
                input = plan.input;
                log.info(`Job ${job.id}: AI planned a ${input.mode} scrape: ${plan.goal}`);
            }
            const stats = await runInput(
                input,
                (r) => {
                    if (job.results.length < MAX_RESULTS_IN_MEMORY) job.results.push(r);
                },
                controller.signal,
            );
            job.stats = { ...stats, records: job.results.length };
            if (brief && job.results.length && !controller.signal.aborted) {
                // Insights are a bonus: a failing AI call must not throw away the scraped data.
                try {
                    job.insights = await writeInsights(brief, job.plan?.goal ?? brief, input.mode, job.results);
                } catch (e) {
                    job.insightsError = (e as Error).message;
                    log.warning(`Job ${job.id}: insights failed: ${job.insightsError}`);
                }
            }
            job.status = controller.signal.aborted ? 'aborted' : 'succeeded';
        } catch (e) {
            job.status = 'failed';
            job.error = (e as Error).message;
            log.exception(e as Error, `Job ${job.id} failed`);
        } finally {
            job.finishedAt = new Date().toISOString();
            release();
            await notify(job);
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
        }
    })();
    jobs.set(job.id, job);
    return job;
}

export const getJob = (id: string) => jobs.get(id);

export function abortJob(id: string): Job | undefined {
    const job = jobs.get(id);
    if (job && (job.status === 'queued' || job.status === 'running')) {
        job.controller.abort();
        if (job.status === 'queued') job.status = 'aborted';
    }
    return job;
}

export function publicJob(job: Job) {
    const { controller: _c, done: _d, results, webhookUrl: _w, ...rest } = job;
    return { ...rest, resultCount: results.length };
}

async function notify(job: Job): Promise<void> {
    if (!job.webhookUrl) return;
    try {
        await fetch(job.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: `job.${job.status}`, job: publicJob(job) }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch (e) {
        log.warning(`Webhook for job ${job.id} failed: ${(e as Error).message}`);
    }
}
