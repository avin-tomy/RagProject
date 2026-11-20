import neo4j from 'neo4j-driver';

let driver = null;

export async function initGraph(uri, username, password) {
    if (!uri) return null;
    const d = neo4j.driver(uri, neo4j.auth.basic(username, password));
    try {
        await d.verifyConnectivity();
    } catch (err) {
        console.warn('Neo4j connectivity check failed:', err.message);
        try { await d.close(); } catch { /* ignore */ }
        driver = null;
        return null;
    }
    driver = d;
    return driver;
}

export function getDriver() {
    return driver;
}

export async function closeGraph() {
    if (driver) await driver.close();
    driver = null;
}

export async function ensureGraphSchema(session) {
    const constraints = [
        'CREATE CONSTRAINT document_unique IF NOT EXISTS FOR (d:Document) REQUIRE (d.indexName, d.name) IS UNIQUE',
        'CREATE CONSTRAINT chunk_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE (c.indexName, c.id) IS UNIQUE',
        'CREATE CONSTRAINT entity_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.indexName, e.name, e.type) IS UNIQUE',
    ];
    for (const c of constraints) {
        try { await session.run(c); } catch (e) { /* ignore already exists */ }
    }
    const indexes = [
        'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type)',
        'CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)',
    ];
    for (const i of indexes) {
        try { await session.run(i); } catch (e) { /* ignore */ }
    }
}

export async function clearGraph(indexName) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run('MATCH (n {indexName: $indexName}) DETACH DELETE n', { indexName });
    } finally {
        await session.close();
    }
}

export async function upsertDocument(indexName, name, pageCount, documentId) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MERGE (d:Document {indexName: $indexName, name: $name})
             SET d.pageCount = $pageCount, d.documentId = $documentId, d.updatedAt = datetime()`,
            { indexName, name, pageCount, documentId: documentId || '' }
        );
    } finally {
        await session.close();
    }
}

export async function batchUpsertChunks(indexName, docName, chunks) {
    if (!driver || !chunks.length) return;
    const session = driver.session();
    try {
        await session.run(
            `UNWIND $rows AS row
             MERGE (c:Chunk {indexName: $indexName, id: row.id})
             SET c.text = row.text, c.page = row.page, c.pageEnd = row.pageEnd, c.index = row.idx, c.documentId = row.documentId
             WITH c, row
             MATCH (d:Document {indexName: $indexName, name: $docName})
             MERGE (c)-[:PART_OF]->(d)`,
            {
                indexName,
                docName,
                rows: chunks.map((gc, i) => ({
                    id: gc.id,
                    text: gc.text,
                    page: gc.page,
                    pageEnd: gc.pageEnd ?? null,
                    idx: gc.index,
                    documentId: gc.documentId || '',
                })),
            }
        );
    } finally {
        await session.close();
    }
}

export async function clearGraphDocument(indexName, documentId) {
    if (!driver) return;
    const session = driver.session();
    try {
        // Delete RELATES_TO edges scoped to this document
        await session.run(
            `MATCH ()-[r:RELATES_TO {documentId: $documentId}]-() DELETE r`,
            { documentId }
        );
        // Delete chunks (and their MENTIONS edges via DETACH)
        await session.run(
            `MATCH (c:Chunk {indexName: $indexName, documentId: $documentId}) DETACH DELETE c`,
            { indexName, documentId }
        );
        // Delete document node if no remaining chunks reference it
        await session.run(
            `MATCH (d:Document {indexName: $indexName, documentId: $documentId})
             WHERE NOT EXISTS { MATCH (c:Chunk {indexName: $indexName, documentId: $documentId}) }
             DELETE d`,
            { indexName, documentId }
        );
        // Remove entities that are no longer mentioned by any remaining chunk.
        await session.run(
            `MATCH (e:Entity {indexName: $indexName})
             WHERE NOT EXISTS { MATCH (:Chunk {indexName: $indexName})-[:MENTIONS]->(e) }
             DETACH DELETE e`,
            { indexName }
        );
    } finally {
        await session.close();
    }
}

export async function queryGraph(indexName, cypher, params = {}) {
    if (!driver) return { records: [], summary: 'Graph not configured' };
    const session = driver.session();
    try {
        const result = await session.run(cypher, { ...params, indexName });
        const records = result.records.map((r) => {
            const obj = {};
            r.keys.forEach((k) => {
                const v = r.get(k);
                obj[k] = neo4j.isInt(v) ? v.toNumber() : (v && v.properties ? v.properties : v);
            });
            return obj;
        });
        return { records, count: records.length };
    } finally {
        await session.close();
    }
}

export async function listDocuments(indexName) {
    if (!driver) return [];
    const session = driver.session();
    try {
        const r = await session.run(
            `MATCH (d:Document {indexName: $indexName})
             RETURN d.name AS name, d.documentId AS documentId, d.pageCount AS pageCount`,
            { indexName }
        );
        return r.records.map((rec) => ({
            name: rec.get('name'),
            documentId: rec.get('documentId'),
            pageCount: neo4j.isInt(rec.get('pageCount')) ? rec.get('pageCount').toNumber() : rec.get('pageCount'),
        }));
    } finally {
        await session.close();
    }
}

export async function findSharedEntities(indexName) {
    if (!driver) return [];
    const session = driver.session();
    try {
        const r = await session.run(
            `MATCH (c:Chunk {indexName: $indexName})-[:MENTIONS]->(e:Entity)
             WITH e, collect(DISTINCT c.documentId) AS docs
             WHERE size(docs) > 1
             RETURN e.name AS name, e.type AS type, docs
             ORDER BY size(docs) DESC
             LIMIT 40`,
            { indexName }
        );
        return r.records.map((rec) => ({
            name: rec.get('name'),
            type: rec.get('type'),
            docCount: rec.get('docs').length,
            docs: rec.get('docs'),
        }));
    } finally {
        await session.close();
    }
}
export async function getGraphStats(indexName) {
    if (!driver) return null;
    const session = driver.session();
    try {
        const r = await session.run(
            `MATCH (n {indexName: $indexName}) RETURN labels(n)[0] AS label, count(n) AS c`,
            { indexName }
        );
        const stats = {};
        r.records.forEach((rec) => {
            const c = rec.get('c');
            stats[rec.get('label')] = neo4j.isInt(c) ? c.toNumber() : Number(c);
        });
        return stats;
    } finally {
        await session.close();
    }
}
// ---------- Batch helpers for faster graph building ----------

export async function batchUpsertEntities(indexName, entities) {
    if (!driver || !entities.length) return;
    const seen = new Set();
    const unique = [];
    for (const e of entities) {
        if (!e?.name || !e?.type) continue;
        const key = `${e.name}||${e.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ name: e.name, type: e.type, description: e.description || '' });
    }
    if (!unique.length) return;
    const session = driver.session();
    try {
        await session.run(
            `UNWIND $rows AS row
             MERGE (e:Entity {indexName: $indexName, name: row.name, type: row.type})
             SET e.description = COALESCE(NULLIF(row.description, ''), e.description)`,
            { indexName, rows: unique }
        );
    } finally {
        await session.close();
    }
}

export async function batchLinkChunkEntities(indexName, links) {
    if (!driver || !links.length) return;
    const seen = new Set();
    const unique = [];
    for (const l of links) {
        if (!l?.chunkId || !l?.name || !l?.type) continue;
        const key = `${l.chunkId}||${l.name}||${l.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(l);
    }
    if (!unique.length) return;
    const session = driver.session();
    try {
        await session.run(
            `UNWIND $rows AS row
             MATCH (c:Chunk {indexName: $indexName, id: row.chunkId})
             MATCH (e:Entity {indexName: $indexName, name: row.name, type: row.type})
             MERGE (c)-[:MENTIONS]->(e)`,
            { indexName, rows: unique }
        );
    } finally {
        await session.close();
    }
}

export async function batchUpsertRelations(indexName, relations, documentId) {
    if (!driver || !relations.length) return;
    const seen = new Set();
    const unique = [];
    for (const r of relations) {
        if (!r?.from || !r?.to || !r?.type) continue;
        const key = `${r.from}||${r.fromType}||${r.to}||${r.toType}||${r.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(r);
    }
    if (!unique.length) return;
    const session = driver.session();
    try {
        const endpoints = [];
        const epSeen = new Set();
        for (const r of unique) {
            for (const [name, type] of [[r.from, r.fromType], [r.to, r.toType]]) {
                const key = `${name}||${type}`;
                if (epSeen.has(key)) continue;
                epSeen.add(key);
                endpoints.push({ name, type, description: '' });
            }
        }
        await session.run(
            `UNWIND $rows AS row
             MERGE (e:Entity {indexName: $indexName, name: row.name, type: row.type})
             SET e.description = COALESCE(NULLIF(row.description, ''), e.description)`,
            { indexName, rows: endpoints }
        );
        await session.run(
            `UNWIND $rows AS row
             MATCH (a:Entity {indexName: $indexName, name: row.from, type: row.fromType})
             MATCH (b:Entity {indexName: $indexName, name: row.to, type: row.toType})
             MERGE (a)-[r:RELATES_TO {type: row.type, documentId: $documentId}]->(b)
             SET r.evidence = row.evidence`,
            { indexName, rows: unique, documentId: documentId || '' }
        );
    } finally {
        await session.close();
    }
}
