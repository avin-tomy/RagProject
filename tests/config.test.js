import test from 'node:test';
import assert from 'node:assert/strict';
import {
    requireEnv,
    getIndexName,
    getScoreThreshold,
    getPineconeCloud,
    getPineconeRegion,
    assertIndexCompatible,
    isNotFoundError,
    createChatModel,
    createRewriteModel,
    DEFAULT_SCORE_THRESHOLD,
    EMBEDDING_DIMENSION,
    INDEX_METRIC,
    CHAT_MODEL,
} from '../src/config.js';

const MANAGED_ENV = [
    'GEMINI_API_KEY',
    'PINECONE_API_KEY',
    'PINECONE_INDEX_NAME',
    'SCORE_THRESHOLD',
    'PINECONE_CLOUD',
    'PINECONE_REGION',
];

function withEnv(overrides, fn) {
    const saved = {};
    for (const name of MANAGED_ENV) {
        saved[name] = process.env[name];
        if (Object.hasOwn(overrides, name)) {
            if (overrides[name] === undefined) delete process.env[name];
            else process.env[name] = overrides[name];
        } else {
            delete process.env[name];
        }
    }

    try {
        return fn();
    } finally {
        for (const name of MANAGED_ENV) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    }
}

test('models are declared in one place', () => {
    assert.equal(CHAT_MODEL, 'gemini-3.8-flash');
    assert.equal(EMBEDDING_DIMENSION, 3072);
    assert.equal(INDEX_METRIC, 'cosine');
});

test('answer and rewrite models share the chat model with different temperatures', () => {
    withEnv({ GEMINI_API_KEY: 'dummy-key' }, () => {
        const answerModel = createChatModel();
        const rewriteModel = createRewriteModel();

        assert.equal(answerModel.model, CHAT_MODEL);
        assert.equal(answerModel.temperature, 0.3);
        assert.equal(rewriteModel.model, CHAT_MODEL);
        assert.equal(rewriteModel.temperature, 0);
    });
});

test('requireEnv rejects missing, blank, and whitespace-only values', () => {
    withEnv({ GEMINI_API_KEY: undefined }, () => {
        assert.throws(() => requireEnv('GEMINI_API_KEY'), /GEMINI_API_KEY is not set in \.env/);
    });
    withEnv({ GEMINI_API_KEY: '' }, () => {
        assert.throws(() => requireEnv('GEMINI_API_KEY'), /GEMINI_API_KEY is not set in \.env/);
    });
    withEnv({ GEMINI_API_KEY: '   ' }, () => {
        assert.throws(() => requireEnv('GEMINI_API_KEY'), /GEMINI_API_KEY is not set in \.env/);
    });
});

test('requireEnv trims a valid value', () => {
    withEnv({ GEMINI_API_KEY: '  secret-key  ' }, () => {
        assert.equal(requireEnv('GEMINI_API_KEY'), 'secret-key');
    });
});

test('getIndexName accepts Pinecone-compatible names', () => {
    for (const name of ['a', 'node-pdf-rag', 'index-123', '123']) {
        withEnv({ PINECONE_INDEX_NAME: name }, () => {
            assert.equal(getIndexName(), name);
        });
    }
});

test('getIndexName rejects blank and invalid names', () => {
    const invalid = ['   ', 'My_Index', '-leading', 'trailing-', 'UPPER', 'has space', 'a'.repeat(46)];

    for (const name of invalid) {
        withEnv({ PINECONE_INDEX_NAME: name }, () => {
            assert.throws(() => getIndexName(), /PINECONE_INDEX_NAME/);
        });
    }
});

test('getScoreThreshold uses the default for blank values', () => {
    withEnv({ SCORE_THRESHOLD: undefined }, () => {
        assert.equal(getScoreThreshold(), DEFAULT_SCORE_THRESHOLD);
    });
    withEnv({ SCORE_THRESHOLD: '' }, () => {
        assert.equal(getScoreThreshold(), DEFAULT_SCORE_THRESHOLD);
    });
    withEnv({ SCORE_THRESHOLD: '   ' }, () => {
        assert.equal(getScoreThreshold(), DEFAULT_SCORE_THRESHOLD);
    });
});

test('getScoreThreshold parses valid numbers and rejects garbage', () => {
    for (const [raw, expected] of [['0.75', 0.75], ['-1', -1], ['1', 1], [' 0.5 ', 0.5]]) {
        withEnv({ SCORE_THRESHOLD: raw }, () => {
            assert.equal(getScoreThreshold(), expected);
        });
    }

    for (const raw of ['0.6abc', 'abc', '2', '-1.5', 'NaN']) {
        withEnv({ SCORE_THRESHOLD: raw }, () => {
            assert.throws(() => getScoreThreshold(), /SCORE_THRESHOLD must be a number between -1 and 1/);
        });
    }
});

test('Pinecone cloud and region fall back to defaults for blank values', () => {
    withEnv({ PINECONE_CLOUD: '', PINECONE_REGION: '   ' }, () => {
        assert.equal(getPineconeCloud(), 'aws');
        assert.equal(getPineconeRegion(), 'us-east-1');
    });
});

test('Pinecone cloud and region are trimmed when set', () => {
    withEnv({ PINECONE_CLOUD: ' gcp ', PINECONE_REGION: ' europe-west4 ' }, () => {
        assert.equal(getPineconeCloud(), 'gcp');
        assert.equal(getPineconeRegion(), 'europe-west4');
    });
});

test('assertIndexCompatible accepts a matching index', () => {
    assert.doesNotThrow(() =>
        assertIndexCompatible({ dimension: EMBEDDING_DIMENSION, metric: INDEX_METRIC }, 'node-pdf-rag')
    );
});

test('assertIndexCompatible rejects a dimension mismatch', () => {
    assert.throws(
        () => assertIndexCompatible({ dimension: 768, metric: INDEX_METRIC }, 'node-pdf-rag'),
        /dimension 768/
    );
});

test('assertIndexCompatible rejects a metric mismatch', () => {
    assert.throws(
        () => assertIndexCompatible({ dimension: EMBEDDING_DIMENSION, metric: 'dotproduct' }, 'node-pdf-rag'),
        /metric "dotproduct"/
    );
});

test('isNotFoundError recognizes Pinecone not-found errors', () => {
    assert.equal(isNotFoundError(Object.assign(new Error('missing'), { name: 'PineconeNotFoundError' })), true);
    assert.equal(isNotFoundError(new Error('404 Not Found')), true);
    assert.equal(isNotFoundError(new Error('401 Unauthorized')), false);
    assert.equal(isNotFoundError('plain string'), false);
});
