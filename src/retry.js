// Shared retry helpers used by both indexing and querying.

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

// Client errors (bad key, bad request, wrong dimension) will never succeed on a
// retry, so they should fail fast instead of burning time and quota.
const PERMANENT_ERROR_PATTERNS = [
    /\b401\b/,
    /\b403\b/,
    /\b404\b/,
    /unauthorized/i,
    /forbidden/i,
    /api key/i,
    /invalid/i,
    /validation/i,
    /dimension/i,
];

// Transient problems are worth retrying: rate limits, timeouts, network blips
// and 5xx responses from Gemini or Pinecone.
const RETRYABLE_ERROR_PATTERNS = [
    /\b429\b/,
    /rate limit/i,
    /too many requests/i,
    /quota exceeded/i,
    /timeout/i,
    /timed out/i,
    /ETIMEDOUT/,
    /ECONNRESET/,
    /ECONNREFUSED/,
    /EAI_AGAIN/,
    /ENOTFOUND/,
    /socket hang up/i,
    /network/i,
    /fetch failed/i,
    /internal server error/i,
    /service unavailable/i,
    /bad gateway/i,
    /gateway timeout/i,
    /overloaded/i,
    /max configured retries/i,
    /\b5\d\d\b/,
];

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}

export function isRetryableError(err) {
    // Callers can opt out of retries (for example, after a stream already
    // produced partial output and retrying would duplicate it).
    if (err?.retryable === false) return false;

    const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.cause?.status;
    if (typeof status === 'number') {
        if (status === 429 || status >= 500) return true;
        if (status >= 400) return false;
    }

    const message = [err?.message, err?.code, err?.cause?.message, err?.cause?.code]
        .filter(Boolean)
        .join(' ');

    if (PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return false;
    return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function retryAfterMs(err) {
    const headers = err?.headers ?? err?.response?.headers ?? err?.cause?.headers ?? err?.cause?.response?.headers;
    const raw = typeof headers?.get === 'function'
        ? headers.get('retry-after')
        : headers?.['retry-after'];

    if (raw == null || raw === '') return 0;

    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/**
 * Validate retry options up front so an accidental zero cannot create an
 * infinite loop or an unbounded delay.
 */
export function validateRetryOptions({
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
} = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
        throw new Error('baseDelayMs must be a non-negative number');
    }
}

/**
 * Run an async operation with bounded retries for transient errors.
 * Returns { ok, attempts, value } on success or { ok, attempts, message } on failure.
 */
export async function withRetry(operation, {
    label = 'Operation',
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    jitterRatio = 0.2,
    logger = console,
} = {}) {
    validateRetryOptions({ maxAttempts, baseDelayMs });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return { ok: true, attempts: attempt, value: await operation() };
        } catch (err) {
            const message = errorMessage(err);

            if (!isRetryableError(err)) {
                logger.error(`  ${label}: failed on attempt ${attempt}/${maxAttempts} (not retryable) - ${message}`);
                return { ok: false, attempts: attempt, message, error: err };
            }

            if (attempt === maxAttempts) {
                logger.error(`  ${label}: failed after ${attempt} attempt(s) - ${message}`);
                return { ok: false, attempts: attempt, message, error: err };
            }

            const serverDelayMs = retryAfterMs(err);
            const backoffMs = baseDelayMs * 2 ** (attempt - 1);
            const jitterMs = jitterRatio > 0
                ? backoffMs * jitterRatio * (Math.random() * 2 - 1)
                : 0;
            const delayMs = Math.max(0, Math.round(serverDelayMs || backoffMs + jitterMs));

            logger.warn(`  ${label}: attempt ${attempt}/${maxAttempts} failed - ${message}`);
            logger.warn(`  ${label}: retrying in ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }
}
