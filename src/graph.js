import neo4j from 'neo4j-driver';

let driver = null;

export function initGraph(uri, username, password) {
    if (!uri) return null;
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
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

export async function upsertDocument(indexName, name, pageCount) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MERGE (d:Document {indexName: $indexName, name: $name})
             SET d.pageCount = $pageCount, d.updatedAt = datetime()`,
            { indexName, name, pageCount }
        );
    } finally {
        await session.close();
    }
}

export async function upsertChunk(indexName, docName, chunk) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MERGE (c:Chunk {indexName: $indexName, id: $id})
             SET c.text = $text, c.page = $page, c.pageEnd = $pageEnd, c.index = $idx
             WITH c
             MATCH (d:Document {indexName: $indexName, name: $docName})
             MERGE (c)-[:PART_OF]->(d)`,
            {
                indexName,
                id: chunk.id,
                text: chunk.text,
                page: chunk.page,
                pageEnd: chunk.pageEnd ?? null,
                idx: chunk.index,
                docName,
            }
        );
    } finally {
        await session.close();
    }
}

export async function upsertEntity(indexName, entity) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MERGE (e:Entity {indexName: $indexName, name: $name, type: $type})
             SET e.description = $description`,
            { indexName, name: entity.name, type: entity.type, description: entity.description || '' }
        );
    } finally {
        await session.close();
    }
}

export async function linkChunkEntity(indexName, chunkId, entityName, entityType) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MATCH (c:Chunk {indexName: $indexName, id: $chunkId})
             MATCH (e:Entity {indexName: $indexName, name: $entityName, type: $entityType})
             MERGE (c)-[:MENTIONS]->(e)`,
            { indexName, chunkId, entityName, entityType }
        );
    } finally {
        await session.close();
    }
}

export async function upsertRelation(indexName, rel) {
    if (!driver) return;
    const session = driver.session();
    try {
        await session.run(
            `MATCH (a:Entity {indexName: $indexName, name: $from, type: $fromType})
             MATCH (b:Entity {indexName: $indexName, name: $to, type: $toType})
             MERGE (a)-[r:RELATES_TO {type: $relType}]->(b)
             SET r.evidence = $evidence`,
            {
                indexName,
                from: rel.from,
                fromType: rel.fromType,
                to: rel.to,
                toType: rel.toType,
                relType: rel.type,
                evidence: rel.evidence || '',
            }
        );
    } finally {
        await session.close();
    }
}

export async function queryGraph(indexName, cypher, params = {}) {
    if (!driver) return { records: [], summary: 'Graph not configured' };
    const session = driver.session();
    try {
        const result = await session.run(cypher, { indexName, ...params });
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

export async function getGraphStats(indexName) {
    if (!driver) return null;
    const session = driver.session();
    try {
        const r = await session.run(
            `MATCH (n {indexName: $indexName}) RETURN labels(n)[0] AS label, count(n) AS c`,
            { indexName }
        );
        const stats = {};
        r.records.forEach((rec) => { stats[rec.get('label')] = rec.get('c').toNumber(); });
        return stats;
    } finally {
        await session.close();
    }
}