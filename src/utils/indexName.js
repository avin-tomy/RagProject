import crypto from 'node:crypto';
import { INDEX_NAME_PATTERN } from '../config.js';

export function generateIndexName() {
    for (let i = 0; i < 10; i++) {
        const candidate = `rag-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        if (INDEX_NAME_PATTERN.test(candidate)) return candidate;
    }
    throw new Error('Could not generate a valid index name');
}
