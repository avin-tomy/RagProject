import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';

// Content-aware chunking settings
export const CHUNK_SIZE = 1600;
export const CHUNK_OVERLAP = 200;
export const MIN_CHUNK_SIZE = 100;

// Only used when a single paragraph/code block is too large to fit in one chunk.
// The outer loop adds overlap between chunks, so the splitter itself does not.
const overflowSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: 0,
    separators: ['\n', '. ', ' ', ''],
});

export function cleanPageText(text) {
    return text
        .replace(/^\s*Version 1\.0\s*\n\s*\d+\s*\n/, '') // repeated page header
        .replace(/[ \t]+$/gm, '')
        .trim();
}

export function isTableOfContents(text) {
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length === 0) return false;

    const tocLines = lines.filter((line) => /\.{5,}\s*\d+\s*$/.test(line)).length;
    return tocLines / lines.length > 0.3;
}

// Take the tail of the previous chunk without starting in the middle of a word.
function sliceOverlap(text, overlap) {
    if (overlap <= 0 || !text) return '';

    let tail = text.slice(-overlap);
    const firstSpace = tail.search(/\s/);
    if (firstSpace > 0 && firstSpace < 40) {
        tail = tail.slice(firstSpace + 1);
    }
    return tail.trim();
}

/**
 * Build chunks from an ordered list of pages, carrying the last paragraph across
 * page boundaries so content that spans pages is not cut apart or dropped.
 *
 * @param {{ page: number, text: string }[]} pages
 * @param {{
 *   chunkSize?: number,
 *   chunkOverlap?: number,
 *   minChunkSize?: number,
 *   splitter?: { splitText: (text: string) => Promise<string[]> },
 *   metadata?: object,
 * }} options
 * @returns {Promise<Document[]>}
 */
export async function chunkPages(pages, options = {}) {
    const {
        chunkSize = CHUNK_SIZE,
        chunkOverlap = CHUNK_OVERLAP,
        minChunkSize = MIN_CHUNK_SIZE,
        splitter = overflowSplitter,
        metadata = {},
    } = options;

    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new Error('chunkSize must be a positive integer');
    }
    if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
        throw new Error('chunkOverlap must be between 0 and chunkSize');
    }
    if (!Number.isFinite(minChunkSize) || minChunkSize < 0) {
        throw new Error('minChunkSize must be a non-negative number');
    }

    const chunks = [];
    let current = '';
    let startPage = null;
    let endPage = null;
    let lastPageSeen = null;

    function flush() {
        const text = current.trim();
        if (text) {
            chunks.push({
                text,
                startPage: startPage ?? endPage,
                endPage: endPage ?? startPage,
            });
        }
        current = '';
        startPage = null;
        endPage = null;
    }

    for (const { page, text } of pages) {
        // Do not merge across skipped pages (for example TOC pages), otherwise a
        // title page and the next real content page become one chunk.
        if (lastPageSeen !== null && page !== lastPageSeen && page !== lastPageSeen + 1) {
            flush();
        }
        lastPageSeen = page;

        const blocks = String(text)
            .split(/\n\s*\n+/)
            .map((block) => block.trim())
            .filter(Boolean);

        for (const block of blocks) {
            const pieces = block.length > chunkSize
                ? (await splitter.splitText(block)).map((piece) => piece.trim()).filter(Boolean)
                : [block];

            for (const piece of pieces) {
                const candidate = current ? `${current}\n\n${piece}` : piece;

                if (current && candidate.length > chunkSize) {
                    const previous = current;
                    flush();

                    const maxOverlap = chunkSize - piece.length - 2;
                    const overlap = maxOverlap > 0
                        ? sliceOverlap(previous, Math.min(chunkOverlap, maxOverlap))
                        : '';

                    current = overlap ? `${overlap}\n\n${piece}` : piece;
                    startPage = page;
                    endPage = page;
                } else {
                    if (!current) startPage = page;
                    current = candidate;
                    endPage = page;
                }
            }
        }
    }

    if (current.trim()) {
        const tail = current.trim();
        const last = chunks.at(-1);
        const canMergeIntoTail = last
            && tail.length < minChunkSize
            && last.text.length + tail.length + 2 <= chunkSize;

        if (canMergeIntoTail) {
            // Keep short page/document tails instead of silently dropping them.
            last.text = `${last.text}\n\n${tail}`.trim();
            last.endPage = endPage ?? last.endPage;
            current = '';
            startPage = null;
            endPage = null;
        } else {
            // Keep the tail even when it is below MIN_CHUNK_SIZE rather than lose
            // content; the only alternative here is a chunk over the size limit.
            flush();
        }
    }

    return chunks.map(({ text, startPage: page, endPage: lastPage }) => {
        const chunkMetadata = { ...metadata, page };
        if (lastPage != null && lastPage !== page) {
            chunkMetadata.pageEnd = lastPage;
        }
        return new Document({ pageContent: text, metadata: chunkMetadata });
    });
}
