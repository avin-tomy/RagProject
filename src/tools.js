import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as graph from './graph.js';
import { pageRange } from './utils/pageRange.js';
import { formatScoreRange } from './utils/scoreRange.js';
import { normalizeName } from './utils/normalize.js';

export function createSearchTool(vectorStore, { scoreThreshold, defaultTopK = 10, documentFilter = null, documents = [] } = {}) {
    const docNames = (documents || []).map((d) => d.name).join(', ') || 'none';
    return tool(
        async ({ query, topK, document }) => {
            const q = (query || '').trim();
            if (!q) {
                return JSON.stringify({ query: '', context: '', pages: [], scoreRange: null, count: 0 });
            }
            const k = Math.min(Math.max(topK ?? defaultTopK, 1), 20);

            let filter = documentFilter ? { ...documentFilter } : null;
            if (document) {
                const norm = normalizeName;
                const dn = norm(document);
                const matched = (documents || []).find((d) => {
                    const n = norm(d.name);
                    return n === dn || n.includes(dn) || dn.includes(n);
                });
                if (matched) {
                    filter = { documentId: matched.documentId };
                    console.log(`Searching in document: "${matched.name}"`);
                }
            }

            console.log(`Searching the index for: "${q}" (top ${k})...` + (filter ? ` [filter: ${JSON.stringify(filter)}]` : ''));

            let results = await vectorStore.similaritySearchWithScore(q, k, filter || undefined);
            const docs = results
                .filter(([, score]) => score >= scoreThreshold)
                .map(([doc]) => doc);

            const pages = [...new Set(docs.map(pageRange).filter(Boolean))];
            const scoreRange = formatScoreRange(results.map(([, score]) => score));

            console.log(
                `  Retrieved ${results.length} chunks; kept ${docs.length} above the ` +
                `${scoreThreshold} threshold` +
                (scoreRange ? ` (scores ${scoreRange})` : '') +
                (pages.length ? ` (page(s): ${pages.join(', ')})` : '')
            );

            if (docs.length === 0) {
                return JSON.stringify({ query: q, context: '', pages: [], scoreRange, count: 0 });
            }

            const context = docs
                .map((doc) => `[Page ${pageRange(doc) ?? 'unknown'} | ${doc.metadata?.source ?? 'doc'}]\n${doc.pageContent}`)
                .join('\n\n---\n\n');

            return JSON.stringify({ query: q, context, pages, scoreRange, count: docs.length });
        },
        {
            name: 'search_documents',
            description:
                'Search the indexed PDF documentation for passages relevant to a query. ' +
                'Use this for any factual question about the document. You may call it ' +
                'multiple times with different, focused sub-queries to gather enough ' +
                'context before answering. Prefer specific standalone search phrases. ' +
                'Do not repeat the same query; vary phrasing for different aspects. ' +
                'Do not give up after one search: if results are partial, try broader or differently worded queries, ' +
                'or fetch the full page with get_page_content. ' +
                `Available documents: ${docNames}. Pass a "document" param to search a specific one.`,
            schema: z.object({
                query: z.string().describe('A focused, standalone search query'),
                topK: z.number().int().min(1).max(20).optional()
                    .describe('Number of chunks to retrieve (default 6)'),
                document: z.string().optional()
                    .describe(`Restrict search to a specific document by name. Available: ${docNames}`),
            }),
        }
    );
}

export function createDocumentListTool(documents = []) {
    return tool(
        async () => {
            if (!documents || documents.length === 0) {
                return JSON.stringify({ documents: [], message: 'No documents indexed.' });
            }
            return JSON.stringify({
                documents: documents.map((d) => ({ name: d.name, id: d.documentId })),
                count: documents.length,
            });
        },
        {
            name: 'list_documents',
            description:
                'List all indexed documents (PDFs) available for search. Use this to discover ' +
                'document names, then pass the exact name to search_documents or get_page_content ' +
                'via the "document" parameter to search a specific document.',
            schema: z.object({}),
        }
    );
}

const WRITE_KEYWORDS = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|CALL\s+db\.|LOAD\s+CSV|FOREACH)\b/i;

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
            return JSON.stringify({ summary: lines.join('\n'), documents: docs, sharedEntities: shared });
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

export function createPageContentTool(vectorStore, { scoreThreshold, documentFilter = null, documents = [] } = {}) {
    return tool(
        async ({ page, topK, document }) => {
            const docs = documents || [];
            const k = topK ?? 20;
            console.log(`Fetching content for page ${page}...`);

            const pageFilter = { $or: [{ page }, { pageEnd: page }] };
            let filter = documentFilter ? { $and: [documentFilter, pageFilter] } : pageFilter;
            if (document) {
                const norm = normalizeName;
                const dn = norm(document);
                const matched = docs.find((d) => {
                    const n = norm(d.name);
                    return n === dn || n.includes(dn) || dn.includes(n);
                });
                if (matched) {
                    filter = { $and: [filter, { documentId: matched.documentId }] };
                    console.log(`Fetching page ${page} from document: "${matched.name}"`);
                }
            }

            let results = await vectorStore.similaritySearchWithScore('content', k, filter);
            const pageDocs = results.map(([doc]) => doc);
            if (pageDocs.length === 0) {
                return JSON.stringify({ page, content: '', message: 'No content found for this page.' });
            }
            const content = pageDocs.map((d) => d.pageContent).join('\n\n---\n\n');
            const pages = [...new Set(pageDocs.map(pageRange).filter(Boolean))];
            return JSON.stringify({ page, content, pages, chunks: pageDocs.length });
        },
        {
            name: 'get_page_content',
            description:
                'Retrieve the full text content of a specific page number from the indexed document. ' +
                'Use this when the user asks to see, read, or show a specific page, or when you need ' +
                'the complete text of a page (not just search results). Also use it when search snippets ' +
                'are fragmented and you need the full page to answer fully. ' +
                (documents.length ? `Available documents: ${documents.map((d) => d.name).join(', ')}.` : ''),
            schema: z.object({
                page: z.number().int().min(1).describe('The page number to retrieve'),
                topK: z.number().int().min(1).max(50).optional().describe('Max chunks to fetch (default 20)'),
                document: z.string().optional().describe('Restrict to a specific document by name'),
            }),
        }
    );
}

export function createExtractTablesTool(vectorStore, { documentFilter = null, documents = [] } = {}) {
    return tool(
        async ({ page, document }) => {
            const docs = documents || [];
            console.log(`Extracting tables from page ${page}...`);
            const pageFilter = { $or: [{ page }, { pageEnd: page }] };
            let filter = documentFilter ? { $and: [documentFilter, pageFilter] } : pageFilter;
            if (document) {
                const norm = normalizeName;
                const dn = norm(document);
                const matched = docs.find((d) => {
                    const n = norm(d.name);
                    return n === dn || n.includes(dn) || dn.includes(n);
                });
                if (matched) {
                    filter = { $and: [filter, { documentId: matched.documentId }] };
                }
            }
            const results = await vectorStore.similaritySearchWithScore('table', 20, filter);
            const tableDocs = results.map(([doc]) => doc);
            if (tableDocs.length === 0) {
                return JSON.stringify({ page, tables: [], message: 'No content found for this page.' });
            }
            const content = tableDocs.map((d) => d.pageContent).join('\n\n---\n\n');
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
                'Extract tabular data (fee schedules, rate cards, thresholds) from a specific page. ' +
                'Use this when the user asks about tables, slabs, or structured data in the document.',
            schema: z.object({
                page: z.number().int().min(1).describe('The page number to extract tables from'),
                document: z.string().optional().describe('Restrict to a specific document by name'),
            }),
        }
    );
}

export function createCalculatorTool() {
    return tool(
        async ({ expression }) => {
            const cleaned = expression.replace(/Math\.\w+/g, '');
            if (cleaned && !/^[\d\s+\-*/().,%^eE]+$/.test(cleaned)) {
                return JSON.stringify({ error: 'Invalid expression. Only math operations are allowed.' });
            }
            try {
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