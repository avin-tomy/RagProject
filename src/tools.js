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

export function createSearchTool(vectorStore, { scoreThreshold, defaultTopK = 10 } = {}) {
    return tool(
        async ({ query, topK }) => {
            const k = Math.min(Math.max(topK ?? defaultTopK, 1), 20);
            console.log(`Searching the index for: "${query}" (top ${k})...`);

            const results = await vectorStore.similaritySearchWithScore(query, k);
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
                .map((doc) => `[Page ${pageRange(doc) ?? 'unknown'}]\n${doc.pageContent}`)
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