import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../context/AuthContext';

export default function ChatPanel({ pdfs = [] }) {
  const { authFetch } = useAuth();
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! Ask me anything about your indexed PDFs.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedDocs, setSelectedDocs] = useState([]);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const exportChat = () => {
    const md = messages.map(m => {
      const role = m.role === 'user' ? '**You**' : '**Assistant**';
      return `${role}:\n\n${m.content}`;
    }).join('\n\n---\n\n');
    const blob = new Blob([`# Chat Export\n\n${md}\n`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleDoc = (id) => {
    setSelectedDocs(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const send = async (e) => {
    e?.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setError('');
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await authFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history: next.slice(0, -1), documentIds: selectedDocs.length ? selectedDocs : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Query failed');
      setMessages(data.history || [...next, { role: 'assistant', content: data.answer }]);
    } catch (err) {
      setError(err.message);
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const indexedPdfs = pdfs.filter(p => p.status === 'indexed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {indexedPdfs.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setSelectedDocs([])}
                style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
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
                    fontSize: 12, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${selectedDocs.includes(p.id) ? 'var(--accent)' : 'var(--card-border)'}`,
                    background: selectedDocs.includes(p.id) ? 'var(--accent)' : '#f3f4f6',
                    color: selectedDocs.includes(p.id) ? '#fff' : 'var(--text)',
                  }}
                >
                  {p.name}
                </button>
              ))}
            </>
          )}
          {indexedPdfs.length > 0 && selectedDocs.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>Searching all documents</span>
          )}
          {indexedPdfs.length > 0 && selectedDocs.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>Searching {selectedDocs.length} document{selectedDocs.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }} onClick={exportChat} disabled={messages.length <= 1}>
          Export
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: 6, minHeight: 260 }} className="md-body">
        {messages.map((m, i) => (
          <div key={i} style={{
            marginBottom: 12,
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            <div className="md" style={{
              maxWidth: '82%',
              padding: '10px 14px',
              borderRadius: 12,
              background: m.role === 'user' ? 'var(--accent)' : '#f3f4f6',
              border: m.role === 'user' ? 'none' : '1px solid var(--card-border)',
              color: m.role === 'user' ? '#fff' : 'var(--text)',
              fontSize: 14,
              lineHeight: 1.5,
            }}>
              {m.role === 'user'
                ? m.content
                : <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>}
            </div>
          </div>
        ))}
        {busy && <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>Thinking…</div>}
        <div ref={endRef} />
      </div>

      {error && <div className="alert error" style={{ marginTop: 8 }}>{error}</div>}

      <form onSubmit={send} style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask a question about your PDFs…"
          disabled={busy}
          style={{
            flex: 1, padding: '12px 14px', borderRadius: 10,
            border: '1px solid var(--card-border)', background: 'rgba(0,0,0,0.25)',
            color: 'var(--text)', fontSize: 15, outline: 'none',
          }}
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()} style={{ width: 'auto', padding: '12px 20px' }}>
          Send
        </button>
      </form>
    </div>
  );
}
