import path from 'node:path';
import { PineconeStore } from '@langchain/pinecone';
import {
    createEmbeddingModel,
    createPineconeClient,
    getIndexName,
    getPineconeCloud,
    getPineconeRegion,
    assertIndexCompatible,
    isNotFoundError,
    requireEnv,
    getProviderEnv,
    EMBEDDING_DIMENSION,
    INDEX_METRIC,
    createExtractionModel,
} from './config.js';
import { chunkPages, cleanPageText, isTableOfContents, CHUNK_SIZE } from './chunking.js';
import { loadPdfPages } from './pdfLoader.js';
import * as graph from './graph.js';
import { extractEntitiesBatch } from './entityExtractor.js';
import {
    withRetry,
    validateRetryOptions,
    errorMessage,
    sleep,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RETRY_BASE_DELAY_MS,
} from './retry.js';

const INDEX_USAGE = `Usage: node indexing.js [pdfPath] [options]

Index a PDF into Pinecone. Without a path, Pdf/Node.pdf in this directory is used.

Options:
  --dry-run   Load and chunk the PDF, print stats, and exit without API calls
  -h, --help  Show this help`;

// Smaller batches isolate failures and show progress on large documents.
export const INDEX_BATCH_SIZE = 50;

// Retry failed batches with exponential backoff before giving up.
export const BATCH_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
export const BATCH_RETRY_BASE_DELAY_MS = DEFAULT_RETRY_BASE_DELAY_MS;

// Pinecone index stats can take a few seconds to catch up after upserts.
const INDEX_VERIFY_ATTEMPTS = 15;
const INDEX_VERIFY_DELAY_MS = 1000;

export function parseIndexArgs(argv = process.argv.slice(2)) {
    let pdfPath = null;
    let dryRun = false;
    let help = false;

    for (const arg of argv) {
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            help = true;
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown option "${arg}"\n\n${INDEX_USAGE}`);
        }
        if (pdfPath) {
            throw new Error(`Only one PDF path can be provided\n\n${INDEX_USAGE}`);
        }
        pdfPath = arg;
    }

    return { pdfPath, dryRun, help };
}

export function resolvePdfPath(pdfPath) {
    if (!pdfPath) {
        throw new Error('A PDF path is required');
    }
    return path.resolve(pdfPath);
}

export function chunkStats(docs) {
    const lengths = docs.map((doc) => doc.pageContent.length);
    const total = lengths.reduce((sum, length) => sum + length, 0);

    return {
        count: docs.length,
        min: lengths.length ? Math.min(...lengths) : 0,
        max: lengths.length ? Math.max(...lengths) : 0,
        avg: lengths.length ? Math.round(total / lengths.length) : 0,
        overSize: lengths.filter((length) => length > CHUNK_SIZE).length,
        spanningPages: docs.filter((doc) => doc.metadata?.pageEnd != null).length,
    };
}

export async function ensurePineconeIndex(pinecone, indexName) {
    console.log('Checking Pinecone for an existing index...');

    let existingIndex;
    try {
        existingIndex = await pinecone.describeIndex(indexName);
    } catch (err) {
        if (!isNotFoundError(err)) throw err;
    }

    if (existingIndex) {
        // If the existing index is incompatible (e.g., embedding model changed),
        // delete it and recreate with the correct configuration.
        if (existingIndex.dimension !== EMBEDDING_DIMENSION || existingIndex.metric !== INDEX_METRIC) {
            console.log(
                `Index "${indexName}" is incompatible ` +
                `(dimension=${existingIndex.dimension}, metric=${existingIndex.metric}). ` +
                `Recreating it (dimension=${EMBEDDING_DIMENSION}, metric=${INDEX_METRIC})...`
            );
            await pinecone.deleteIndex(indexName);
            // Wait for deletion to propagate
            for (let i = 0; i < 30; i++) {
                try {
                    await pinecone.describeIndex(indexName);
                    await new Promise((r) => setTimeout(r, 2000));
                } catch (e) {
                    if (isNotFoundError(e)) break;
                    throw e;
                }
            }
            existingIndex = null;
        } else {
            console.log(`Index "${indexName}" found. Verifying its configuration...`);
            assertIndexCompatible(existingIndex, indexName);
            console.log(
                `Using existing index "${indexName}" ` +
                `(dimension=${existingIndex.dimension}, metric=${existingIndex.metric})`
            );
            return existingIndex;
        }
    }

    const cloud = getPineconeCloud();
    const region = getPineconeRegion();
    console.log(
        `Index "${indexName}" not found. Creating it ` +
        `(dimension=${EMBEDDING_DIMENSION}, metric=${INDEX_METRIC}, cloud=${cloud}, region=${region})...`
    );

    try {
        await pinecone.createIndex({
            name: indexName,
            dimension: EMBEDDING_DIMENSION,
            metric: INDEX_METRIC,
            spec: {
                serverless: { cloud, region },
            },
            waitUntilReady: true,
        });
    } catch (err) {
        if (err?.status === 409 || /ALREADY_EXISTS/i.test(err?.message || '')) {
            console.log('Index created by another request; reusing it.');
        } else {
            throw err;
        }
    }

    console.log(`Index "${indexName}" is ready`);
    const createdIndex = await pinecone.describeIndex(indexName);
    assertIndexCompatible(createdIndex, indexName);
    return createdIndex;
}

export function partitionIntoBatches(chunkedDocs, chunkIds, batchSize) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error('batchSize must be a positive integer');
    }
    if (chunkIds.length !== chunkedDocs.length) {
        throw new Error('chunkIds and chunkedDocs must have the same length');
    }

    const batches = [];
    for (let start = 0; start < chunkedDocs.length; start += batchSize) {
        const docs = chunkedDocs.slice(start, start + batchSize);
        batches.push({
            number: batches.length + 1,
            start,
            end: start + docs.length - 1,
            docs,
            ids: chunkIds.slice(start, start + batchSize),
        });
    }
    return batches;
}

function batchPageInfo(docs) {
    const pages = docs.flatMap((doc) => [doc.metadata?.page, doc.metadata?.pageEnd])
        .filter((page) => typeof page === 'number');
    return pages.length
        ? `pages ${Math.min(...pages)}-${Math.max(...pages)}`
        : 'pages unknown';
}

function describeBatch(batch, totalBatches) {
    return `Batch ${batch.number}/${totalBatches} ` +
        `(chunks ${batch.start}-${batch.end}, ${batchPageInfo(batch.docs)})`;
}

export async function buildChunks(rawPages, options = {}) {
    const pages = [];
    let tocPagesSkipped = 0;

    for (const { page, text } of rawPages) {
        const cleaned = cleanPageText(text);
        if (!cleaned) continue;

        if (isTableOfContents(cleaned)) {
            tocPagesSkipped++;
            continue;
        }

        pages.push({ page, text: cleaned });
    }

    const docs = await chunkPages(pages, options);
    return { docs, tocPagesSkipped };
}

export async function embedBatches(
    chunkedDocs,
    chunkIds,
    embeddingModel,
    batchSize = INDEX_BATCH_SIZE,
    options = {}
) {
    const {
        maxAttempts = BATCH_MAX_ATTEMPTS,
        baseDelayMs = BATCH_RETRY_BASE_DELAY_MS,
    } = options;

    validateRetryOptions({ maxAttempts, baseDelayMs });
    const batches = partitionIntoBatches(chunkedDocs, chunkIds, batchSize);
    console.log(
        `Embedding ${chunkedDocs.length} chunks in ${batches.length} batch(es) ` +
        `of up to ${batchSize}...`
    );

    const prepared = [];
    const failures = [];
    let embedded = 0;

    for (const batch of batches) {
        const label = describeBatch(batch, batches.length);
        console.log(`  ${label}: embedding...`);

        const result = await withRetry(
            () => embeddingModel.embedDocuments(batch.docs.map((doc) => doc.pageContent)),
            { label: `${label} embedding`, maxAttempts, baseDelayMs }
        );

        if (!result.ok) {
            failures.push({ label, message: result.message, attempts: result.attempts });
            continue;
        }

        if (!Array.isArray(result.value) || result.value.length !== batch.docs.length) {
            const message = `Expected ${batch.docs.length} embeddings, got ${result.value?.length ?? 0}`;
            console.error(`  ${label}: FAILED - ${message}`);
            failures.push({ label, message, attempts: result.attempts });
            continue;
        }

        prepared.push({ ...batch, vectors: result.value });
        embedded += batch.docs.length;
        console.log(`  ${label}: embedded`);
    }

    return { total: chunkedDocs.length, embedded, batches: batches.length, prepared, failures };
}

export async function upsertBatches(preparedBatches, vectorStore, options = {}) {
    const {
        maxAttempts = BATCH_MAX_ATTEMPTS,
        baseDelayMs = BATCH_RETRY_BASE_DELAY_MS,
    } = options;

    validateRetryOptions({ maxAttempts, baseDelayMs });

    const total = preparedBatches.reduce((sum, batch) => sum + batch.docs.length, 0);
    const failures = [];
    let succeeded = 0;

    for (const batch of preparedBatches) {
        const label = describeBatch(batch, preparedBatches.length);
        console.log(`  ${label}: upserting...`);

        const result = await withRetry(
            () => vectorStore.addVectors(batch.vectors, batch.docs, { ids: batch.ids }),
            { label: `${label} upsert`, maxAttempts, baseDelayMs }
        );

        if (result.ok) {
            succeeded += batch.docs.length;
            console.log(
                result.attempts > 1
                    ? `  ${label}: OK on attempt ${result.attempts}/${maxAttempts}`
                    : `  ${label}: OK`
            );
        } else {
            failures.push({ label, message: result.message, attempts: result.attempts });
        }
    }

    return { total, succeeded, failures };
}

export async function verifyIndexedCount(pineconeIndex, expected, options = {}) {
    const {
        attempts = INDEX_VERIFY_ATTEMPTS,
        delayMs = INDEX_VERIFY_DELAY_MS,
    } = options;

    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new Error('attempts must be a positive integer');
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error('delayMs must be a non-negative number');
    }

    console.log(`Verifying the index contains ${expected} vectors...`);
    let count = null;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const stats = await pineconeIndex.describeIndexStats();
            count = stats.totalRecordCount ?? 0;
            lastError = null;
            if (count === expected) {
                return { ok: true, count, attempts: attempt };
            }
        } catch (err) {
            lastError = errorMessage(err);
        }

        if (attempt < attempts) await sleep(delayMs);
    }

    return {
        ok: false,
        count,
        attempts,
        message: lastError ?? `Index contains ${count ?? 'unknown'} vectors, expected ${expected}`,
    };
}

/**
 * Delete every vector from the index before re-indexing.
 *
 * A brand-new Pinecone index has no namespaces, and `deleteAll()` returns a 404
 * for a namespace that does not exist yet. That is equivalent to an empty index,
 * so it is treated as success instead of failing the whole run.
 */
export async function clearIndexVectors(pineconeIndex, existingCount, options = {}) {
    if (existingCount === 0) {
        return { ok: true, cleared: false, reason: 'already-empty' };
    }

    const result = await withRetry(
        () => pineconeIndex.deleteAll(),
        { label: 'Clearing existing vectors', ...options }
    );

    if (result.ok) {
        return { ok: true, cleared: true };
    }

    if (isNotFoundError(result.error)) {
        return { ok: true, cleared: false, reason: 'missing-namespace' };
    }

    return { ok: false, message: result.message };
}

export async function indexing({ pdfPath, dryRun = false, indexName: indexNameOverride, buildGraph, onProgress, onChunks, documentId } = {}) {
    const resolvedPdfPath = resolvePdfPath(pdfPath);
    const pdfFileName = path.basename(resolvedPdfPath);

    let indexName = null;
    if (!dryRun) {
        // Validate configuration before doing any expensive PDF work.
        requireEnv('PINECONE_API_KEY');
        getProviderEnv();
        indexName = indexNameOverride || getIndexName();
    }
    const report = typeof onProgress === 'function' ? onProgress : () => {};

    console.log(`Loading PDF "${resolvedPdfPath}"...`);
    const { pages: rawPages, totalPages } = await loadPdfPages(resolvedPdfPath);
    console.log(`Loaded PDF: ${totalPages} pages`);

    console.log('Splitting document into chunks...');
    const { docs: chunkedDocs, tocPagesSkipped } = await buildChunks(rawPages, {
        metadata: { source: pdfFileName, documentId: documentId || '' },
    });

    console.log(
        `Created ${chunkedDocs.length} chunks` +
        (tocPagesSkipped > 0 ? ` (skipped ${tocPagesSkipped} table-of-contents pages)` : '')
    );

    const stats = chunkStats(chunkedDocs);

    if (dryRun) {
        console.log('\nDry run summary (no embeddings, no Pinecone changes):');
        console.log(`  Chunks:                   ${stats.count}`);
        console.log(`  Characters (min/avg/max): ${stats.min}/${stats.avg}/${stats.max}`);
        console.log(`  Chunks over CHUNK_SIZE:   ${stats.overSize}`);
        console.log(`  Chunks spanning pages:    ${stats.spanningPages}`);
        console.log(`  TOC pages skipped:        ${tocPagesSkipped}`);
        return;
    }

    if (chunkedDocs.length === 0) {
        throw new Error('No chunks were generated from the PDF.');
    }

    // Deterministic IDs make upserts idempotent: rerunning indexing overwrites
    // the same vectors instead of adding a new copy of every chunk.
    const idPrefix = documentId || pdfFileName;
    const chunkIds = chunkedDocs.map((_, index) => `${idPrefix}-${index}`);

    console.log('Configuring Gemini embedding model...');
    const embeddingModel = createEmbeddingModel();

    console.log('Connecting to Pinecone...');
    const pinecone = createPineconeClient();
    await ensurePineconeIndex(pinecone, indexName);
    const pineconeIndex = pinecone.Index(indexName);
    console.log(`Connected to index "${indexName}"`);

    const vectorStore = await PineconeStore.fromExistingIndex(embeddingModel, {
        pineconeIndex,
        maxConcurrency: 5,
    });

    const retryOptions = {
        maxAttempts: BATCH_MAX_ATTEMPTS,
        baseDelayMs: BATCH_RETRY_BASE_DELAY_MS,
    };

    // Embed everything *before* clearing the existing vectors. If Gemini fails,
    // the previous index is still intact and querying keeps working.
    console.log('Preparing embeddings before modifying the existing index...');
    const embedded = await embedBatches(
        chunkedDocs,
        chunkIds,
        embeddingModel,
        INDEX_BATCH_SIZE,
        retryOptions
    );

    if (embedded.failures.length > 0) {
        console.error('\nEmbedding failed:');
        for (const failure of embedded.failures) {
            console.error(
                `  - ${failure.label}: ${failure.message}` +
                (failure.attempts > 1 ? ` (after ${failure.attempts} attempts)` : '')
            );
        }
        console.error(
            `\nNothing was written; the existing index was left unchanged. ` +
            `Fix the errors and re-run \`npm run index\`.`
        );
        process.exitCode = 1;
        return;
    }

    console.log(`Embedded ${embedded.embedded}/${embedded.total} chunks successfully`);
    report('vectors', 40);

    // This index is dedicated to this PDF. Clearing it also removes any stale
    // chunks left behind when the PDF or chunking settings change.
    const statsResult = await withRetry(
        () => pineconeIndex.describeIndexStats(),
        { label: 'Reading index stats', ...retryOptions }
    );
    let existingCount = null;
    if (statsResult.ok) {
        existingCount = statsResult.value.totalRecordCount ?? 0;
        console.log(`Index currently contains ${existingCount} vectors`);
    } else {
        console.warn(`Could not read index stats: ${statsResult.message}`);
    }

    // Remove any stale vectors for this document (re-index case) without
    // wiping other documents in the shared user index.
    if (documentId) {
        console.log('Removing stale vectors for this document (if any)...');
        try {
            await pineconeIndex.deleteMany({ documentId });
            console.log('Stale vectors removed');
        } catch (err) {
            console.warn('Could not remove stale vectors:', err.message);
        }
    } else if (existingCount === 0) {
        console.log('Index is already empty; nothing to clear');
    } else {
        console.log('Clearing existing vectors so reruns do not create duplicates...');
        const cleared = await clearIndexVectors(pineconeIndex, existingCount, retryOptions);
        if (!cleared.ok) {
            throw new Error(`Could not clear the existing index: ${cleared.message}`);
        }
        console.log(cleared.cleared ? 'Existing vectors cleared' : 'Index was already empty; nothing to clear');
    }

    const upserted = await upsertBatches(embedded.prepared, vectorStore, retryOptions);

    report('vectors', 80);

    console.log('\nIndexing summary:');
    console.log(`  Chunks processed: ${upserted.total}`);
    console.log(`  Succeeded:        ${upserted.succeeded}`);
    console.log(
        `  Failed:           ${upserted.total - upserted.succeeded}` +
        (upserted.failures.length > 0 ? ` (${upserted.failures.length} batch(es))` : '')
    );

    if (upserted.failures.length > 0) {
        console.error('\nFailed batches:');
        for (const failure of upserted.failures) {
            console.error(
                `  - ${failure.label}: ${failure.message}` +
                (failure.attempts > 1 ? ` (after ${failure.attempts} attempts)` : '')
            );
        }
        console.error('Some vectors were not indexed. Re-run `npm run index` to retry.');
        process.exitCode = 1;
        return;
    }

    if (buildGraph === undefined) buildGraph = process.env.GRAPH_RAG === 'true';

    if (buildGraph && graph.getDriver()) {
        console.log('\nBuilding knowledge graph...');
        report('vectors', 100);
        report('graph', 0);
        const graphChunks = chunkedDocs.map((doc, i) => ({
            text: doc.pageContent,
            page: doc.metadata?.page,
            pageEnd: doc.metadata?.pageEnd,
        }));
        // Save chunks to Pdf doc is handled by server via onChunks callback
        if (typeof onChunks === 'function') {
            await onChunks(graphChunks);
        }
        const { buildKnowledgeGraph } = await import('./graphBuilder.js');
        await buildKnowledgeGraph({
            indexName,
            docName: pdfFileName,
            documentId: documentId || '',
            chunks: graphChunks,
            totalPages,
            onProgress: report,
        });
    } else {
        report('vectors', 100);
        report('done', 100);
    }

    if (documentId) {
        console.log(`Indexing complete: ${upserted.succeeded} chunks stored in Pinecone for document ${documentId}`);
    } else {
        const verification = await verifyIndexedCount(pineconeIndex, upserted.succeeded);
        if (!verification.ok) {
            console.error(
                `\nIndex verification failed after ${verification.attempts} attempt(s): ` +
                `${verification.message}`
            );
            console.error('The index may be incomplete. Re-run `npm run index` to rebuild it.');
            process.exitCode = 1;
            return;
        }
        console.log(`Indexing complete: ${verification.count} chunks stored in Pinecone`);
    }
}

// Module used as a library by the web server.
