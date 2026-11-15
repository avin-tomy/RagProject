export function pageRange(doc) {
    const start = doc?.metadata?.page;
    const end = doc?.metadata?.pageEnd;
    if (typeof start !== 'number') return null;
    return typeof end === 'number' && end !== start ? `${start}-${end}` : `${start}`;
}
