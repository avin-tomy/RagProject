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
  const [buildGraph, setBuildGraph] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState([]);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const loadPdfs = useCallback(async () => {
    try {
      const res = await authFetch('/api/pdfs');
      if (res.status === 401) return;
      const data = await res.json();
      if (res.ok) setPdfs(data.pdfs || []);
      else console.error('Failed to load PDFs:', data.error);
    } catch (e) { console.error(e); }
  }, [authFetch]);

  useEffect(() => { loadPdfs(); }, [loadPdfs]);

  useEffect(() => {
    const hasIndexing = pdfs.some(p => p.status === 'indexing' || p.status === 'uploading');
    if (!hasIndexing) return;
    const t = setInterval(loadPdfs, 1000);
    return () => clearInterval(t);
  }, [pdfs, loadPdfs]);

  const handleUpload = useCallback((file) => {
    const tempId = `tmp-${Date.now()}`;
    const entry = {
      id: tempId,
      name: file.name,
      size: formatSize(file.size),
      uploadedAt: new Date().toLocaleString(),
      status: 'uploading',
      progress: 0,
      phase: '',
      graphEnabled: buildGraph,
    };
    setPdfs(prev => [entry, ...prev]);

    const form = new FormData();
    form.append('file', file);
    form.append('buildGraph', buildGraph ? 'true' : 'false');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/pdfs`);
    xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('rag_token')}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setPdfs(prev => prev.map(x => x.id === tempId ? { ...x, progress: pct } : x));
        setUploading({ name: file.name, progress: pct });
      }
    };
    xhr.onload = () => {
      setUploading(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.pdf) {
            setPdfs(prev => prev.map(x => x.id === tempId ? { ...data.pdf, id: data.pdf.id || data.pdf._id } : x));
          }
        } catch {}
        loadPdfs();
      } else {
        setPdfs(prev => prev.filter(x => x.id !== tempId));
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        alert(msg);
      }
    };
    xhr.onerror = () => {
      setUploading(null);
      setPdfs(prev => prev.filter(x => x.id !== tempId));
      alert('Network error');
    };
    setUploading({ name: file.name, progress: 0 });
    xhr.send(form);
  }, [loadPdfs, buildGraph]);

  const removePdf = async (id) => {
    const prev = pdfs;
    setPdfs(pdfs.filter(p => (p.id || p._id) !== id));
    try {
      const res = await authFetch(`/api/pdfs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove');
    } catch (e) {
      setPdfs(prev);
      alert(e.message || 'Failed to remove PDF');
    }
  };

  const handleBuildGraph = async (id) => {
    setPdfs(prev => prev.map(p => (p.id || p._id) === id ? { ...p, status: 'indexing', phase: 'graph', progress: 0, graphEnabled: true } : p));
    try {
      const res = await authFetch(`/api/pdfs/${id}/build-graph`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start graph build');
    } catch (e) {
      setPdfs(prev => prev.map(p => (p.id || p._id) === id ? { ...p, status: 'indexed', phase: '', progress: 0, graphEnabled: false } : p));
      alert(e.message || 'Network error');
    }
  };

  const toggleDoc = (id) => {
    setSelectedDocs(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const indexedPdfs = pdfs.filter(p => p.status === 'indexed');

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <h1>Dashboard</h1>
        </div>
        <div className="dash-header-right">
          <div className="user">{user.email}</div>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => setConfirmLogout(true)}>Log out</button>
        </div>
      </header>

      <div className="grid">
        <div className="panel">
          <h2>Upload PDF</h2>
          <p className="hint">Add a PDF to your workspace. Max 25 MB, PDF only.</p>
          <UploadZone onUpload={handleUpload} />
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14,
            padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
            border: `1px solid ${buildGraph ? 'var(--accent)' : 'var(--card-border)'}`,
            background: buildGraph ? 'rgba(79,70,229,0.06)' : '#f9fafb',
            transition: 'all .15s',
          }}>
            <input type="checkbox" checked={buildGraph} onChange={e => setBuildGraph(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                Build knowledge graph
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                Extracts entities & relationships for smarter answers. Slower indexing (~3-4 min for large PDFs).
              </div>
            </div>
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
          <PdfList items={pdfs.map(p => ({ id: p.id || p._id, name: p.name, size: p.size, uploadedAt: p.uploadedAt, status: p.status, phase: p.phase, progress: p.progress, graphEnabled: p.graphEnabled }))} onRemove={removePdf} onBuildGraph={handleBuildGraph} />
        </div>
      </div>

      {indexedPdfs.length > 0 && (
        <div className="panel" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 22, marginBottom: 12 }}>Document Filter</h2>
          <p className="hint">Select which documents to search.</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setSelectedDocs([])}
              style={{
                fontSize: 13, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${selectedDocs.length === 0 ? 'var(--accent)' : 'var(--card-border)'}`,
                background: selectedDocs.length === 0 ? 'var(--accent)' : '#f3f4f6',
                color: selectedDocs.length === 0 ? '#fff' : 'var(--text)',
              }}
            >
              All
            </button>
            {indexedPdfs.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleDoc(p.id)}
                style={{
                  fontSize: 13, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${selectedDocs.includes(p.id) ? 'var(--accent)' : 'var(--card-border)'}`,
                  background: selectedDocs.includes(p.id) ? 'var(--accent)' : '#f3f4f6',
                  color: selectedDocs.includes(p.id) ? '#fff' : 'var(--text)',
                }}
              >
                {p.name}
              </button>
            ))}
            {selectedDocs.length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center', marginLeft: 4 }}>Searching all documents</span>
            )}
            {selectedDocs.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center', marginLeft: 4 }}>Searching {selectedDocs.length} document{selectedDocs.length === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 22, marginBottom: 16 }}>Chat</h2>
        <ChatPanel pdfs={pdfs.map(p => ({ id: p.id || p._id, name: p.name, status: p.status }))} selectedDocIds={selectedDocs} />
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