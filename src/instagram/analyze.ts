/**
 * Competitive analysis over scraped profiles: per-profile performance and a niche-wide report
 * (benchmarks, best formats, best posting times, shared hashtags, top posts).
 */
import type { IgPost, IgPostType, IgProfile } from './normalize.js';


export interface ProfileAnalysis {
    postsAnalyzed: number;
    periodDays: number;
    postsPerWeek: number;
    avgLikes: number | null;
    avgComments: number;
    avgViews: number | null;
    /** (likes + comments) / followers, averaged per post, in %. */
    engagementRate: number | null;
    formatMix: Partial<Record<IgPostType, { share: number; avgEngagement: number }>>;
    bestDays: { day: string; posts: number; avgEngagement: number }[];
    bestHours: { hour: number; posts: number; avgEngagement: number }[];
    topHashtags: { tag: string; uses: number }[];
    avgHashtagsPerPost: number;
    avgCaptionLength: number;
    collabShare: number;
    topPosts: { url: string; type: IgPostType; engagement: number; takenAt: string; caption: string }[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const engagementOf = (p: IgPost) => (p.likes ?? 0) + p.comments;

/** Local hour/day for the given IANA timezone. */
function localParts(iso: string, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(iso));
    return {
        day: parts.find((p) => p.type === 'weekday')!.value.toLowerCase(),
        hour: Number(parts.find((p) => p.type === 'hour')!.value),
    };
}

function grouped<K extends string | number>(posts: IgPost[], key: (p: IgPost) => K) {
    const m = new Map<K, number[]>();
    for (const p of posts) {
        const k = key(p);
        m.set(k, [...(m.get(k) ?? []), engagementOf(p)]);
    }
    return [...m.entries()].map(([k, es]) => ({ key: k, posts: es.length, avgEngagement: round(avg(es), 1) })).sort((a, b) => b.avgEngagement - a.avgEngagement);
}

function countTags(posts: IgPost[]) {
    const counts = new Map<string, number>();
    for (const p of posts) for (const t of p.hashtags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, uses]) => ({ tag, uses }));
}

export function analyzeProfile(profile: IgProfile, allPosts: IgPost[], timeZone = 'UTC'): ProfileAnalysis {
    // Pinned posts are old "greatest hits": they distort recency and frequency.
    const posts = allPosts.filter((p) => !p.isPinned);
    const times = posts.map((p) => Date.parse(p.takenAt)).sort((a, b) => a - b);
    const periodDays = times.length > 1 ? Math.max(1, (times[times.length - 1] - times[0]) / 86_400_000) : 0;
    const withLikes = posts.filter((p) => p.likes !== null);
    const withViews = posts.filter((p) => p.views !== null);
    const followers = profile.followers;

    const formatMix: ProfileAnalysis['formatMix'] = {};
    for (const g of grouped(posts, (p) => p.type)) {
        formatMix[g.key] = { share: round((g.posts / posts.length) * 100, 1), avgEngagement: g.avgEngagement };
    }

    return {
        postsAnalyzed: posts.length,
        periodDays: round(periodDays, 1),
        postsPerWeek: periodDays ? round((posts.length - 1) / (periodDays / 7), 2) : 0,
        avgLikes: withLikes.length ? round(avg(withLikes.map((p) => p.likes!)), 1) : null,
        avgComments: round(avg(posts.map((p) => p.comments)), 1),
        avgViews: withViews.length ? round(avg(withViews.map((p) => p.views!)), 0) : null,
        engagementRate: followers && withLikes.length ? round((avg(withLikes.map(engagementOf)) / followers) * 100, 3) : null,
        formatMix,
        bestDays: grouped(posts, (p) => localParts(p.takenAt, timeZone).day).map((g) => ({ day: g.key, posts: g.posts, avgEngagement: g.avgEngagement })),
        bestHours: grouped(posts, (p) => localParts(p.takenAt, timeZone).hour).slice(0, 6).map((g) => ({ hour: g.key, posts: g.posts, avgEngagement: g.avgEngagement })),
        topHashtags: countTags(posts).slice(0, 20),
        avgHashtagsPerPost: round(avg(posts.map((p) => p.hashtags.length)), 1),
        avgCaptionLength: Math.round(avg(posts.map((p) => p.caption.length))),
        collabShare: posts.length ? round((posts.filter((p) => p.isCollab).length / posts.length) * 100, 1) : 0,
        topPosts: [...posts]
            .sort((a, b) => engagementOf(b) - engagementOf(a))
            .slice(0, 5)
            .map((p) => ({ url: p.url, type: p.type, engagement: engagementOf(p), takenAt: p.takenAt, caption: p.caption.slice(0, 200) })),
    };
}

export interface NicheReport {
    type: 'nicheReport';
    profilesAnalyzed: number;
    timeZone: string;
    ranking: { username: string; followers?: number; engagementRate: number | null; postsPerWeek: number; avgViews: number | null; mainFormat?: string }[];
    benchmarks: { medianEngagementRate: number | null; medianPostsPerWeek: number; medianFollowers: number | null };
    /** Format performance normalized by each profile's followers, so big accounts don't dominate. */
    formats: { type: IgPostType; share: number; avgEngagementRate: number | null }[];
    bestDays: { day: string; avgEngagementRate: number }[];
    bestHours: { hour: number; avgEngagementRate: number }[];
    sharedHashtags: { tag: string; profiles: number; uses: number }[];
    topPosts: { username: string; url: string; type: IgPostType; engagement: number; engagementRate: number | null; takenAt: string; caption: string }[];
}

export function nicheReport(items: { profile: IgProfile; posts: IgPost[]; analysis: ProfileAnalysis }[], timeZone = 'UTC'): NicheReport {
    const rel = (p: IgPost, f?: number) => (f ? (engagementOf(p) / f) * 100 : null);
    const all = items.flatMap(({ profile, posts }) => posts.filter((p) => !p.isPinned).map((p) => ({ p, username: profile.username, er: rel(p, profile.followers) })));
    const ers = items.map((i) => i.analysis.engagementRate).filter((x): x is number => x !== null);
    const followers = items.map((i) => i.profile.followers).filter((x): x is number => x !== undefined);

    const byKey = <K extends string | number>(key: (p: IgPost) => K) => {
        const m = new Map<K, number[]>();
        for (const { p, er } of all) if (er !== null) m.set(key(p), [...(m.get(key(p)) ?? []), er]);
        return [...m.entries()].map(([k, v]) => ({ k, v: round(avg(v), 3), n: v.length })).sort((a, b) => b.v - a.v);
    };

    const tagProfiles = new Map<string, { profiles: Set<string>; uses: number }>();
    for (const { p, username } of all) {
        for (const t of p.hashtags) {
            const e = tagProfiles.get(t) ?? { profiles: new Set(), uses: 0 };
            e.profiles.add(username);
            e.uses++;
            tagProfiles.set(t, e);
        }
    }

    const typeCounts = new Map<IgPostType, number>();
    for (const { p } of all) typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
    const formatEr = new Map(byKey((p) => p.type).map((x) => [x.k, x.v]));

    return {
        type: 'nicheReport',
        profilesAnalyzed: items.length,
        timeZone,
        ranking: items
            .map(({ profile, analysis }) => ({
                username: profile.username,
                followers: profile.followers,
                engagementRate: analysis.engagementRate,
                postsPerWeek: analysis.postsPerWeek,
                avgViews: analysis.avgViews,
                mainFormat: Object.entries(analysis.formatMix).sort((a, b) => b[1]!.share - a[1]!.share)[0]?.[0],
            }))
            .sort((a, b) => (b.engagementRate ?? -1) - (a.engagementRate ?? -1)),
        benchmarks: {
            medianEngagementRate: ers.length ? round(median(ers), 3) : null,
            medianPostsPerWeek: round(median(items.map((i) => i.analysis.postsPerWeek)), 2),
            medianFollowers: followers.length ? median(followers) : null,
        },
        formats: [...typeCounts.entries()]
            .map(([type, n]) => ({ type, share: round((n / all.length) * 100, 1), avgEngagementRate: formatEr.get(type) ?? null }))
            .sort((a, b) => (b.avgEngagementRate ?? -1) - (a.avgEngagementRate ?? -1)),
        bestDays: byKey((p) => localParts(p.takenAt, timeZone).day).map((x) => ({ day: x.k, avgEngagementRate: x.v })),
        bestHours: byKey((p) => localParts(p.takenAt, timeZone).hour)
            .filter((x) => x.n >= 2)
            .slice(0, 6)
            .map((x) => ({ hour: x.k, avgEngagementRate: x.v })),
        sharedHashtags: [...tagProfiles.entries()]
            .map(([tag, e]) => ({ tag, profiles: e.profiles.size, uses: e.uses }))
            .filter((t) => t.profiles >= Math.min(2, items.length))
            .sort((a, b) => b.profiles - a.profiles || b.uses - a.uses)
            .slice(0, 30),
        topPosts: [...all]
            .sort((a, b) => (b.er ?? 0) - (a.er ?? 0) || engagementOf(b.p) - engagementOf(a.p))
            .slice(0, 10)
            .map(({ p, username, er }) => ({ username, url: p.url, type: p.type, engagement: engagementOf(p), engagementRate: er === null ? null : round(er, 3), takenAt: p.takenAt, caption: p.caption.slice(0, 200) })),
    };
}

