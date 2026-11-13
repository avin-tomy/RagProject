import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

let pdfjsPromise;

// pdf-parse v1 bundles the same PDF.js build that @langchain/community's
// PDFLoader uses. Loading it directly keeps the dependency tree small.
async function loadPdfJs() {
    if (!pdfjsPromise) {
        const modulePath = require.resolve('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
        pdfjsPromise = import(pathToFileURL(modulePath).href).then((mod) => mod.default ?? mod);
    }
    return pdfjsPromise;
}

/**
 * Extract text from a PDF, one entry per page.
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   pages: { page: number, text: string }[],
 *   totalPages: number,
 *   version: string,
 *   info: object | undefined,
 * }>}
 */
export async function loadPdfPages(filePath) {
    let getDocument;
    let version;
    try {
        ({ getDocument, version } = await loadPdfJs());
    } catch (err) {
        throw new Error(`Could not load the PDF parser from pdf-parse: ${err.message}`);
    }

    const data = new Uint8Array(await readFile(filePath));
    const pdf = await getDocument({
        data,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
    }).promise;

    const meta = await pdf.getMetadata().catch(() => null);
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        if (content.items.length === 0) continue;

        let lastY;
        const parts = [];
        for (const item of content.items) {
            if (!('str' in item)) continue;

            if (lastY === undefined || lastY === item.transform[5]) {
                parts.push(item.str);
            } else {
                parts.push(`\n${item.str}`);
            }
            lastY = item.transform[5];
        }

        pages.push({ page: pageNumber, text: parts.join('') });
    }

    return {
        pages,
        totalPages: pdf.numPages,
        version,
        info: meta?.info,
    };
}
