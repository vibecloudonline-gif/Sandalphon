/**
 * Ratcliff/Obershelp similarity (the algorithm behind Python's difflib.SequenceMatcher.ratio),
 * for strings or arrays of tokens. Returns 0..1.
 */
export function ratio<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
    if (a.length === 0 && b.length === 0) return 1;
    return (2 * matchingCount(a, 0, a.length, b, 0, b.length)) / (a.length + b.length);
}

function matchingCount<T>(a: ArrayLike<T>, aLo: number, aHi: number, b: ArrayLike<T>, bLo: number, bHi: number): number {
    if (aLo >= aHi || bLo >= bHi) return 0;
    // Longest common contiguous block, O(n*m) with a rolling row.
    let best = 0;
    let bestA = aLo;
    let bestB = bLo;
    let prev = new Array<number>(bHi - bLo + 1).fill(0);
    for (let i = aLo; i < aHi; i++) {
        const row = new Array<number>(bHi - bLo + 1).fill(0);
        for (let j = bLo; j < bHi; j++) {
            if (a[i] === b[j]) {
                const len = prev[j - bLo] + 1;
                row[j - bLo + 1] = len;
                if (len > best) {
                    best = len;
                    bestA = i - len + 1;
                    bestB = j - len + 1;
                }
            }
        }
        prev = row;
    }
    if (best === 0) return 0;
    return (
        best +
        matchingCount(a, aLo, bestA, b, bLo, bestB) +
        matchingCount(a, bestA + best, aHi, b, bestB + best, bHi)
    );
}

/** Similarity of two attribute maps: half for the keys, half for the values. */
export function dictRatio(a: Record<string, string>, b: Record<string, string>): number {
    return ratio(Object.keys(a), Object.keys(b)) * 0.5 + ratio(Object.values(a), Object.values(b)) * 0.5;
}
