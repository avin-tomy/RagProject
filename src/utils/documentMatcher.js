const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

export function parsePageNumber(text) {
    const m = String(text || '').match(/page\s+(\w+)/i);
    if (!m) return null;
    const w = m[1].toLowerCase();
    if (/^\d+$/.test(w)) return parseInt(w, 10);
    return NUMBER_WORDS[w] || null;
}

export function matchDocument(question, documents) {
    if (!documents || documents.length === 0) return { matched: null, suggestion: null };

    const q = String(question || '').toLowerCase();
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 1. Try "page <num/word> of/in/from <docname>"
    const pageDocMatch = q.match(/page\s+\w+\s+(?:of|in|from|in the|from the)\s+(.+?)(?:\s*[?.!,]|\s*$)/i);
    let candidate = pageDocMatch ? pageDocMatch[1].trim() : null;

    // 2. Try "in/from/of <docname>.pdf"
    if (!candidate) {
        const m = q.match(/(?:in|from|of)\s+(?:the\s+)?(.+?\.pdf)\b/i);
        if (m && m[1]) candidate = m[1].trim();
    }

    // 3. Try "in/from/of <docname>" (generic, but skip "page N")
    if (!candidate) {
        const m = q.match(/(?:in|from|of)\s+(?:the\s+)?([A-Za-z0-9 _-]+?)(?:\s*[?.!,]|\s*$)/i);
        if (m && m[1]) {
            const c = m[1].trim();
            if (!/^page\s+\w+$/i.test(c)) candidate = c;
        }
    }

    // 4. If candidate found, only treat it as a document reference when it
    //    actually overlaps with one of the known document names. Generic phrases
    //    such as "the company", "the loan", or "this document" must not hijack
    //    the query.
    if (candidate) {
        const candidateWords = candidate.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
        const docWords = documents.flatMap((d) =>
            String(d.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
        );
        if (!candidateWords.some((w) => docWords.includes(w))) {
            return { matched: null, suggestion: null };
        }

        const cn = norm(candidate);
        // Exact or substring match
        for (const doc of documents) {
            const dn = norm(doc.name || '');
            if (dn === cn || dn.includes(cn) || cn.includes(dn)) {
                return { matched: doc, suggestion: null };
            }
        }
        // Try matching individual words from the candidate (last word first)
        const words = candidate.split(/\s+/).reverse();
        for (const w of words) {
            const wn = norm(w);
            if (wn.length < 3) continue;
            for (const doc of documents) {
                const dn = norm(doc.name || '');
                if (dn.includes(wn)) {
                    return { matched: doc, suggestion: null };
                }
            }
        }
        // Fuzzy: find closest by shared prefix
        let best = null;
        let bestScore = 0;
        for (const doc of documents) {
            const dn = norm(doc.name || '');
            let i = 0;
            while (i < cn.length && i < dn.length && cn[i] === dn[i]) i++;
            if (i > bestScore) { bestScore = i; best = doc; }
        }
        if (best && bestScore >= 5) {
            return { matched: null, suggestion: `Did you mean "${best.name}"?` };
        }
        return { matched: null, suggestion: `I don't have a document matching "${candidate}". Available: ${documents.map((d) => d.name).join(', ')}` };
    }

    // 5. No explicit document name — check if any document name is a substring of the question.
    const matches = documents.filter((doc) => q.includes((doc.name || '').toLowerCase()));
    if (matches.length === 1) {
        return { matched: matches[0], suggestion: null };
    }
    if (matches.length > 1) {
        return { matched: null, suggestion: null };
    }

    return { matched: null, suggestion: null };
}