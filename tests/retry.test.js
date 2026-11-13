import test from 'node:test';
import assert from 'node:assert/strict';
import {
    withRetry,
    isRetryableError,
    errorMessage,
    validateRetryOptions,
} from '../src/retry.js';

const failure = (message, extra = {}) => Object.assign(new Error(message), extra);

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

test('isRetryableError retries transient failures', () => {
    const transient = [
        failure('429 Too Many Requests'),
        failure('Rate limit exceeded'),
        failure('Request timed out'),
        failure('fetch failed', { code: 'ECONNRESET' }),
        failure('socket hang up'),
        failure('Internal Server Error'),
        failure('Service Unavailable'),
        failure('boom', { status: 503 }),
        failure('boom', { response: { status: 500 } }),
        failure('You have exceeded the max configured retries (3).'),
    ];

    for (const err of transient) {
        assert.equal(isRetryableError(err), true, err.message);
    }
});

test('isRetryableError fails fast on permanent and unknown errors', () => {
    const permanent = [
        failure('401 Unauthorized'),
        failure('Invalid API key'),
        failure('403 Forbidden'),
        failure('400 Bad Request: validation failed'),
        failure('Vector dimension 768 does not match index dimension 3072'),
        failure('boom', { status: 400 }),
        failure('something totally unexpected'),
    ];

    for (const err of permanent) {
        assert.equal(isRetryableError(err), false, err.message);
    }
});

test('isRetryableError honors an explicit retry opt-out', () => {
    assert.equal(
        isRetryableError(failure('429 Too Many Requests', { retryable: false })),
        false
    );
});

test('validateRetryOptions rejects unsafe values', () => {
    assert.throws(() => validateRetryOptions({ maxAttempts: 0 }), /maxAttempts/);
    assert.throws(() => validateRetryOptions({ baseDelayMs: -1 }), /baseDelayMs/);
    assert.doesNotThrow(() => validateRetryOptions({ maxAttempts: 1, baseDelayMs: 0 }));
});

test('withRetry succeeds after a transient failure', async (t) => {
    silenceConsole(t);
    let calls = 0;
    const result = await withRetry(
        async () => {
            calls++;
            if (calls === 1) throw failure('429 Too Many Requests');
            return 'ok';
        },
        { label: 'test', baseDelayMs: 1, jitterRatio: 0 }
    );

    assert.deepEqual(result, { ok: true, attempts: 2, value: 'ok' });
    assert.equal(calls, 2);
});

test('withRetry gives up after maxAttempts', async (t) => {
    silenceConsole(t);
    let calls = 0;
    const result = await withRetry(
        async () => {
            calls++;
            throw failure('503 Service Unavailable');
        },
        { label: 'test', maxAttempts: 3, baseDelayMs: 1, jitterRatio: 0 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    assert.match(result.message, /503/);
    assert.ok(result.error instanceof Error, 'failure result keeps the original error');
    assert.equal(calls, 3);
});

test('withRetry does not retry permanent errors', async (t) => {
    silenceConsole(t);
    let calls = 0;
    const result = await withRetry(
        async () => {
            calls++;
            throw failure('401 Unauthorized');
        },
        { label: 'test', maxAttempts: 3, baseDelayMs: 1, jitterRatio: 0 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
});

test('withRetry honors Retry-After headers', async (t) => {
    silenceConsole(t);
    let calls = 0;
    const startedAt = Date.now();
    const result = await withRetry(
        async () => {
            calls++;
            if (calls === 1) {
                throw failure('429 Too Many Requests', {
                    headers: { get: () => '0.02' },
                });
            }
            return 'ok';
        },
        { label: 'test', baseDelayMs: 500, jitterRatio: 0 }
    );

    assert.equal(result.ok, true);
    assert.ok(Date.now() - startedAt < 200, 'server delay should override the long local backoff');
});

test('withRetry validates its options', async () => {
    await assert.rejects(
        () => withRetry(async () => 'ok', { maxAttempts: 0 }),
        /maxAttempts must be a positive integer/
    );
    await assert.rejects(
        () => withRetry(async () => 'ok', { baseDelayMs: -1 }),
        /baseDelayMs must be a non-negative number/
    );
});

test('errorMessage handles non-Error values', () => {
    assert.equal(errorMessage('plain string'), 'plain string');
    assert.equal(errorMessage(new Error('boom')), 'boom');
});
