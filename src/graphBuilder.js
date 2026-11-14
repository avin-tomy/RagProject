import { createExtractionModel } from './config.js';
import { extractEntitiesBatch } from './entityExtractor.js';
import * as graph from './graph.js';

/**
 * Build a knowledge graph for an already-indexed PDF.
 * @param {object} opts
 * @param {string} opts.indexName
 * @param {string} opts.docName
 * @param {Array<{text:string,page:number,pageEnd?:number}>} opts.chunks
 * @param {number} opts.totalPages
 * @param {function} [opts.onProgress] (phase, pct)
 * @param {number} [opts.concurrency=5]
 * @param {number} [opts.batchSize=3]
 */
export async function buildKnowledgeGraph({ indexName, docName, documentId, chunks, totalPages, onProgress, concurrency, batchSize } = {}) {
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    if (!graph.getDriver()) {
        throw new Error('Neo4j is not configured');
    }
    await graph.clearGraphDocument(indexName, documentId);
    await graph.upsertDocument(indexName, docName, totalPages || 0, documentId);

    const graphChunks = (chunks || []).map((c, i) => ({
        id: `${docName}-${i}`,
        text: c.text || c,
        page: c.page,
        pageEnd: c.pageEnd,
        index: i,
    }));

    await graph.batchUpsertChunks(indexName, docName, graphChunks.map(gc => ({...gc, documentId: documentId || ''})));

    const MIN_CHUNK_LEN = 100;
    const CONC = Number(concurrency) || Number(process.env.GRAPH_CONCURRENCY) || 8;
    const BS = Math.max(1, Number(batchSize) || Number(process.env.GRAPH_BATCH_SIZE) || 3);

    const allEntities = [];
    const allRelations = [];
    const chunkEntityLinks = [];
    let totalEntities = 0;
    let totalRels = 0;

    const candidates = graphChunks
        .map((gc, i) => ({ gc, doc: chunks[i], i }))
        .filter(({ doc }) => ((doc?.text || doc) || '').trim().length >= MIN_CHUNK_LEN);

    const batches = [];
    for (let i = 0; i < candidates.length; i += BS) {
        batches.push(candidates.slice(i, i + BS));
    }

    const extractionModel = createExtractionModel();
    let cursor = 0;
    let doneCount = 0;
    async function worker() {
        while (cursor < batches.length) {
            const batch = batches[cursor++];
            const passages = batch.map((b, j) => `--- Passage ${j + 1} ---\n${(b.doc?.text || b.doc || '').slice(0, 1000)}`).join('\n\n');
            const prompt = `You are an information extraction engine. Given ${batch.length} passages, extract entities and relations from EACH passage.

Return a JSON array with exactly ${batch.length} objects, one per passage, in order:
[
  { "entities": [{"name":"...","type":"...","description":"..."}], "relations": [{"from":"...","fromType":"...","to":"...","toType":"...","type":"RELATION_LABEL","evidence":"..."}] }
]

Rules:
- Entity types are free-form (Concept, Person, Equation, Figure, Chapter, etc.).
- Relation types are free-form uppercase labels (DEFINES, USES, PREREQUISITE, etc.).
- Only extract entities actually present. Do not invent.
- Keep names concise and consistent.
- Empty passage => {"entities":[],"relations":[]}.

Passages:
${passages}`;

            let results = batch.map(() => ({ entities: [], relations: [] }));
            const r = await extractEntitiesBatch(prompt, extractionModel);
            if (Array.isArray(r) && r.length === batch.length) {
                results = r;
            } else if (r && !Array.isArray(r)) {
                results = [r];
            }

            for (let j = 0; j < batch.length; j++) {
                const { gc } = batch[j];
                const data = results[j] || { entities: [], relations: [] };
                const entities = Array.isArray(data.entities) ? data.entities : [];
                const relations = Array.isArray(data.relations) ? data.relations : [];
                for (const e of entities) {
                    if (!e?.name || !e?.type) continue;
                    allEntities.push(e);
                    chunkEntityLinks.push({ chunkId: gc.id, name: e.name, type: e.type });
                    totalEntities++;
                }
                for (const rel of relations) {
                    if (!rel?.from || !rel?.to || !rel?.type) continue;
                    const fromType = rel.fromType || entities.find(e => e.name === rel.from)?.type || 'Entity';
                    const toType = rel.toType || entities.find(e => e.name === rel.to)?.type || 'Entity';
                    allEntities.push({ name: rel.from, type: fromType, description: '' });
                    allEntities.push({ name: rel.to, type: toType, description: '' });
                    allRelations.push({ from: rel.from, fromType, to: rel.to, toType, type: rel.type, evidence: rel.evidence || '' });
                    totalRels++;
                }
            }
            doneCount += batch.length;
            const pct = Math.round((doneCount / candidates.length) * 100);
            report('graph', Math.min(95, pct));
            console.log(`  Graph: processed ${Math.min(doneCount, candidates.length)}/${candidates.length} chunks (${totalEntities} entities, ${totalRels} relations)`);
        }
    }
    await Promise.all(Array.from({ length: CONC }, () => worker()));

    console.log('  Writing entities and relations to Neo4j...');
    await graph.batchUpsertEntities(indexName, allEntities);
    await graph.batchLinkChunkEntities(indexName, chunkEntityLinks);
    await graph.batchUpsertRelations(indexName, allRelations, documentId);

    console.log(`Graph built: ${totalEntities} entity mentions, ${totalRels} relations (skipped ${graphChunks.length - candidates.length} short chunks).`);
    report('graph', 100);
    report('done', 100);
    return { entities: totalEntities, relations: totalRels };
}