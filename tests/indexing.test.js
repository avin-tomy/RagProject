import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    buildChunks,
    partitionIntoBatches,
    embedBatches,
    upsertBatches,
    verifyIndexedCount,
    ensurePineconeIndex,
    parseIndexArgs,
    resolvePdfPath,
    chunkStats,
    clearIndexVectors,
    INDEX_BATCH_SIZE,
} from '../src/indexing.js';
import { EMBEDDING_DIMENSION, INDEX_METRIC } from '../src/config.js';

function silenceConsole(t) {
    const originals = {};
    for (const method of ['log', 'warn', 'error']) {
        originals[method] = console[method];
        console[method] = () => {};
    }
    t.after(() => {
        for (const method of ['log', 'warn', 'error']) {
            console[method] = originals[method];
        }
    });
}

function withEnv(overrides, fn) {
    const saved = {};
    for (const [name, value] of Object.entries(overrides)) {
        saved[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    try {
        return fn();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

function makeDocs(count) {
    return Array.from({ length: count }, (_, index) => ({
        pageContent: `doc ${index}`,
        metadata: { page: index + 1 },
    }));
}

function makeIds(docs) {
    return docs.map((_, index) => `id-${index}`);
}

function notFoundError() {
    return Object.assign(new Error('404 Not Found'), { name: 'PineconeNotFoundError' });
}

test('buildChunks skips table-of-contents and empty pages', async () => {
    const rawPages = [
        { page: 1, text: 'Version 1.0\n1\nA short title page' },
        { page: 2, text: 'Chapter 1 ....... 1\nChapter 2 ....... 2\nChapter 3 ....... 3' },
        { page: 3, text: 'Real content. '.repeat(20) },
        { page: 4, text: '   ' },
    ];

    const { docs, tocPagesSkipped } = await buildChunks(rawPages, {
        metadata: { source: 'Node.pdf' },
    });

    assert.equal(tocPagesSkipped, 1);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].metadata.page, 1);
    assert.equal(docs[0].metadata.source, 'Node.pdf');
    assert.equal(docs[1].metadata.page, 3);
});

test('partitionIntoBatches splits documents and ids consistently', () => {
    const docs = makeDocs(5);
    const ids = makeIds(docs);
    const batches = partitionIntoBatches(docs, ids, 2);

    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map((batch) => batch.docs.length), [2, 2, 1]);
    assert.deepEqual(batches.map((batch) => batch.start), [0, 2, 4]);
    assert.deepEqual(batches.map((batch) => batch.end), [1, 3, 4]);
    assert.deepEqual(batches.map((batch) => batch.number), [1, 2, 3]);
    assert.deepEqual(batches[2].ids, ['id-4']);
});

test('partitionIntoBatches validates its arguments', () => {
    assert.throws(() => partitionIntoBatches([], [], 0), /batchSize must be a positive integer/);
    assert.throws(() => partitionIntoBatches(makeDocs(2), ['id-0'], 1), /same length/);
});

test('parseIndexArgs handles the default, dry-run, and help modes', () => {
    assert.deepEqual(parseIndexArgs([]), { pdfPath: null, dryRun: false, help: false });
    assert.deepEqual(parseIndexArgs(['Node.pdf', '--dry-run']), {
        pdfPath: 'Node.pdf',
        dryRun: true,
        help: false,
    });
    assert.deepEqual(parseIndexArgs(['--help']), { pdfPath: null, dryRun: false, help: true });
});

test('parseIndexArgs rejects unknown options and multiple paths', () => {
    assert.throws(() => parseIndexArgs(['--nope']), /Unknown option "--nope"/);
    assert.throws(() => parseIndexArgs(['a.pdf', 'b.pdf']), /Only one PDF path/);
});

test('resolvePdfPath requires a path and resolves it', () => {
    assert.throws(() => resolvePdfPath(), /A PDF path is required/);
    assert.equal(resolvePdfPath('docs/other.pdf'), path.resolve('docs/other.pdf'));
});

test('chunkStats summarizes chunk lengths and page spans', () => {
    const docs = [
        { pageContent: 'a'.repeat(10), metadata: { page: 1 } },
        { pageContent: 'b'.repeat(20), metadata: { page: 2, pageEnd: 3 } },
        { pageContent: 'c'.repeat(1601), metadata: { page: 4 } },
    ];

    assert.deepEqual(chunkStats(docs), {
        count: 3,
        min: 10,
        max: 1601,
        avg: 544,
        overSize: 1,
        spanningPages: 1,
    });
});

test('chunkStats handles an empty document list', () => {
    assert.deepEqual(chunkStats([]), {
        count: 0,
        min: 0,
        max: 0,
        avg: 0,
        overSize: 0,
        spanningPages: 0,
    });
});

test('embedBatches embeds every batch and reports success', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(3);
    let calls = 0;
    const embeddingModel = {
        async embedDocuments(texts) {
            calls++;
            return texts.map((text) => [text.length]);
        },
    };

    const result = await embedBatches(docs, makeIds(docs), embeddingModel, 2, {
        maxAttempts: 1,
        baseDelayMs: 1,
    });

    assert.equal(calls, 2);
    assert.equal(result.total, 3);
    assert.equal(result.embedded, 3);
    assert.equal(result.batches, 2);
    assert.equal(result.prepared.length, 2);
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.prepared[0].vectors, [[5], [5]]);
});

test('embedBatches retries a transient embedding failure', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(1);
    let calls = 0;
    const embeddingModel = {
        async embedDocuments() {
            calls++;
            if (calls === 1) throw new Error('429 Too Many Requests');
            return [[1, 2, 3]];
        },
    };

    const result = await embedBatches(docs, makeIds(docs), embeddingModel, 1, {
        maxAttempts: 2,
        baseDelayMs: 1,
    });

    assert.equal(calls, 2);
    assert.equal(result.embedded, 1);
    assert.equal(result.failures.length, 0);
});

test('embedBatches reports a permanent embedding failure without writing', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(1);
    let calls = 0;
    const embeddingModel = {
        async embedDocuments() {
            calls++;
            throw Object.assign(new Error('Invalid API key'), { status: 401 });
        },
    };

    const result = await embedBatches(docs, makeIds(docs), embeddingModel, 1, {
        maxAttempts: 3,
        baseDelayMs: 1,
    });

    assert.equal(calls, 1, 'permanent errors should not be retried');
    assert.equal(result.embedded, 0);
    assert.equal(result.prepared.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /Invalid API key/);
});

test('embedBatches rejects a partial embedding response', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(2);
    const embeddingModel = {
        async embedDocuments() {
            return [[1, 2, 3]];
        },
    };

    const result = await embedBatches(docs, makeIds(docs), embeddingModel, 2, {
        maxAttempts: 1,
        baseDelayMs: 1,
    });

    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /Expected 2 embeddings, got 1/);
});

test('upsertBatches writes every prepared batch', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(3);
    const ids = makeIds(docs);
    const prepared = partitionIntoBatches(docs, ids, 2).map((batch) => ({
        ...batch,
        vectors: batch.docs.map(() => [1, 2, 3]),
    }));

    const writes = [];
    const vectorStore = {
        async addVectors(vectors, batchDocs, { ids: batchIds }) {
            writes.push({ vectors, docs: batchDocs, ids: batchIds });
        },
    };

    const result = await upsertBatches(prepared, vectorStore, { maxAttempts: 1, baseDelayMs: 1 });

    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].ids, ['id-0', 'id-1']);
    assert.deepEqual(writes[1].ids, ['id-2']);
    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 3);
    assert.equal(result.failures.length, 0);
});

test('upsertBatches retries a transient write failure', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(1);
    const prepared = partitionIntoBatches(docs, makeIds(docs), 1).map((batch) => ({
        ...batch,
        vectors: [[1]],
    }));

    let calls = 0;
    const vectorStore = {
        async addVectors() {
            calls++;
            if (calls === 1) throw new Error('503 Service Unavailable');
        },
    };

    const result = await upsertBatches(prepared, vectorStore, { maxAttempts: 2, baseDelayMs: 1 });

    assert.equal(calls, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failures.length, 0);
});

test('upsertBatches reports a failed batch and keeps the rest', async (t) => {
    silenceConsole(t);
    const docs = makeDocs(2);
    const prepared = partitionIntoBatches(docs, makeIds(docs), 1).map((batch) => ({
        ...batch,
        vectors: [[1]],
    }));

    let calls = 0;
    const vectorStore = {
        async addVectors() {
            calls++;
            if (calls === 1) throw Object.assign(new Error('Invalid API key'), { status: 401 });
        },
    };

    const result = await upsertBatches(prepared, vectorStore, { maxAttempts: 3, baseDelayMs: 1 });

    assert.equal(calls, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failures.length, 1);
});

test('verifyIndexedCount waits for eventual consistency', async (t) => {
    silenceConsole(t);
    let calls = 0;
    const pineconeIndex = {
        async describeIndexStats() {
            calls++;
            return { totalRecordCount: calls === 1 ? 0 : 3 };
        },
    };

    const result = await verifyIndexedCount(pineconeIndex, 3, { attempts: 5, delayMs: 1 });

    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    assert.equal(result.attempts, 2);
});

test('verifyIndexedCount fails when the count never matches', async (t) => {
    silenceConsole(t);
    const pineconeIndex = {
        async describeIndexStats() {
            return { totalRecordCount: 2 };
        },
    };

    const result = await verifyIndexedCount(pineconeIndex, 3, { attempts: 3, delayMs: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.count, 2);
    assert.match(result.message, /Index contains 2 vectors, expected 3/);
});

test('verifyIndexedCount reports stats errors', async (t) => {
    silenceConsole(t);
    const pineconeIndex = {
        async describeIndexStats() {
            throw new Error('Service Unavailable');
        },
    };

    const result = await verifyIndexedCount(pineconeIndex, 3, { attempts: 2, delayMs: 1 });

    assert.equal(result.ok, false);
    assert.match(result.message, /Service Unavailable/);
});

test('clearIndexVectors skips deletion when the index is already empty', async (t) => {
    silenceConsole(t);
    let deleteCalls = 0;
    const pineconeIndex = {
        async deleteAll() {
            deleteCalls++;
            throw notFoundError();
        },
    };

    const result = await clearIndexVectors(pineconeIndex, 0);

    assert.deepEqual(result, { ok: true, cleared: false, reason: 'already-empty' });
    assert.equal(deleteCalls, 0);
});

test('clearIndexVectors deletes existing vectors', async (t) => {
    silenceConsole(t);
    let deleteCalls = 0;
    const pineconeIndex = {
        async deleteAll() {
            deleteCalls++;
        },
    };

    const result = await clearIndexVectors(pineconeIndex, 5);

    assert.deepEqual(result, { ok: true, cleared: true });
    assert.equal(deleteCalls, 1);
});

test('clearIndexVectors treats a missing namespace as empty', async (t) => {
    silenceConsole(t);
    const pineconeIndex = {
        async deleteAll() {
            throw notFoundError();
        },
    };

    const result = await clearIndexVectors(pineconeIndex, null);

    assert.deepEqual(result, { ok: true, cleared: false, reason: 'missing-namespace' });
});

test('clearIndexVectors reports non-404 deletion failures', async (t) => {
    silenceConsole(t);
    const pineconeIndex = {
        async deleteAll() {
            throw Object.assign(new Error('Forbidden'), { status: 403 });
        },
    };

    const result = await clearIndexVectors(pineconeIndex, 5);

    assert.equal(result.ok, false);
    assert.match(result.message, /Forbidden/);
});

test('ensurePineconeIndex creates a compatible index when missing', async (t) => {
    silenceConsole(t);
    await withEnv({ PINECONE_CLOUD: '', PINECONE_REGION: '' }, async () => {
        let describeCalls = 0;
        let createArgs = null;
        const pinecone = {
            async describeIndex() {
                describeCalls++;
                if (describeCalls === 1) throw notFoundError();
                return { dimension: EMBEDDING_DIMENSION, metric: INDEX_METRIC };
            },
            async createIndex(args) {
                createArgs = args;
            },
        };

        const result = await ensurePineconeIndex(pinecone, 'node-pdf-rag');

        assert.equal(result.dimension, EMBEDDING_DIMENSION);
        assert.equal(createArgs.name, 'node-pdf-rag');
        assert.equal(createArgs.dimension, EMBEDDING_DIMENSION);
        assert.equal(createArgs.metric, INDEX_METRIC);
        assert.deepEqual(createArgs.spec, { serverless: { cloud: 'aws', region: 'us-east-1' } });
        assert.equal(createArgs.waitUntilReady, true);
    });
});

test('ensurePineconeIndex reuses an existing compatible index', async (t) => {
    silenceConsole(t);
    let createCalls = 0;
    const pinecone = {
        async describeIndex() {
            return { dimension: EMBEDDING_DIMENSION, metric: INDEX_METRIC };
        },
        async createIndex() {
            createCalls++;
        },
    };

    const result = await ensurePineconeIndex(pinecone, 'node-pdf-rag');

    assert.equal(result.dimension, EMBEDDING_DIMENSION);
    assert.equal(createCalls, 0);
});

test('ensurePineconeIndex recreates an incompatible existing index', async (t) => {
    silenceConsole(t);
    await withEnv({ PINECONE_CLOUD: '', PINECONE_REGION: '' }, async () => {
        let describeCalls = 0;
        let createArgs = null;
        let deleteCalls = 0;
        let deleted = false;
        let created = false;
        const pinecone = {
            async describeIndex() {
                if (deleted && !created) {
                    throw Object.assign(new Error('404 Not Found'), { name: 'PineconeNotFoundError' });
                }
                describeCalls++;
                if (describeCalls === 1) return { dimension: 768, metric: INDEX_METRIC };
                return { dimension: EMBEDDING_DIMENSION, metric: INDEX_METRIC };
            },
            async deleteIndex() { deleteCalls++; deleted = true; },
            async createIndex(args) { createArgs = args; created = true; },
        };

        const result = await ensurePineconeIndex(pinecone, 'node-pdf-rag');

        assert.equal(result.dimension, EMBEDDING_DIMENSION);
        assert.equal(deleteCalls, 1);
        assert.equal(createArgs.name, 'node-pdf-rag');
    });
});

test('ensurePineconeIndex propagates non-404 lookup errors', async (t) => {
    silenceConsole(t);
    const pinecone = {
        async describeIndex() {
            throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
        },
    };

    await assert.rejects(
        () => ensurePineconeIndex(pinecone, 'node-pdf-rag'),
        /401 Unauthorized/
    );
});

test('the default batch size is 50', () => {
    assert.equal(INDEX_BATCH_SIZE, 50);
});

test('embedBatches and upsertBatches reject unsafe retry options', async (t) => {
    silenceConsole(t);
    const embeddingModel = { async embedDocuments() { return []; } };

    await assert.rejects(
        () => embedBatches([], [], embeddingModel, 50, { maxAttempts: 0 }),
        /maxAttempts must be a positive integer/
    );
    await assert.rejects(
        () => upsertBatches([], {}, { maxAttempts: 0 }),
        /maxAttempts must be a positive integer/
    );
});

test('verifyIndexedCount validates its polling options', async (t) => {
    silenceConsole(t);

    await assert.rejects(
        () => verifyIndexedCount({}, 0, { attempts: 0 }),
        /attempts must be a positive integer/
    );
    await assert.rejects(
        () => verifyIndexedCount({}, 0, { delayMs: -1 }),
        /delayMs must be a non-negative number/
    );
});
