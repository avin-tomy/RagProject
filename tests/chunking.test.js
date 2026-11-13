import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chunkPages,
    cleanPageText,
    isTableOfContents,
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MIN_CHUNK_SIZE,
} from '../src/chunking.js';

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

function fixedPieceSplitter(pieceSize) {
    return {
        async splitText(text) {
            const pieces = [];
            for (let start = 0; start < text.length; start += pieceSize) {
                pieces.push(text.slice(start, start + pieceSize));
            }
            return pieces;
        },
    };
}

test('cleanPageText strips the repeated page header and trailing spaces', () => {
    const raw = '  Version 1.0\n  12\nHello world   \nSecond line\t\n';
    assert.equal(cleanPageText(raw), 'Hello world\nSecond line');
});

test('cleanPageText leaves ordinary text intact', () => {
    assert.equal(cleanPageText('  A normal page  '), 'A normal page');
});

test('isTableOfContents detects dotted page listings', () => {
    const toc = [
        'Chapter 1 ........ 1',
        'Chapter 2 ........ 5',
        'Chapter 3 ........ 9',
    ].join('\n');
    assert.equal(isTableOfContents(toc), true);
});

test('isTableOfContents ignores normal prose and empty text', () => {
    assert.equal(isTableOfContents('This is just a paragraph.\nWith two lines.'), false);
    assert.equal(isTableOfContents('   '), false);
});

test('chunkPages returns no chunks for no pages', async () => {
    assert.deepEqual(await chunkPages([]), []);
});

test('chunkPages carries content across a page boundary', async () => {
    const docs = await chunkPages(
        [
            { page: 1, text: 'A'.repeat(500) },
            { page: 2, text: 'B'.repeat(500) },
        ],
        { chunkSize: 1600, chunkOverlap: 0, minChunkSize: 100 }
    );

    assert.equal(docs.length, 1);
    assert.equal(docs[0].pageContent.length, 1002);
    assert.equal(docs[0].metadata.page, 1);
    assert.equal(docs[0].metadata.pageEnd, 2);
});

test('chunkPages flushes across a gap between pages', async () => {
    const docs = await chunkPages(
        [
            { page: 1, text: 'A'.repeat(500) },
            { page: 3, text: 'B'.repeat(500) },
        ],
        { chunkSize: 1600, chunkOverlap: 0, minChunkSize: 100 }
    );

    assert.equal(docs.length, 2);
    assert.equal(docs[0].metadata.page, 1);
    assert.equal(docs[0].metadata.pageEnd, undefined);
    assert.equal(docs[1].metadata.page, 3);
    assert.equal(docs[1].metadata.pageEnd, undefined);
});

test('chunkPages never exceeds chunkSize when overlap is added', async () => {
    const docs = await chunkPages(
        [{ page: 1, text: 'A'.repeat(800) }],
        {
            chunkSize: 100,
            chunkOverlap: 30,
            minChunkSize: 0,
            splitter: fixedPieceSplitter(80),
        }
    );

    assert.ok(docs.length > 1);
    for (const doc of docs) {
        assert.ok(
            doc.pageContent.length <= 100,
            `chunk length ${doc.pageContent.length} exceeds 100`
        );
    }
    assert.ok(docs.some((doc) => doc.pageContent.length === 100), 'expected the capped overlap');
});

test('chunkPages keeps a short tail instead of dropping it', async () => {
    const docs = await chunkPages(
        [
            { page: 1, text: 'A'.repeat(90) },
            { page: 2, text: 'B'.repeat(20) },
        ],
        { chunkSize: 100, chunkOverlap: 0, minChunkSize: 50 }
    );

    assert.equal(docs.length, 2);
    assert.equal(docs[0].pageContent.length, 90);
    assert.equal(docs[1].pageContent, 'B'.repeat(20));
});

test('chunkPages merges a short tail into the previous chunk when it fits', async () => {
    const docs = await chunkPages(
        [
            { page: 1, text: 'A'.repeat(60) },
            { page: 3, text: 'B'.repeat(20) },
        ],
        { chunkSize: 100, chunkOverlap: 0, minChunkSize: 50 }
    );

    assert.equal(docs.length, 1);
    assert.equal(docs[0].pageContent, `${'A'.repeat(60)}\n\n${'B'.repeat(20)}`);
    assert.equal(docs[0].metadata.page, 1);
    assert.equal(docs[0].metadata.pageEnd, 3);
});

test('chunkPages respects the production chunk size for a huge block', async () => {
    const bigBlock = Array.from({ length: 2000 }, (_, index) => `word${index}`).join(' ');

    const docs = await chunkPages(
        [{ page: 7, text: bigBlock }],
        { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, minChunkSize: MIN_CHUNK_SIZE }
    );

    assert.ok(docs.length > 1);
    for (const doc of docs) {
        assert.ok(doc.pageContent.length <= CHUNK_SIZE);
        assert.equal(doc.metadata.page, 7);
    }
});

test('chunkPages copies caller metadata into every chunk', async () => {
    const docs = await chunkPages(
        [{ page: 2, text: 'Some content that is long enough.' }],
        { metadata: { source: 'Node.pdf' } }
    );

    assert.deepEqual(docs[0].metadata, { source: 'Node.pdf', page: 2 });
});

test('chunkPages validates its options', async () => {
    await assert.rejects(() => chunkPages([], { chunkSize: 0 }), /chunkSize/);
    await assert.rejects(() => chunkPages([], { chunkSize: 100, chunkOverlap: -1 }), /chunkOverlap/);
    await assert.rejects(() => chunkPages([], { chunkSize: 100, chunkOverlap: 100 }), /chunkOverlap/);
    await assert.rejects(() => chunkPages([], { minChunkSize: -1 }), /minChunkSize/);
});
