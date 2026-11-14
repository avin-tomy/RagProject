import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ChatPanel from '../components/ChatPanel';

const API = '';

export default function Chat() {
  const { user, logout, authFetch } = useAuth();
  const navigate = useNavigate();
  const [pdfs, setPdfs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('/api/pdfs');
        const data = await res.json();
        if (res.ok) setPdfs((data.pdfs || []).map(p => ({ id: p.id || p._id, name: p.name, status: p.status })));
      } catch {}
    })();
  }, [authFetch]);

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <h1>Chat</h1>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={logout}>Log out</button>
        </div>
      </header>
      <div className="panel" style={{ height: 'calc(100vh - 160px)' }}>
        <ChatPanel pdfs={pdfs} />
      </div>
    </div>
  );
}
