import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const res = await new Promise(r => setTimeout(() => r(login(email, password)), 400));
    setBusy(false);
    if (!res.ok) setError(res.error);
    else navigate('/dashboard');
  };

  return (
    <div className="app-shell">
      <div className="card">
        <div className="brand">
          <div className="logo">R</div>
          <div className="name">RAG Studio</div>
        </div>
        <h1>Welcome back</h1>
        <p className="subtitle">Sign in to manage your PDFs and ask questions.</p>
        {error && <div className="alert error">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••" />
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="link-row">
          No account? <Link to="/signup">Create one</Link>
        </div>
      </div>
    </div>
  );
}
