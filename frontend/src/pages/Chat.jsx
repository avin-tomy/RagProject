import { useAuth } from '../context/AuthContext';
import ChatPanel from '../components/ChatPanel';
import { useNavigate } from 'react-router-dom';

export default function Chat() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <h1>Chat</h1>
          <div className="user">Ask questions about your indexed PDFs</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button className="btn btn-ghost" style={{ width: 'auto' }} onClick={logout}>Log out</button>
        </div>
      </header>
      <div className="panel" style={{ height: 'calc(100vh - 160px)' }}>
        <ChatPanel />
      </div>
    </div>
  );
}
