import { Activity, Banknote, CircleHelp, LayoutDashboard, LogOut, ScanSearch, Users, ReceiptText } from 'lucide-react'
export default function Sidebar({ user, page, setPage, onLogout }) {
  const admin = user?.role === 'admin'
  const items = admin ? [
    ['overview', 'Overview', LayoutDashboard], ['transactions', 'All transactions', ReceiptText], ['incidents', 'Incident center', Activity], ['accounts', 'All accounts', Users],
  ] : [['banking', 'My account', Banknote], ['history', 'Transactions', Activity]]
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><ScanSearch size={21}/></div><div><div className="brand-name">{admin ? <>RootLens<span> AI</span></> : <>PayNova</>}</div><div className="brand-sub">{admin ? 'INCIDENT INTELLIGENCE' : 'DIGITAL PAYMENTS'}</div></div></div>
    <div className="workspace-label">WORKSPACE</div>
    <nav className="side-nav">{items.map(([id, label, Icon]) => <button key={id} onClick={() => setPage(id)} className={`nav-item ${page === id ? 'active' : ''}`}><Icon size={18}/><span>{label}</span>{id === 'incidents' && <span className="nav-dot"/>}</button>)}</nav>
    <div className="sidebar-bottom"><div className="environment"><span className="pulse-dot"/><div><strong>Sandbox environment</strong><small>Predefined faults only</small></div></div><button className="nav-item" onClick={() => setPage(admin ? 'incidents' : 'history')}><CircleHelp size={18}/><span>Activity & help</span></button><div className="profile"><div className="avatar">{user?.username?.slice(0,1).toUpperCase() || 'R'}</div><div className="profile-copy"><strong>{user?.username}</strong><small>{admin ? 'Administrator' : 'Demo user'}</small></div><button className="logout-button" onClick={onLogout} title="Sign out"><LogOut size={17}/></button></div></div>
  </aside>
}
