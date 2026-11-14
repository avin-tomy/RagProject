import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import UploadZone from '../components/UploadZone';
import PdfList from '../components/PdfList';
import ChatPanel from '../components/ChatPanel';

const API = '';

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

export default function Dashboard() {
  const { user, logout, authFetch } = useAuth();
  const [pdfs, setPdfs] = useState([]);
  const [uploading, setUploading] = useState(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const [buildGraph, setBuildGraph] = useState(false);

  const loadPdfs = useCallback(async () => {
    try {
      const res = await authFetch('/api/pdfs');
      if (res.status === 401) {
        // token invalid/expired — force re-login
        return;
      }
      const data = await res.json();
      if (res.ok) setPdfs(data.pdfs || []);
      else console.error('Failed to load PDFs:', data.error);
    } catch (e) { console.error(e); }
  }, [authFetch]);

  useEffect(() => { loadPdfs(); }, [loadPdfs]);

  // Poll while any pdf is indexing
  useEffect(() => {
    const hasIndexing = pdfs.some(p => p.status === 'indexing' || p.status === 'uploading');
    if (!hasIndexing) return;
    const t = setInterval(loadPdfs, 3000);
    return () => clearInterval(t);
  }, [pdfs, loadPdfs]);

  const handleUpload = useCallback((file) => {
    const form = new FormData();
    form.append('file', file);
    form.append('buildGraph', buildGraph ? 'true' : 'false');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/pdfs`);
    xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('rag_token')}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploading({ name: file.name, progress: pct });
      }
    };
    xhr.onload = () => {
      setUploading(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        loadPdfs();
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        alert(msg);
      }
    };
    xhr.onerror = () => { setUploading(null); alert('Network error'); };
    setUploading({ name: file.name, progress: 0 });
    xhr.send(form);
  }, [loadPdfs, buildGraph]);

  const removePdf = async (id) => {
    try {
      await authFetch(`/api/pdfs/${id}`, { method: 'DELETE' });
      loadPdfs();
    } catch (e) { console.error(e); }
  };

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <h1>Dashboard</h1>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => setConfirmLogout(true)}>Log out</button>
        </div>
      </header>

      <div className="grid">
        <div className="panel">
          <h2>Upload PDF</h2>
          <p className="hint">Add a PDF to your workspace. Max 25 MB, PDF only.</p>
          <UploadZone onUpload={handleUpload} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={buildGraph} onChange={e => setBuildGraph(e.target.checked)} />
            Build knowledge graph (slower, enables relationship queries)
          </label>
          {uploading && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>
                Uploading {uploading.name}… {uploading.progress}%
              </div>
              <div className="progress"><div style={{ width: `${uploading.progress}%` }} /></div>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Your PDFs</h2>
          <p className="hint">{pdfs.length} file{pdfs.length === 1 ? '' : 's'} in your workspace.</p>
          <PdfList items={pdfs.map(p => ({ id: p.id || p._id, name: p.name, size: p.size, uploadedAt: p.uploadedAt, status: p.status, phase: p.phase, progress: p.progress, graphEnabled: p.graphEnabled }))} onRemove={removePdf} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>Chat</h2>
        <p className="hint">Ask questions about your indexed PDFs.</p>
        <ChatPanel pdfs={pdfs.map(p => ({ id: p.id || p._id, name: p.name }))} />
      </div>
      {confirmLogout && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setConfirmLogout(false)}>
          <div className="card" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <h1 style={{ fontSize: 20 }}>Log out?</h1>
            <p className="subtitle">Are you sure you want to log out?</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setConfirmLogout(false)}>Cancel</button>
              <button className="btn" onClick={() => { setConfirmLogout(false); logout(); }}>Log out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
