import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as graph from './graph.js';

function formatScoreRange(scores) {
    const values = scores.filter((score) => Number.isFinite(score));
    if (values.length === 0) return null;
    return `${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}`;
}

function pageRange(doc) {
    const start = doc.metadata?.page;
    const end = doc.metadata?.pageEnd;
    if (typeof start !== 'number') return null;
    return typeof end === 'number' && end !== start ? `${start}-${end}` : `${start}`;
}

export function createSearchTool(vectorStore, { scoreThreshold, defaultTopK = 10, documentFilter = null } = {}) {
    return tool(
        async ({ query, topK }) => {
            const q = (query || '').trim();
            if (!q) {
                return JSON.stringify({ query: '', context: '', pages: [], scoreRange: null, count: 0 });
            }
            const k = Math.min(Math.max(topK ?? defaultTopK, 1), 20);
            console.log(`Searching the index for: "${q}" (top ${k})...`);

            const results = await vectorStore.similaritySearchWithScore(q, k, documentFilter || undefined);
            const documents = results
                .filter(([, score]) => score >= scoreThreshold)
                .map(([doc]) => doc);

            const pages = [...new Set(documents.map(pageRange).filter(Boolean))];
            const scoreRange = formatScoreRange(results.map(([, score]) => score));

            console.log(
                `  Retrieved ${results.length} chunks; kept ${documents.length} above the ` +
                `${scoreThreshold} threshold` +
                (scoreRange ? ` (scores ${scoreRange})` : '') +
                (pages.length ? ` (page(s): ${pages.join(', ')})` : '')
            );

            if (documents.length === 0) {
                return JSON.stringify({ query, context: '', pages: [], scoreRange, count: 0 });
            }

            const context = documents
                .map((doc) => `[Page ${pageRange(doc) ?? 'unknown'} | ${doc.metadata?.source ?? 'doc'}]\n${doc.pageContent}`)
                .join('\n\n---\n\n');

            return JSON.stringify({ query, context, pages, scoreRange, count: documents.length });
        },
        {
            name: 'search_documents',
            description:
                'Search the indexed PDF documentation for passages relevant to a query. ' +
                'Use this for any factual question about the document. You may call it ' +
                'multiple times with different, focused sub-queries to gather enough ' +
                'context before answering. Prefer specific standalone search phrases.',
            schema: z.object({
                query: z.string().describe('A focused, standalone search query'),
                topK: z.number().int().min(1).max(20).optional()
                    .describe('Number of chunks to retrieve (default 10)'),
            }),
        }
    );
}

const WRITE_KEYWORDS = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|CALL\s+db\.|LOAD\s+CSV|FOREACH)\b/i;

export function createListDocumentsTool(indexName) {
    return tool(
        async () => {
            if (!graph.getDriver()) return JSON.stringify({ error: 'Graph not configured' });
            const docs = await graph.listDocuments(indexName);
            return JSON.stringify({ documents: docs, count: docs.length });
        },
        {
            name: 'list_documents',
            description: 'List all documents (PDFs) indexed in the knowledge graph. Use this to discover what documents are available before comparing or cross-referencing.',
            schema: z.object({}),
        }
    );
}

export function createCompareDocumentsTool(indexName) {
    return tool(
        async () => {
            if (!graph.getDriver()) return JSON.stringify({ error: 'Graph not configured' });
            const docs = await graph.listDocuments(indexName);
            const shared = await graph.findSharedEntities(indexName);
            const lines = [];
            lines.push(`Documents in index (${docs.length}):`);
            for (const d of docs) {
                lines.push(`  - ${d.name}${d.documentId ? ` (id: ${d.documentId})` : ''}`);
            }
            lines.push('');
            if (shared.length === 0) {
                lines.push('No shared entities found across documents — they appear unrelated.');
            } else {
                lines.push(`Shared entities across documents (${shared.length}):`);
                for (const e of shared) {
                    lines.push(`  - ${e.name} (${e.type}) — appears in ${e.docCount} documents`);
                }
            }
            return JSON.stringify({ summary: lines.join('\\n'), documents: docs, sharedEntities: shared });
        },
        {
            name: 'compare_documents',
            description:
                'Compare all indexed documents and find shared entities/concepts across them. ' +
                'Use this for questions like "Are these documents related?", "What do they have in common?", ' +
                '"Compare document A and B", or "Which concepts appear in multiple documents?". ' +
                'Returns the list of documents and entities shared between them.',
            schema: z.object({}),
        }
    );
}
export function createPageContentTool(vectorStore, { scoreThreshold } = {}) {
    return tool(
        async ({ page, topK }) => {
            const k = topK ?? 20;
            console.log(`Fetching content for page ${page}...`);
            const results = await vectorStore.similaritySearchWithScore('content', k, { page });
            const docs = results.map(([doc]) => doc);
            if (docs.length === 0) {
                return JSON.stringify({ page, content: '', message: 'No content found for this page.' });
            }
            const content = docs.map((d) => d.pageContent).join('\n\n---\n\n');
            const pages = [...new Set(docs.map(pageRange).filter(Boolean))];
            return JSON.stringify({ page, content, pages, chunks: docs.length });
        },
        {
            name: 'get_page_content',
            description:
                'Retrieve the full text content of a specific page number from the indexed document. ' +
                'Use this when the user asks to see, read, or show a specific page, or when you need ' +
                'the complete text of a page (not just search results).',
            schema: z.object({
                page: z.number().int().min(1).describe('The page number to retrieve'),
                topK: z.number().int().min(1).max(50).optional().describe('Max chunks to fetch (default 20)'),
            }),
        }
    );
}

export function createExtractTablesTool(vectorStore) {
    return tool(
        async ({ page }) => {
            console.log(`Extracting tables from page ${page}...`);
            const results = await vectorStore.similaritySearchWithScore('table', 20, { page });
            const docs = results.map(([doc]) => doc);
            if (docs.length === 0) {
                return JSON.stringify({ page, tables: [], message: 'No content found for this page.' });
            }
            const content = docs.map((d) => d.pageContent).join('\n\n---\n\n');
            // Detect table-like lines (multiple spaces, tabs, or pipe separators)
            const tableLines = content.split('\n').filter((line) =>
                /\s{2,}|\t|\|/.test(line) && line.trim().length > 10
            );
            return JSON.stringify({
                page,
                content,
                tableLines,
                hasTables: tableLines.length > 0,
                message: tableLines.length > 0
                    ? `Found ${tableLines.length} potential table lines on page ${page}.`
                    : 'No table-like structures detected on this page.',
            });
        },
        {
            name: 'extract_tables',
            description:
                'Extract tabular data (fee schedules, rate cards, threshold tables, etc.) from a specific page. ' +
                'Use this when the user asks about tables, fee slabs, rate cards, or structured data in the document.',
            schema: z.object({
                page: z.number().int().min(1).describe('The page number to extract tables from'),
            }),
        }
    );
}

export function createCalculatorTool() {
    return tool(
        async ({ expression }) => {
            // Safe math evaluation: only allow numbers, operators, parentheses, and Math functions
            const sanitized = expression.replace(/\s/g, '');
            if (!/^[0-9+\-*/().,%^eE]+$/.test(sanitized) && !/^[\d\s+\-*/().,%^eE]+$/.test(expression)) {
                // Allow Math. prefix for functions
                const cleaned = expression.replace(/Math\.\w+/g, '');
                if (!/^[\d\s+\-*/().,%^eE]+$/.test(cleaned)) {
                    return JSON.stringify({ error: 'Invalid expression. Only math operations are allowed.' });
                }
            }
            try {
                // eslint-disable-next-line no-new-func
                const fn = new Function('Math', `"use strict"; return (${expression})`);
                const result = fn(Math);
                if (!Number.isFinite(result)) {
                    return JSON.stringify({ expression, error: 'Result is not a finite number' });
                }
                return JSON.stringify({ expression, result: Number(result.toFixed(6)) });
            } catch (err) {
                return JSON.stringify({ expression, error: `Calculation failed: ${err.message}` });
            }
        },
        {
            name: 'calculate',
            description:
                'Perform mathematical calculations (percentages, interest, EMI, fees, limits). ' +
                'Use this for any numeric computation. Supports +, -, *, /, %, parentheses, and Math functions (sqrt, pow, etc.). ' +
                'Example: "100000 * 0.12" or "Math.pow(1.085, 20) * 1000000".',
            schema: z.object({
                expression: z.string().describe('A mathematical expression to evaluate'),
            }),
        }
    );
}
export function createGraphTool(indexName) {
    return tool(
        async ({ cypher, params }) => {
            if (!graph.getDriver()) {
                return JSON.stringify({ error: 'Graph database not configured' });
            }
            if (WRITE_KEYWORDS.test(cypher)) {
                return JSON.stringify({ error: 'Only read queries are allowed' });
            }
            let parsedParams = {};
            if (params) {
                try { parsedParams = JSON.parse(params); } catch { parsedParams = {}; }
            }
            console.log('Querying graph:', cypher.slice(0, 120));
            const res = await graph.queryGraph(indexName, cypher, parsedParams);
            return JSON.stringify(res);
        },
        {
            name: 'query_graph',
            description:
                'Query the knowledge graph of the indexed document using Cypher (read-only). ' +
                'Use for relationship/traversal questions (e.g. prerequisites, dependencies, ' +
                'what builds on X, list all entities of a type, how concepts connect). ' +
                'Nodes: Document, Chunk, Entity (each has indexName). Edges: PART_OF, MENTIONS, RELATES_TO (type property). ' +
                'Always filter by indexName: $indexName is provided as a parameter. Example: ' +
                'MATCH (e:Entity {indexName:$indexName})-[:RELATES_TO]->(r) RETURN e.name, r.name LIMIT 20',
            schema: z.object({
                cypher: z.string().describe('A read-only Cypher query'),
                params: z.string().optional().describe('JSON string of query parameters (default "{}")'),
            }),
        }
    );
}