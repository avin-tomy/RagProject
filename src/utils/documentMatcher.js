/**
 * Try to match a document name mentioned in a question to one of the
 * user's indexed documents.
 *
 * Returns { matched: doc | null, suggestion: string | null }
 */
export function matchDocument(question, documents) {
    if (!documents || documents.length === 0) return { matched: null, suggestion: null };

    const q = String(question || '').toLowerCase();

    // 1. Try explicit patterns: "page N of/in/from X", "in X", "from X"
    const patterns = [
        /page\s+\d+\s+(?:of|in|from|in the|from the)\s+(.+?)(?:\s*$|\s*[?.!,])/i,
        /(?:in|from|of)\s+(?:the\s+)?(.+?\.pdf)\b/i,
    ];

    let candidate = null;
    for (const p of patterns) {
        const m = q.match(p);
        if (m && m[1]) {
            const c = m[1].trim();
            // Skip if the candidate is just "page N" (not a document name)
            if (/^page\s+\d+$/i.test(c)) continue;
            candidate = c;
            break;
        }
    }

    // If no candidate from patterns, check the third pattern but exclude "page N"
    if (!candidate) {
        const m = q.match(/(?:in|from|of)\s+(?:the\s+)?([A-Za-z0-9 _-]+?)(?:\s*[?.!,]|\s*$)/i);
        if (m && m[1]) {
            const c = m[1].trim();
            if (!/^page\s+\d+$/i.test(c)) {
                candidate = c;
            }
        }
    }

    // 2. If a candidate was extracted, fuzzy-match against document names.
    if (candidate) {
        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cn = norm(candidate);
        // Exact or substring match
        for (const doc of documents) {
            const dn = norm(doc.name || '');
            if (dn === cn || dn.includes(cn) || cn.includes(dn)) {
                return { matched: doc, suggestion: null };
            }
        }
        // Levenshtein-ish: find closest by shared prefix
        let best = null;
        let bestScore = 0;
        for (const doc of documents) {
            const dn = norm(doc.name || '');
            // simple similarity: longest common prefix length
            let i = 0;
            while (i < cn.length && i < dn.length && cn[i] === dn[i]) i++;
            if (i > bestScore) { bestScore = i; best = doc; }
        }
        if (best && bestScore >= 3) {
            return { matched: null, suggestion: `Did you mean "${best.name}"?` };
        }
        return { matched: null, suggestion: `I don't have a document matching "${candidate}". Available: ${documents.map((d) => d.name).join(', ')}` };
    }

    // 3. No explicit document name in question — check if any document name is a substring of the question.
    const matches = documents.filter((doc) => q.includes((doc.name || '').toLowerCase()));
    if (matches.length === 1) {
        return { matched: matches[0], suggestion: null };
    }
    if (matches.length > 1) {
        return { matched: null, suggestion: null }; // ambiguous, search all
    }

    return { matched: null, suggestion: null };
}