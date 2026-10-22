/**
 * Flattens records to CSV. SERP pages → one row per organic result; web pages → one row per page;
 * Instagram → one row per post (with the profile's key metrics), or per profile with `instagramView: 'profiles'`.
 */
export function toCsv(records: unknown[], mode: 'web' | 'google' | 'instagram', instagramView: 'posts' | 'profiles' = 'posts'): string {
    const rows: Record<string, unknown>[] = [];
    for (const rec of records as Record<string, any>[]) {
        if (mode === 'instagram') {
            if (rec.type !== 'profile') continue;
            const pr = rec.profile;
            const a = rec.analysis;
            const base = { username: pr.username, followers: pr.followers, category: pr.category, engagementRatePct: a.engagementRate, postsPerWeek: a.postsPerWeek };
            if (instagramView === 'profiles' || !rec.posts) {
                rows.push({
                    ...base,
                    fullName: pr.fullName,
                    following: pr.following,
                    postsCount: pr.postsCount,
                    verified: pr.isVerified,
                    externalUrl: pr.externalUrl,
                    avgLikes: a.avgLikes,
                    avgComments: a.avgComments,
                    avgViews: a.avgViews,
                    mainFormats: Object.entries(a.formatMix).map(([k, v]: [string, any]) => `${k} ${v.share}%`).join(' | '),
                    bestDay: a.bestDays[0]?.day,
                    bestHour: a.bestHours[0]?.hour,
                    topHashtags: a.topHashtags.slice(0, 10).map((t: any) => `#${t.tag}`).join(' '),
                    biography: pr.biography,
                });
            } else {
                for (const p of rec.posts) {
                    rows.push({ ...base, url: p.url, type: p.type, takenAt: p.takenAt, likes: p.likes, comments: p.comments, views: p.views, pinned: p.isPinned, collab: p.isCollab, hashtags: p.hashtags.map((t: string) => `#${t}`).join(' '), caption: p.caption });
                }
            }
        } else if (mode === 'google') {
            for (const r of rec.organicResults ?? []) {
                rows.push({ query: rec.searchQuery?.term, page: rec.searchQuery?.page, position: r.position, title: r.title, url: r.url, displayedUrl: r.displayedUrl, description: r.description, date: r.date });
            }
        } else {
            const row: Record<string, unknown> = {
                url: rec.loadedUrl ?? rec.url,
                statusCode: rec.statusCode,
                renderedWith: rec.renderedWith,
                title: rec.metadata?.title,
                description: rec.metadata?.description,
                h1: rec.headings?.h1?.join(' | '),
            };
            for (const [k, v] of Object.entries(rec.fields ?? {})) row[`field.${k}`] = Array.isArray(v) ? v.join(' | ') : v;
            if (rec.contacts) {
                row.emails = rec.contacts.emails.join(' | ');
                row.phones = rec.contacts.phones.join(' | ');
                row.social = rec.contacts.social.join(' | ');
            }
            rows.push(row);
        }
    }
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const esc = (v: unknown) => {
        if (v === undefined || v === null) return '';
        let s = String(v);
        // Neutralize spreadsheet formula injection (plain numbers like "+34600123456" are harmless).
        if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().|+-]+$/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}
