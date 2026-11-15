import {
    createPineconeClient,
    getIndexName,
    assertIndexCompatible,
    isNotFoundError,
} from './config.js';
import { verifyIndexedCount, clearIndexVectors } from './indexing.js';

const RESET_USAGE = `Usage: node reset.js [--yes]

Delete every vector from the configured Pinecone index.
This is destructive and cannot be undone.

Options:
  -y, --yes   Delete without asking for confirmation
  -h, --help  Show this help`;

export function parseResetArgs(argv = process.argv.slice(2)) {
    let yes = false;
    let help = false;

    for (const arg of argv) {
        if (arg === '--yes' || arg === '-y') {
            yes = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            help = true;
            continue;
        }
        throw new Error(`Unknown option "${arg}"\n\n${RESET_USAGE}`);
    }

    return { yes, help };
}

export async function resetIndex({ yes = false, pinecone, indexName } = {}) {
    const resolvedIndexName = indexName ?? getIndexName();
    const client = pinecone ?? createPineconeClient();

    let index;
    try {
        index = await client.describeIndex(resolvedIndexName);
    } catch (err) {
        if (isNotFoundError(err)) {
            throw new Error(`Index "${resolvedIndexName}" does not exist.`);
        }
        throw err;
    }
    assertIndexCompatible(index, resolvedIndexName);

    const pineconeIndex = client.Index(resolvedIndexName);
    const stats = await pineconeIndex.describeIndexStats();
    const count = stats.totalRecordCount ?? 0;

    if (count === 0) {
        console.log(`Index "${resolvedIndexName}" is already empty.`);
        return { reset: false, count: 0 };
    }

    if (!yes) {
        console.log(`This would delete ${count} vector(s) from index "${resolvedIndexName}".`);
        console.log('Re-run with --yes to confirm.');
        return { reset: false, count };
    }

    console.log(`Deleting ${count} vector(s) from index "${resolvedIndexName}"...`);
    const cleared = await clearIndexVectors(pineconeIndex, count);
    if (!cleared.ok) {
        throw new Error(`Could not clear index "${resolvedIndexName}": ${cleared.message}`);
    }

    const verification = await verifyIndexedCount(pineconeIndex, 0);
    if (!verification.ok) {
        throw new Error(`Index reset could not be verified: ${verification.message}`);
    }

    console.log(`Index "${resolvedIndexName}" is empty.`);
    return { reset: true, count: verification.count };
}

// Module used as a library by the web server.

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const { yes, help } = parseResetArgs(process.argv.slice(2));
    if (help) {
        console.log(RESET_USAGE);
        process.exit(0);
    }
    resetIndex({ yes }).then(() => {
        process.exit(0);
    }).catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
}
