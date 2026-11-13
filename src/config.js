import 'dotenv/config';
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Pinecone } from '@pinecone-database/pinecone';

// Single source of truth for the models used by both indexing and querying.
export const EMBEDDING_MODEL = 'gemini-embedding-001';

// gemini-embedding-001 produces 3072-dimensional vectors by default.
// The Pinecone index dimension must match exactly.
export const EMBEDDING_DIMENSION = 3072;
export const INDEX_METRIC = 'cosine';

// The chat model name is intentionally kept as-is.
export const CHAT_MODEL = 'gemini-3.8-flash';

export const DEFAULT_SCORE_THRESHOLD = 0.5;
export const DEFAULT_TOP_K = 10;
export const DEFAULT_MAX_HISTORY_MESSAGES = 10;

export const INDEX_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;

export function requireEnv(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is not set in .env`);
    }
    return value.trim();
}

export function getIndexName() {
    const indexName = requireEnv('PINECONE_INDEX_NAME');
    if (!INDEX_NAME_PATTERN.test(indexName)) {
        throw new Error(
            `PINECONE_INDEX_NAME "${indexName}" is invalid. Use 1-45 lowercase letters, ` +
            'digits, or hyphens, starting and ending with a letter or digit.'
        );
    }
    return indexName;
}

export function getScoreThreshold() {
    const raw = process.env.SCORE_THRESHOLD;
    if (raw == null || raw.trim() === '') return DEFAULT_SCORE_THRESHOLD;

    const value = Number(raw);
    if (!Number.isFinite(value) || value < -1 || value > 1) {
        throw new Error(`SCORE_THRESHOLD must be a number between -1 and 1 (got "${raw}")`);
    }
    return value;
}

export function getPineconeCloud() {
    return process.env.PINECONE_CLOUD?.trim() || 'aws';
}

export function getPineconeRegion() {
    return process.env.PINECONE_REGION?.trim() || 'us-east-1';
}

export function isNotFoundError(err) {
    return err?.name === 'PineconeNotFoundError' ||
        /\b404\b/.test(err instanceof Error ? err.message : String(err));
}

export function createEmbeddingModel() {
    return new GoogleGenerativeAIEmbeddings({
        apiKey: requireEnv('GEMINI_API_KEY'),
        model: EMBEDDING_MODEL,
    });
}

export function createChatModel() {
    return createGeminiChatModel(0.3);
}

// Rewriting is a deterministic transformation, so it uses temperature 0 and a
// separate model instance from the answer model.
export function createRewriteModel() {
    return createGeminiChatModel(0);
}

// Extraction model: temperature 0 + JSON mode for reliable entity extraction.
export function createExtractionModel() {
    const model = process.env.EXTRACTION_MODEL?.trim() || CHAT_MODEL;
    return new ChatGoogleGenerativeAI({
        apiKey: requireEnv('GEMINI_API_KEY'),
        model,
        temperature: 0,
        responseMimeType: 'application/json',
    });
}

function createGeminiChatModel(temperature) {
    return new ChatGoogleGenerativeAI({
        apiKey: requireEnv('GEMINI_API_KEY'),
        model: CHAT_MODEL,
        temperature,
    });
}

export function createPineconeClient() {
    return new Pinecone({ apiKey: requireEnv('PINECONE_API_KEY') });
}

export function assertIndexCompatible(index, indexName) {
    if (index.dimension !== EMBEDDING_DIMENSION) {
        throw new Error(
            `Index "${indexName}" has dimension ${index.dimension}, but the embedding model produces ` +
            `${EMBEDDING_DIMENSION}-dimensional vectors. Delete the index or create one with the correct dimension.`
        );
    }

    if (index.metric !== INDEX_METRIC) {
        throw new Error(
            `Index "${indexName}" uses metric "${index.metric}", but this app requires "${INDEX_METRIC}". ` +
            'Delete the index or create one with the correct metric.'
        );
    }
}
