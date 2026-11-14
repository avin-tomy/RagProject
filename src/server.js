import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs';

import { User } from './models/User.js';
import { Pdf } from './models/Pdf.js';
import { authMiddleware } from './middleware/auth.js';
import { generateIndexName } from './utils/indexName.js';
import {
    createEmbeddingModel,
    createChatModel,
    createRewriteModel,
    createPineconeClient,
    getScoreThreshold,
    assertIndexCompatible,
    isNotFoundError,
} from './config.js';
import { PineconeStore } from '@langchain/pinecone';
import { createChatSession } from './query.js';
import { indexing } from './indexing.js';
import { buildKnowledgeGraph } from './graphBuilder.js';
import * as graph from './graph.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('JWT_SECRET must be set to a strong secret of at least 32 characters');
    process.exit(1);
}
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const app = express();
app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin / curl
        if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
});
const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
        else cb(new Error('Only PDF files are allowed'));
    },
});

// ---------- Mongo connection ----------
if (!MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env');
    process.exit(1);
}
try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB Atlas');

    // Recover PDFs stuck in 'indexing' from a previous crash/restart.
    try {
        const stuck = await Pdf.updateMany(
            { status: 'indexing' },
            { $set: { status: 'failed', error: 'Indexing was interrupted (server restart). Please re-upload.' } }
        );
        if (stuck.modifiedCount > 0) {
            console.log(`Recovered ${stuck.modifiedCount} stuck indexing record(s).`);
        }
    } catch (err) {
        console.warn('Could not recover stuck records:', err.message);
    }

    if (process.env.NEO4J_URI) {
        graph.initGraph(process.env.NEO4J_URI, process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD);
        const s = graph.getDriver().session();
        await graph.ensureGraphSchema(s);
        await s.close();
        console.log('Connected to Neo4j Aura');
    } else {
        console.log('Neo4j not configured (graph features disabled).');
    }
} catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
}

// ---------- Auth ----------
function signToken(user) {
    return jwt.sign({ id: user._id.toString(), email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

        const passwordHash = await bcrypt.hash(password, 10);
        const pineconeIndexName = generateIndexName();
        const user = await User.create({ name, email, passwordHash, pineconeIndexName });
        const token = signToken(user);
        res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: err.message || 'Signup failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const user = await User.findOne({ email: (email || '').toLowerCase() });
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });
        const ok = await bcrypt.compare(password || '', user.passwordHash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
        const token = signToken(user);
        res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message || 'Login failed' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-passwordHash');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user: { id: user._id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- PDFs ----------
app.post('/api/pdfs', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const buildGraph = req.body?.buildGraph === 'true' || req.body?.buildGraph === true;
        const docName = path.basename(req.file.path);

        const pdf = await Pdf.create({
            userId: user._id,
            originalName: req.file.originalname,
            storedPath: req.file.path,
            docName,
            size: req.file.size,
            status: 'indexing',
            graphEnabled: buildGraph,
            indexName: user.pineconeIndexName,
        });

        // Index asynchronously
        (async () => {
            try {
                await indexing({
                    pdfPath: req.file.path,
                    dryRun: false,
                    indexName: user.pineconeIndexName,
                    buildGraph,
                    documentId: pdf._id.toString(),
                    onProgress: async (phase, pct) => {
                        await Pdf.findByIdAndUpdate(pdf._id, { phase, progress: pct });
                    },
                    onChunks: async (chunks) => {
                        await Pdf.findByIdAndUpdate(pdf._id, { chunks });
                    },
                });
                await Pdf.findByIdAndUpdate(pdf._id, { status: 'indexed', phase: 'done', progress: 100 });
            } catch (err) {
                console.error('Indexing failed for', pdf._id, err);
                await Pdf.findByIdAndUpdate(pdf._id, { status: 'failed', error: err.message });
            } finally {
                // The original file is no longer needed after indexing.
                try { await fs.promises.unlink(req.file.path); } catch { /* ignore */ }
            }
        })();

        res.json({ pdf: serializePdf(pdf) });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message || 'Upload failed' });
    }
});

app.get('/api/pdfs', authMiddleware, async (req, res) => {
    try {
        const pdfs = await Pdf.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json({ pdfs: pdfs.map(serializePdf) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Build graph for an already-indexed PDF ----------
app.post('/api/pdfs/:id/build-graph', authMiddleware, async (req, res) => {
    try {
        const pdf = await Pdf.findOne({ _id: req.params.id, userId: req.user.id });
        if (!pdf) return res.status(404).json({ error: 'Not found' });
        let docName = pdf.docName || pdf.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');

        if (!pdf.chunks || pdf.chunks.length === 0) {
            // Fallback: fetch chunks from Pinecone (for PDFs indexed before chunks were stored).
            try {
                const pinecone = createPineconeClient();
                const pineconeIndex = pinecone.Index(pdf.indexName);
                const stats = await pineconeIndex.describeIndexStats();
                const count = stats.totalRecordCount || 0;
                if (count === 0) {
                    return res.status(400).json({ error: 'No vectors found in index. Re-upload the PDF first.' });
                }
                // Derive the doc name from the first vector id (format: <docName>-<index>).
                const list = await pineconeIndex.listPaginated({ limit: 1 });
                const firstId = list.vectors?.[0]?.id;
                const derivedDocName = firstId ? firstId.replace(/-\d+$/, '') : docName;
                const ids = Array.from({ length: count }, (_, i) => `${derivedDocName}-${i}`);
                const fetched = await pineconeIndex.fetch(ids);
                const records = fetched.records || {};
                const chunks = [];
                for (let i = 0; i < count; i++) {
                    const rec = records[`${derivedDocName}-${i}`];
                    const text = rec?.metadata?.text || rec?.metadata?.pageContent || '';
                    if (text) {
                        chunks.push({ text, page: rec.metadata?.page, pageEnd: rec.metadata?.pageEnd });
                    }
                }
                if (chunks.length === 0) {
                    return res.status(400).json({ error: 'Could not retrieve chunk text from Pinecone. Re-upload the PDF.' });
                }
                pdf.chunks = chunks;
                pdf.docName = derivedDocName;
                await pdf.save();
                docName = derivedDocName;
            } catch (err) {
                console.error('Fallback chunk fetch failed:', err);
                return res.status(400).json({ error: 'No stored chunks. Re-upload the PDF first.' });
            }
        }
        if (!graph.getDriver()) {
            return res.status(400).json({ error: 'Neo4j is not configured on the server' });
        }

        await Pdf.findByIdAndUpdate(pdf._id, { status: 'indexing', phase: 'graph', progress: 0, graphEnabled: true });

        (async () => {
            try {
                await buildKnowledgeGraph({
                    indexName: pdf.indexName,
                    docName,
                    documentId: pdf._id.toString(),
                    chunks: pdf.chunks,
                    totalPages: 0,
                    onProgress: async (phase, pct) => {
                        await Pdf.findByIdAndUpdate(pdf._id, { phase, progress: pct });
                    },
                });
                await Pdf.findByIdAndUpdate(pdf._id, { status: 'indexed', graphEnabled: true, phase: 'done', progress: 100 });
            } catch (err) {
                console.error('Graph build failed for', pdf._id, err);
                await Pdf.findByIdAndUpdate(pdf._id, { status: 'indexed', phase: 'failed', error: err.message });
            }
        })();

        res.json({ ok: true, message: 'Graph build started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/pdfs/:id', authMiddleware, async (req, res) => {
    try {
        const pdf = await Pdf.findOne({ _id: req.params.id, userId: req.user.id });
        if (!pdf) return res.status(404).json({ error: 'Not found' });

        // Remove the stored file from disk.
        try { await fs.promises.unlink(pdf.storedPath); } catch { /* ignore */ }

        // Remove this document's vectors from the shared user index.
        try {
            const pinecone = createPineconeClient();
            const pineconeIndex = pinecone.Index(pdf.indexName);
            await pineconeIndex.deleteMany({ documentId: pdf._id.toString() });
        } catch { /* ignore */ }

        // Remove this document's graph data.
        try {
            const { clearGraphDocument } = await import('./graph.js');
            await clearGraphDocument(pdf.indexName, pdf._id.toString());
        } catch { /* ignore */ }

        await Pdf.deleteOne({ _id: pdf._id });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function serializePdf(p) {
    return {
        id: p._id,
        name: p.originalName,
        size: formatSize(p.size),
        status: p.status,
        phase: p.phase || '',
        progress: p.progress || 0,
        graphEnabled: p.graphEnabled || false,
        error: p.error,
        uploadedAt: p.createdAt ? new Date(p.createdAt).toLocaleString() : '',
        indexName: p.indexName,
    };
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- Query ----------
app.post('/api/query', authMiddleware, async (req, res) => {
    const { question, history = [], documentIds } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: 'question is required' });
    }
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Index name is request-scoped (user.pineconeIndexName); never mutate process.env.

        const scoreThreshold = getScoreThreshold();
        const embeddingModel = createEmbeddingModel();
        const model = createChatModel();
        const rewriteModel = createRewriteModel();
        const pinecone = createPineconeClient();
        let index;
        try { index = await pinecone.describeIndex(user.pineconeIndexName); }
        catch (err) {
            if (isNotFoundError(err)) throw new Error(`Index "${user.pineconeIndexName}" does not exist. Index a PDF first.`);
            throw err;
        }
        assertIndexCompatible(index, user.pineconeIndexName);
        const pineconeIndex = pinecone.Index(user.pineconeIndexName);
        const vectorStore = await PineconeStore.fromExistingIndex(embeddingModel, { pineconeIndex });

        const agentic = process.env.AGENTIC_RAG === 'true';
        const documentFilter = Array.isArray(documentIds) && documentIds.length
            ? { documentId: { $in: documentIds } }
            : null;
        const session = createChatSession({
            vectorStore, model, rewriteModel, scoreThreshold,
            streaming: false, agentic, indexName: user.pineconeIndexName,
            documentFilter,
        });

        for (const m of history) {
            if (m.role === 'user') session.chatHistory.push(new HumanMessage(m.content));
            else if (m.role === 'assistant') session.chatHistory.push(new AIMessage(m.content));
        }

        await session.chatting(question.trim());

        const last = session.chatHistory[session.chatHistory.length - 1];
        const answer = (last && last.content) ? String(last.content) : '';
        const updatedHistory = session.chatHistory.map(m => ({
            role: m instanceof HumanMessage ? 'user' : 'assistant',
            content: String(m.content),
        }));

        res.json({ answer, history: updatedHistory });
    } catch (err) {
        console.error('Query error:', err);
        res.status(500).json({ error: err.message || 'Query failed' });
    }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve frontend (single-folder deploy)
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_DIST));
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err) => {
        if (err) next();
    });
});

const server = app.listen(PORT, () => {
    console.log(`RAG API listening on http://localhost:${PORT}`);
});

async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close();
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    try { await graph.closeGraph(); } catch { /* ignore */ }
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
