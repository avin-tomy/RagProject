import mongoose from 'mongoose';

const pdfSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    originalName: { type: String, required: true },
    storedPath: { type: String, required: true },
    docName: { type: String },
    size: { type: Number, required: true },
    status: { type: String, enum: ['uploading', 'indexing', 'indexed', 'failed'], default: 'uploading' },
    phase: { type: String, default: '' },
    progress: { type: Number, default: 0 },
    error: { type: String },
    graphEnabled: { type: Boolean, default: false },
    chunks: { type: [{ text: String, page: Number, pageEnd: Number }], default: [] },
    indexName: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export const Pdf = mongoose.model('Pdf', pdfSchema);
