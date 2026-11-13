import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResetArgs, resetIndex } from '../src/reset.js';
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

function createFakePinecone({
    count = 5,
    dimension = EMBEDDING_DIMENSION,
    metric = INDEX_METRIC,
    missing = false,
} = {}) {
    let current = count;
    let deleteCalls = 0;

    return {
        get count() {
            return current;
        },
        get deleteCalls() {
            return deleteCalls;
        },
        async describeIndex() {
            if (missing) {
                throw Object.assign(new Error('404 Not Found'), {
                    name: 'PineconeNotFoundError',
                });
            }
            return { dimension, metric };
        },
        Index() {
            return {
                async describeIndexStats() {
                    return { totalRecordCount: current };
                },
                async deleteAll() {
                    deleteCalls++;
                    current = 0;
                },
            };
        },
    };
}

test('parseResetArgs parses confirmation and help flags', () => {
    assert.deepEqual(parseResetArgs([]), { yes: false, help: false });
    assert.deepEqual(parseResetArgs(['--yes']), { yes: true, help: false });
    assert.deepEqual(parseResetArgs(['-y']), { yes: true, help: false });
    assert.deepEqual(parseResetArgs(['--help']), { yes: false, help: true });
});

test('parseResetArgs rejects unknown options', () => {
    assert.throws(() => parseResetArgs(['--force']), /Unknown option "--force"/);
});

test('resetIndex reports an already-empty index without confirmation', async (t) => {
    silenceConsole(t);
    const pinecone = createFakePinecone({ count: 0 });

    const result = await resetIndex({ yes: false, pinecone, indexName: 'node-pdf-rag' });

    assert.deepEqual(result, { reset: false, count: 0 });
    assert.equal(pinecone.deleteCalls, 0);
});
test('resetIndex previews the deletion without confirming', async (t) => {
    silenceConsole(t);
    const pinecone = createFakePinecone({ count: 12 });

    const result = await resetIndex({ yes: false, pinecone, indexName: 'node-pdf-rag' });

    assert.deepEqual(result, { reset: false, count: 12 });
    assert.equal(pinecone.deleteCalls, 0);
    assert.equal(pinecone.count, 12);
});

test('resetIndex deletes and verifies when confirmed', async (t) => {
    silenceConsole(t);
    const pinecone = createFakePinecone({ count: 12 });

    const result = await resetIndex({ yes: true, pinecone, indexName: 'node-pdf-rag' });

    assert.deepEqual(result, { reset: true, count: 0 });
    assert.equal(pinecone.deleteCalls, 1);
    assert.equal(pinecone.count, 0);
});

test('resetIndex rejects a missing index', async (t) => {
    silenceConsole(t);
    const pinecone = createFakePinecone({ missing: true });

    await assert.rejects(
        () => resetIndex({ yes: true, pinecone, indexName: 'node-pdf-rag' }),
        /does not exist/
    );
});

test('resetIndex rejects an incompatible index', async (t) => {
    silenceConsole(t);
    const pinecone = createFakePinecone({ dimension: 768 });

    await assert.rejects(
        () => resetIndex({ yes: true, pinecone, indexName: 'node-pdf-rag' }),
        /dimension 768/
    );
});
