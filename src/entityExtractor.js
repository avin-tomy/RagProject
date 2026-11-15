import { createExtractionModel } from './config.js';
import { withRetry } from './retry.js';

const EXTRACTION_PROMPT = `You are an information extraction engine. Given a passage from a document, extract all named entities and their relationships.

Return a JSON object with this shape:
{
  "entities": [
    { "name": "...", "type": "...", "description": "..." }
  ],
  "relations": [
    { "from": "entity name", "fromType": "entity type", "to": "entity name", "toType": "entity type", "type": "RELATION_LABEL", "evidence": "short supporting phrase" }
  ]
}

Rules:
- Entity types are free-form (Concept, Person, Equation, Figure, Chapter, Algorithm, Organization, Location, Date, Variable, etc.). Use whatever fits.
- Relation types are free-form uppercase labels (DEFINES, USES, PREREQUISITE, BUILDS_ON, CONTRADICTS, PART_OF, MENTIONS, etc.).
- Only extract entities actually present in the passage. Do not invent.
- Keep names concise and consistent (e.g. "Node.js" not "Node JS").
- If nothing meaningful, return {"entities":[],"relations":[]}.

Passage:
`;

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