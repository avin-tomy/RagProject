import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../context/AuthContext';

export default function ChatPanel({ selectedDocIds = [] }) {
  const { authFetch, user } = useAuth();
  const storageKey = user ? `rag_chat_${user.id}` : null;
  const [messages, setMessages] = useState(() => {
    if (!storageKey) return [{ role: 'assistant', content: 'Hi! Ask me anything about your indexed PDFs.' }];
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved);
    } catch {}
    return [{ role: 'assistant', content: 'Hi! Ask me anything about your indexed PDFs.' }];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, storageKey]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const clearChat = () => {
    const initial = [{ role: 'assistant', content: 'Hi! Ask me anything about your indexed PDFs.' }];
    setMessages(initial);
    if (storageKey) localStorage.removeItem(storageKey);
  };

  // Clear conversation when the document filter changes, so answers
  // don't mix context from different documents.
  const prevDocsRef = useRef(selectedDocIds);
  useEffect(() => {
    const prev = prevDocsRef.current;
    const changed = prev.join(',') !== selectedDocIds.join(',');
    prevDocsRef.current = selectedDocIds;
    if (changed && messages.length > 1) {
      setMessages([{ role: 'assistant', content: 'Hi! Ask me anything about your indexed PDFs.' }]);
    }
  }, [selectedDocIds]);

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
        body: JSON.stringify({ question: q, history: next.slice(0, -1), documentIds: selectedDocIds.length ? selectedDocIds : undefined }),
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

  function SafeMarkdown({ content }) {
    try {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
    } catch {
      return <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>;
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>Chat</h2>
        <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }} onClick={clearChat} disabled={messages.length <= 1}>
          Clear Chat
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
                : <SafeMarkdown content={m.content} />}
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
            border: '1px solid var(--card-border)', background: '#fff',
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
