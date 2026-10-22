/**
 * Instagram serves the same post in two JSON shapes:
 *  - "legacy" GraphQL nodes (web_profile_info, anonymous GraphQL): shortcode, taken_at_timestamp, edge_*;
 *  - "v1" items (newer GraphQL / private web API): code, taken_at, like_count, media_type 1|2|8.
 * Both are normalized here, and `findPosts` digs either shape out of any captured response.
 */

export interface IgProfile {
    id: string;
    username: string;
    fullName?: string;
    biography?: string;
    externalUrl?: string;
    bioLinks?: string[];
    followers?: number;
    following?: number;
    postsCount?: number;
    isVerified?: boolean;
    isBusiness?: boolean;
    category?: string;
    profilePicUrl?: string;
    url: string;
}

export type IgPostType = 'image' | 'video' | 'reel' | 'carousel';

export interface IgPost {
    shortcode: string;
    url: string;
    type: IgPostType;
    takenAt: string;
    caption: string;
    hashtags: string[];
    mentions: string[];
    likes: number | null; // null when the owner hides like counts
    comments: number;
    views: number | null;
    isPinned: boolean;
    isCollab: boolean;
    location?: string;
    thumbnailUrl?: string;
}

type J = Record<string, any>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function normalizeProfile(u: J): IgProfile {
    const bioLinks = Array.isArray(u.bio_links) ? u.bio_links.map((l: J) => l.url).filter(Boolean) : [];
    return {
        id: String(u.id ?? u.pk ?? ''),
        username: u.username,
        fullName: u.full_name || undefined,
        biography: u.biography || undefined,
        externalUrl: u.external_url || undefined,
        bioLinks: bioLinks.length ? bioLinks : undefined,
        followers: num(u.edge_followed_by?.count) ?? num(u.follower_count),
        following: num(u.edge_follow?.count) ?? num(u.following_count),
        postsCount: num(u.edge_owner_to_timeline_media?.count) ?? num(u.media_count),
        isVerified: u.is_verified,
        isBusiness: u.is_business_account ?? u.is_professional_account,
        category: u.category_name || u.business_category_name || undefined,
        profilePicUrl: u.profile_pic_url_hd || u.profile_pic_url || undefined,
        url: `https://www.instagram.com/${u.username}/`,
    };
}

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
const MENTION_RE = /(?:^|[^\w.])@([a-z0-9._]{1,30})/gi;

function captionParts(caption: string) {
    const hashtags = [...new Set([...caption.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()))];
    const mentions = [...new Set([...caption.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase().replace(/\.$/, '')))];
    return { hashtags, mentions };
}

/** Accepts a legacy node or a v1 item; returns null for anything that isn't a post. */
export function normalizePost(n: J): IgPost | null {
    const shortcode: string | undefined = n.shortcode ?? n.code;
    const ts: number | undefined = num(n.taken_at_timestamp) ?? num(n.taken_at);
    if (!shortcode || !ts) return null;

    let type: IgPostType;
    if (n.__typename) {
        type = n.__typename.endsWith('Sidecar') ? 'carousel' : n.__typename.endsWith('Video') ? 'video' : 'image';
    } else {
        type = n.media_type === 8 ? 'carousel' : n.media_type === 2 ? 'video' : 'image';
    }
    if (type === 'video' && (n.product_type === 'clips' || n.media_type === 2 && n.product_type === 'clips')) type = 'reel';

    const caption: string = n.edge_media_to_caption?.edges?.[0]?.node?.text ?? n.caption?.text ?? (typeof n.caption === 'string' ? n.caption : '') ?? '';
    const likes = num(n.edge_liked_by?.count) ?? num(n.edge_media_preview_like?.count) ?? num(n.like_count);
    const hiddenLikes = n.like_and_view_counts_disabled === true || likes === -1;
    const views = num(n.video_view_count) ?? num(n.play_count) ?? num(n.view_count) ?? num(n.ig_play_count);

    return {
        shortcode,
        url: `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${shortcode}/`,
        type,
        takenAt: new Date(ts * 1000).toISOString(),
        caption,
        ...captionParts(caption),
        likes: hiddenLikes || likes === undefined ? null : likes,
        comments: num(n.edge_media_to_comment?.count) ?? num(n.comment_count) ?? 0,
        views: views ?? null,
        isPinned: Boolean((Array.isArray(n.pinned_for_users) && n.pinned_for_users.length) || n.timeline_pinned_user_ids?.length),
        isCollab: Boolean(n.coauthor_producers?.length),
        location: n.location?.name || undefined,
        thumbnailUrl: n.display_url ?? n.thumbnail_src ?? n.image_versions2?.candidates?.[0]?.url,
    };
}

/** Recursively collects every post-shaped object in an arbitrary JSON payload. */
export function findPosts(payload: unknown, out = new Map<string, IgPost>(), depth = 0): Map<string, IgPost> {
    if (depth > 25 || payload === null || typeof payload !== 'object') return out;
    if (Array.isArray(payload)) {
        for (const v of payload) findPosts(v, out, depth + 1);
        return out;
    }
    const o = payload as J;
    if ((o.shortcode || o.code) && (o.taken_at_timestamp || o.taken_at)) {
        const p = normalizePost(o);
        if (p && !out.has(p.shortcode)) out.set(p.shortcode, p);
        // Don't descend: carousel children would be counted as posts.
        return out;
    }
    for (const v of Object.values(o)) findPosts(v, out, depth + 1);
    return out;
}

/** The profile user object inside any captured payload (web_profile_info or GraphQL). */
export function findUser(payload: unknown, username: string, depth = 0): J | undefined {
    if (depth > 25 || payload === null || typeof payload !== 'object') return undefined;
    const o = payload as J;
    if (!Array.isArray(o) && typeof o.username === 'string' && o.username.toLowerCase() === username.toLowerCase() && (o.edge_followed_by || o.follower_count !== undefined)) {
        return o;
    }
    for (const v of Object.values(o)) {
        const found = findUser(v, username, depth + 1);
        if (found) return found;
    }
    return undefined;
}

/** "@Name", "instagram.com/name/", "https://www.instagram.com/name/?hl=es" → "name". */
export function parseUsername(input: string): string | undefined {
    const s = input.trim();
    const fromUrl = s.match(/instagram\.com\/([a-z0-9._]{1,30})(?:[/?#]|$)/i)?.[1];
    const name = (fromUrl ?? s.replace(/^@/, '')).toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(name)) return undefined;
    if (['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'about', 'direct', 'tv', 'web', 'developer', 'legal'].includes(name)) return undefined;
    return name;
}
