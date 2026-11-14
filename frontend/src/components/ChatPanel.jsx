import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { jsPDF } from 'jspdf';
import { useAuth } from '../context/AuthContext';

function SafeMarkdown({ content }) {
  try {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
  } catch (e) {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>;
  }
}

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
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    const pageWidth = doc.internal.pageSize.getWidth();
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    doc.setFontSize(16);
    doc.text('Chat Export', margin, y);
    y += 24;
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(new Date().toLocaleString(), margin, y);
    y += 20;
    doc.setTextColor(0);

    for (const m of messages) {
      const role = m.role === 'user' ? 'You' : 'Assistant';
      doc.setFontSize(11);
      doc.setFont(undefined, 'bold');
      doc.text(role, margin, y);
      y += 16;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(10);

      // strip markdown symbols for readability
      const clean = m.content
        .replace(/\*\*/g, '')
        .replace(/#{1,6}\s*/g, '')
        .replace(/`{1,3}/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

      const lines = doc.splitTextToSize(clean, maxWidth);
      for (const line of lines) {
        if (y > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(line, margin, y);
        y += 14;
      }
      y += 10;
    }

    doc.save(`chat-export-${new Date().toISOString().slice(0, 10)}.pdf`);
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
        <button className="btn" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={exportChat} disabled={messages.length <= 1}>
          Export PDF
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
