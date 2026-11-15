export default function PdfList({ items, onRemove, onBuildGraph }) {
  if (!items.length) {
    return <div className="empty">No PDFs uploaded yet. Drop one above to get started.</div>;
  }
  return (
    <div>
      {items.map(item => {
        const isIndexing = item.status === 'indexing' || item.status === 'uploading';
        const phase = item.phase || '';
        const progress = item.progress || 0;
        const vectorDone = phase === 'graph' || phase === 'done' || progress >= 100;
        const vectorPct = phase === 'vectors' ? progress : (vectorDone ? 100 : 0);
        const graphPct = phase === 'graph' ? progress : (phase === 'done' ? 100 : 0);
        const vectorIndeterminate = isIndexing && vectorPct === 0 && phase !== 'graph' && phase !== 'done';
        const graphIndeterminate = isIndexing && (phase === 'vectors' || (phase === 'graph' && graphPct === 0));
        return (
          <div className="pdf-item" key={item.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="name">{item.name}</div>
                <div className="meta">{item.size} · {item.uploadedAt}</div>
                  {item.status === 'failed' && item.error && (
                    <div className="meta" style={{ color: 'var(--danger)' }}>{item.error}</div>
                  )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`badge ${item.status === 'indexing' ? 'uploading' : item.status}`}>{item.status}</span>
                {item.status === 'indexed' && !item.graphEnabled && (
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 10px', fontSize: 12 }} onClick={() => onBuildGraph && onBuildGraph(item.id)}>
                    Build Graph
                  </button>
                )}
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 10px' }} onClick={() => onRemove(item.id)}>Remove</button>
              </div>
            </div>
            {isIndexing && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Vector DB</span><span>{vectorPct}%</span>
                </div>
                <div className="progress-inline">
                  <div style={{
                    width: vectorIndeterminate ? '30%' : `${vectorPct}%`,
                    animation: vectorIndeterminate ? 'indeterminate 1.4s ease-in-out infinite' : 'none',
                  }} />
                </div>
                {item.graphEnabled && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                      <span>Graph DB</span><span>{graphPct}%</span>
                    </div>
                    <div className="progress-inline">
                      <div style={{
                        width: graphIndeterminate ? '30%' : `${graphPct}%`,
                        animation: graphIndeterminate ? 'indeterminate 1.4s ease-in-out infinite' : 'none',
                      }} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
