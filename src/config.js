import 'dotenv/config';
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { Pinecone } from '@pinecone-database/pinecone';

// Provider selection: 'gemini' (default) or 'openrouter'
export const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

const isOpenRouter = LLM_PROVIDER === 'openrouter';

// Model names — overridable via env for easy experimentation.
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (isOpenRouter
    ? 'perplexity/pplx-embed-v1-0.6b'
    : 'gemini-embedding-001');

export const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION) || (isOpenRouter ? 1024 : 3072);

export const INDEX_METRIC = 'cosine';

export const CHAT_MODEL = process.env.CHAT_MODEL || (isOpenRouter
    ? 'inclusionai/ling-3.0-flash'
    : 'gemini-3.8-flash');

export const DEFAULT_SCORE_THRESHOLD = isOpenRouter ? 0.1 : 0.5;
export const DEFAULT_TOP_K = Number(process.env.TOP_K) || 4;
export const DEFAULT_MAX_HISTORY_MESSAGES = 10;

export const INDEX_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;

export function requireEnv(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is not set in .env`);
    }
    return value.trim();
}

export function getProviderEnv() {
    if (isOpenRouter) return requireEnv('OPENROUTER_API_KEY');
    return requireEnv('GEMINI_API_KEY');
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
    if (isOpenRouter) {
        return new OpenAIEmbeddings({
            apiKey: requireEnv('OPENROUTER_API_KEY'),
            model: EMBEDDING_MODEL,
            configuration: {
                baseURL: 'https://openrouter.ai/api/v1',
                defaultHeaders: {
                    'HTTP-Referer': 'https://github.com/avin-tomy/RagProject',
                    'X-Title': 'RAG Studio',
                    'X-OpenRouter-Cache': 'true',
                },
            },
        });
    }
    return new GoogleGenerativeAIEmbeddings({
        apiKey: requireEnv('GEMINI_API_KEY'),
        model: EMBEDDING_MODEL,
    });
}

export function createChatModel() {
    return createChatModelWithTemp(0.3);
}

export function createRewriteModel() {
    return createChatModelWithTemp(0);
}

export function createExtractionModel() {
    if (isOpenRouter) {
        return new ChatOpenAI({
            apiKey: requireEnv('OPENROUTER_API_KEY'),
            model: process.env.EXTRACTION_MODEL?.trim() || CHAT_MODEL,
            temperature: 0,
            configuration: {
                baseURL: 'https://openrouter.ai/api/v1',
                defaultHeaders: {
                    'HTTP-Referer': 'https://github.com/avin-tomy/RagProject',
                    'X-Title': 'RAG Studio',
                    'X-OpenRouter-Cache': 'true',
                },
            },
            modelKwargs: { response_format: { type: 'json_object' } },
        });
    }
    const model = process.env.EXTRACTION_MODEL?.trim() || CHAT_MODEL;
    return new ChatGoogleGenerativeAI({
        apiKey: requireEnv('GEMINI_API_KEY'),
        model,
        temperature: 0,
        responseMimeType: 'application/json',
    });
}

function createChatModelWithTemp(temperature) {
    if (isOpenRouter) {
        return new ChatOpenAI({
            apiKey: requireEnv('OPENROUTER_API_KEY'),
            model: CHAT_MODEL,
            temperature,
            configuration: {
                baseURL: 'https://openrouter.ai/api/v1',
                defaultHeaders: {
                    'HTTP-Referer': 'https://github.com/avin-tomy/RagProject',
                    'X-Title': 'RAG Studio',
                    'X-OpenRouter-Cache': 'true',
                },
            },
        });
    }
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