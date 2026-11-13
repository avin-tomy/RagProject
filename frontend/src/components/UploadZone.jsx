import { useState, useRef, useCallback } from 'react';

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

export default function UploadZone({ onUpload }) {
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleFiles = useCallback((files) => {
    setError('');
    const file = files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are allowed.');
      return;
    }
    if (file.size > MAX_SIZE) {
      setError(`File too large. Maximum size is ${MAX_SIZE / 1024 / 1024} MB.`);
      return;
    }
    onUpload(file);
  }, [onUpload]);

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <div className="icon">📄</div>
        <div className="title">Drop a PDF here or click to browse</div>
        <div className="sub">PDF only · up to 25 MB</div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
