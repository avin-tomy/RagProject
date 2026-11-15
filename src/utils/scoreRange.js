export function formatScoreRange(scores) {
    const values = (scores || []).filter((score) => Number.isFinite(score));
    if (values.length === 0) return null;
    return `${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}`;
}
