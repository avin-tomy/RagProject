import { createExtractionModel } from './config.js';
import { withRetry } from './retry.js';

export async function extractEntitiesBatch(prompt, model) {
    const m = model || createExtractionModel();
    const result = await withRetry(
        async () => {
            const res = await m.invoke(prompt);
            const raw = typeof res.content === 'string' ? res.content : (Array.isArray(res.content) ? res.content.map(c => c.text || c).join('') : String(res.content));
            const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
            // Tolerate surrounding prose by extracting the first JSON object.
            const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
            try {
                return JSON.parse(jsonText);
            } catch (err) {
                throw Object.assign(new Error('Invalid JSON from extraction model'), { retryable: true });
            }
        },
        { label: 'Entity extraction (batch)', maxAttempts: 3, baseDelayMs: 500 }
    );
    if (!result.ok) {
        console.warn('Batch entity extraction failed:', result.message);
        return [];
    }
    return result.value;
}