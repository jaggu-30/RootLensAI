import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Database,
  LockKeyhole,
  Network,
  RefreshCw,
  ScanSearch,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Waypoints,
  Wifi,
  X,
  ReceiptText,
  Users,
} from 'lucide-react'
import api from './lib/api'
import Sidebar from './components/Sidebar'
import IncidentModal from './components/IncidentModal'
import RootLensWorkspace from './components/RootLensWorkspace'

const faultOptions = [
  {
    id: 'delayed_credit',
    label: 'Delayed receiver credit',
    detail: 'Sender is debited before receiver confirmation arrives.',
    icon: Clock3,
  },
  {
    id: 'stale_balance',
    label: 'Stale balance display',
    detail: 'Balance view briefly shows a stale cached value.',
    icon: RefreshCw,
  },
  {
    id: 'network_timeout',
    label: 'Network timeout',
    detail: 'A simulated request times out and retries.',
    icon: Wifi,
  },
  {
    id: 'database_failure',
    label: 'Database connection failure',
    detail: 'A simulated database operation briefly fails.',
    icon: Database,
  },
  {
    id: 'duplicate_request',
    label: 'Duplicate request',
    detail: 'Repeated submission is checked by the idempotency guard.',
    icon: ShieldAlert,
  },
  {
    id: 'service_crash',
    label: 'Payment service interruption',
    detail: 'A simulated worker pauses and restarts.',
    icon: Activity,
  },
  {
    id: 'queue_backlog',
    label: 'Confirmation queue backlog',
    detail: 'Confirmation messages wait for the consumer.',
    icon: Network,
  },
  {
    id: 'bad_config',
    label: 'Bad configuration',
    detail: 'A predefined configuration increases latency.',
    icon: AlertTriangle,
  },
]

function money(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0))
}

function date(value) {
  if (!value) return '—'

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) return 'Time unavailable'

  return parsed.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/*
 * Notification classification:
 * error   -> red
 * warning -> amber
 * success -> green
 *
 * Explicit types supplied by API handlers take priority.
 */
function classifyToast(message, requestedType) {
  if (requestedType) return requestedType

  const text = String(message || '').toLowerCase()

  const errorPatterns = [
    /\berror\b/,
    /\bfailed\b/,
    /\bfailure\b/,
    /\bunable to\b/,
    /\bcould not\b/,
    /\bcannot\b/,
    /\bnot found\b/,
    /\bmissing\b/,
    /\brejected\b/,
    /\bdeclined\b/,
    /\btimeout\b/,
    /\btimed out\b/,
    /\binterrupted\b/,
    /\binvalid\b/,
    /\bunauthori[sz]ed\b/,
    /\bincident detected\b/,
    /\bfault simulated\b/,
    /\bservice issue\b/,
    /\brecovery is pending\b/,
    /\brecovery pending\b/,
    /\binsufficient balance\b/,
    /\bpayment failed\b/,
    /\btransfer failed\b/,
  ]

  if (errorPatterns.some(pattern => pattern.test(text))) {
    return 'error'
  }

  const warningPatterns = [
    /\bpending\b/,
    /\bprocessing\b/,
    /\bwarning\b/,
    /\bretry\b/,
    /\bchecking transaction\b/,
    /\binvestigating\b/,
    /\bawaiting\b/,
    /\bnot yet completed\b/,
  ]

  if (warningPatterns.some(pattern => pattern.test(text))) {
    return 'warning'
  }

  return 'success'
}

function App() {
  const [token, setToken] = useState(
    sessionStorage.getItem('rootlens_access')
  )

  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem('rootlens_user') || 'null'
      )
    } catch {
      return null
    }
  })

  const [page, setPage] = useState(
    user?.role === 'admin' ? 'overview' : 'banking'
  )

  const [dashboard, setDashboard] = useState(null)
  const [incidents, setIncidents] = useState([])
  const [selectedIncident, setSelectedIncident] = useState(null)
  const [investigation, setInvestigation] = useState(null)

  const [toast, setToast] = useState('')
  const [toastType, setToastType] = useState('success')

  const [paymentNotice, setPaymentNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const [loginForm, setLoginForm] = useState({
    username: 'demo_user',
    password: 'DemoUser123!',
  })

  const [transferForm, setTransferForm] = useState({
    receiver: '',
    amount: '100',
  })

  const [selectedFault, setSelectedFault] = useState('delayed_credit')
  const [targetUser, setTargetUser] = useState('demo_user')
  const [filter, setFilter] = useState('all')

  const seenIncidentIds = useRef(new Set())
  const admin = user?.role === 'admin'

  /*
   * All notification-producing handlers should use this function.
   * The classification effect below also handles legacy direct setToast calls.
   */
  function showToast(message, type) {
    const resolvedType = classifyToast(message, type)

    setToastType(resolvedType)
    setToast(String(message || ''))
  }

  async function refresh() {
    if (!sessionStorage.getItem('rootlens_access')) return

    try {
      const [dash, inc] = await Promise.all([
        api.get('/dashboard/'),
        api.get('/incidents/'),
      ])

      setDashboard(dash.data)
      setIncidents(inc.data)

      inc.data.forEach(item => {
        seenIncidentIds.current.add(item.id)
      })
    } catch (error) {
      if (error.response?.status === 401) {
        logout(false)
      }
    }
  }

  useEffect(() => {
    if (token && user) {
      refresh()
    }
  }, [token, user])

  useEffect(() => {
    if (!token || !user) return

    const timer = setInterval(async () => {
      try {
        const [dashResponse, incidentResponse] = await Promise.all([
          api.get('/dashboard/'),
          api.get('/incidents/'),
        ])

        setDashboard(dashResponse.data)

        const latest = incidentResponse.data

        if (user.role === 'admin') {
          const unseen = latest.find(
            item => !seenIncidentIds.current.has(item.id)
          )

          latest.forEach(item => {
            seenIncidentIds.current.add(item.id)
          })

          if (unseen) {
            showToast(`Incident detected: ${unseen.title}`, 'error')
          }

          const recovered = latest.find(item =>
            item.status === 'RECOVERED' &&
            item.recovered_at &&
            Date.now() -
              new Date(item.recovered_at).getTime() < 4500 &&
            !sessionStorage.getItem(`prompted_${item.id}`)
          )

          if (recovered) {
            sessionStorage.setItem(
              `prompted_${recovered.id}`,
              '1'
            )
            setSelectedIncident(recovered)
          }
        }

        setIncidents(latest)
      } catch {
        // Transient polling failures are retried on the next interval.
      }
    }, 2000)

    return () => clearInterval(timer)
  }, [token, user])

  /*
   * This catches messages still written with setToast(message).
   * It also changes the toast icon and colour when the classification changes.
   */
  useEffect(() => {
    if (!toast) return

    const detectedType = classifyToast(toast)

    if (detectedType !== toastType) {
      setToastType(detectedType)
    }

    const timer = setTimeout(() => {
      setToast('')
    }, 4200)

    return () => clearTimeout(timer)
  }, [toast, toastType])

  async function login(event) {
    event?.preventDefault()
    setBusy(true)

    try {
      const { data } = await api.post('/login/', loginForm)

      sessionStorage.setItem('rootlens_access', data.access)
      sessionStorage.setItem('rootlens_refresh', data.refresh)
      sessionStorage.setItem(
        'rootlens_user',
        JSON.stringify(data.user)
      )

      setToken(data.access)
      setUser(data.user)
      setPage(data.user.role === 'admin' ? 'overview' : 'banking')

      showToast(`Welcome back, ${data.user.username}.`, 'success')
    } catch (error) {
      showToast(
        error.response?.data?.detail ||
          'Could not sign in. Check that the backend is running.',
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  function logout(show = true) {
    sessionStorage.removeItem('rootlens_access')
    sessionStorage.removeItem('rootlens_refresh')
    sessionStorage.removeItem('rootlens_user')

    setToken(null)
    setUser(null)
    setDashboard(null)
    setIncidents([])
    setSelectedIncident(null)
    setInvestigation(null)
    setPage('banking')
    seenIncidentIds.current.clear()

    if (show) {
      showToast('Signed out.', 'success')
    }
  }

  async function sendMoney(event) {
    event.preventDefault()
    setBusy(true)

    try {
      const { data } = await api.post('/transfer/', {
        receiver: transferForm.receiver,
        amount: Number(transferForm.amount),
      })

      const transfer = data.transfer

      setPaymentNotice({
        status: transfer?.status || 'PENDING',
        message:
          data.message ||
          'Payment submitted. Checking transaction status…',
        transactionId: transfer?.transaction_id || '',
      })

      const transferStatus = transfer?.status || 'PENDING'

      if (transferStatus === 'FAILED') {
        showToast(
          data.message || 'Transfer failed.',
          'error'
        )
      } else if (transferStatus === 'COMPLETED') {
        showToast(
          data.message || 'Payment completed successfully.',
          'success'
        )
      } else {
        showToast(
          data.message ||
            'Payment submitted and is being processed.',
          'warning'
        )
      }

      await refresh()
    } catch (error) {
      showToast(
        error.response?.data?.detail ||
          'Transfer could not be completed.',
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  async function simulateFault(event) {
    event?.preventDefault()
    setBusy(true)

    try {
      const { data } = await api.post('/faults/simulate/', {
        fault_type: selectedFault,
        username: targetUser,
      })

      /*
       * A simulated fault is a negative event.
       * Keep this red even if the simulation endpoint itself returned HTTP 200.
       */
      showToast(
        'A temporary simulated service issue was detected. Recovery is pending.',
        'error'
      )

      if (data.incident) {
        setSelectedIncident(data.incident)
        setInvestigation(data.incident)
      }

      await refresh()
    } catch (error) {
      showToast(
        error.response?.data?.detail ||
          'Fault simulation failed.',
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  async function investigate(incident) {
    if (!admin || !incident?.id) {
      showToast(
        'Unable to investigate: incident ID is missing.',
        'error'
      )
      return
    }

    setBusy(true)

    try {
      const { data } = await api.post(
        `/incidents/${incident.id}/`
      )

      const incidentData = data.incident || data

      setInvestigation({
        ...incidentData,
        analysis: data.analysis || incidentData.analysis || null,
      })

      setSelectedIncident(null)
      setPage('rootlens')

      showToast('Incident investigation completed.', 'success')

      await refresh()
    } catch (error) {
      showToast(
        error.response?.data?.detail ||
          'Investigation failed. Check the backend server and Django logs.',
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  async function verifyIncident(incident) {
    if (!admin || !incident?.id) {
      showToast(
        'Unable to verify: incident ID is missing.',
        'error'
      )
      return
    }

    try {
      const { data } = await api.post(
        `/incidents/${incident.id}/recover/`
      )

      const updated = data.incident || data

      setInvestigation(updated)

      showToast(
        'Verification request completed for this simulated scenario.',
        'success'
      )

      await refresh()
    } catch (error) {
      showToast(
        error.response?.data?.detail ||
          'Could not verify this incident.',
        'error'
      )
    }
  }

  /*
   * RootLens investigation workspace is rendered full-screen.
   */
  if (token && user && admin && page === 'rootlens') {
    return (
      <>
        <RootLensWorkspace
          incident={investigation}
          onBack={() => setPage('incidents')}
          onVerify={verifyIncident}
        />

        {toast && (
          <ToastNotification
            message={toast}
            type={toastType}
            onClose={() => setToast('')}
          />
        )}
      </>
    )
  }

  if (!token || !user) {
    return (
      <>
        <LoginScreen
          login={login}
          form={loginForm}
          setForm={setLoginForm}
          busy={busy}
          toast={toast}
          toastType={toastType}
        />

        {toast && (
          <ToastNotification
            message={toast}
            type={toastType}
            onClose={() => setToast('')}
          />
        )}
      </>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        user={user}
        page={page}
        setPage={next => {
          setPage(next)

          if (next !== 'incidents') {
            setInvestigation(null)
          }
        }}
        onLogout={() => logout()}
      />

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="eyebrow">
              {admin
                ? 'ROOTLENS AI / OPERATIONS'
                : 'PAYNOVA / DIGITAL PAYMENTS'}
            </div>
            <h1>{pageTitle(page, admin)}</h1>
          </div>

          <div className="topbar-right">
            <span className="live-status">
              <span className="pulse-dot" />
              All systems simulated
            </span>
            <div className="avatar small">
              {user.username?.slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <div className="page-content">
          {admin && page === 'overview' && (
            <AdminOverview
              dashboard={dashboard}
              incidents={incidents}
              setPage={setPage}
              investigate={investigate}
            />
          )}

          {admin && page === 'incidents' && (
            <IncidentCenter
              incidents={incidents}
              investigation={investigation}
              setInvestigation={setInvestigation}
              filter={filter}
              setFilter={setFilter}
              investigate={investigate}
              verifyIncident={verifyIncident}
              busy={busy}
            />
          )}

          {admin && page === 'transactions' && (
            <AllTransactions
              transfers={dashboard?.transfers || []}
            />
          )}

          {admin && page === 'accounts' && (
            <AccountsPage
              accounts={dashboard?.accounts || []}
            />
          )}

          {!admin && page === 'banking' && (
            <BankingPage
              dashboard={dashboard}
              paymentNotice={paymentNotice}
              setPaymentNotice={setPaymentNotice}
              transferForm={transferForm}
              setTransferForm={setTransferForm}
              sendMoney={sendMoney}
              busy={busy}
              setPage={setPage}
            />
          )}

          {!admin && page === 'history' && (
            <TransactionHistory
              transfers={dashboard?.transfers || []}
            />
          )}
        </div>

        <footer className="app-footer">
          <span>
            {admin
              ? 'RootLens AI · Evidence-driven incident investigation'
              : 'PayNova · Simple, secure demo payments'}
          </span>
          <span>
            <LockKeyhole size={12} />
            Local sandbox · No real money moves
          </span>
        </footer>
      </main>

      {admin && (
        <IncidentModal
          incident={selectedIncident}
          onInvestigate={investigate}
          onClose={() => setSelectedIncident(null)}
        />
      )}

      {toast && (
        <ToastNotification
          message={toast}
          type={toastType}
          onClose={() => setToast('')}
        />
      )}
    </div>
  )
}

function ToastNotification({ message, type, onClose }) {
  const resolvedType = classifyToast(message, type)

  return (
    <div
      className={`toast toast-${resolvedType}`}
      role={resolvedType === 'error' ? 'alert' : 'status'}
      aria-live={resolvedType === 'error' ? 'assertive' : 'polite'}
    >
      {resolvedType === 'error' ? (
        <AlertTriangle size={17} />
      ) : resolvedType === 'warning' ? (
        <Clock3 size={17} />
      ) : (
        <Check size={17} />
      )}

      <span>{message}</span>

      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function pageTitle(page, admin) {
  const names = {
    overview: 'Operations overview',
    incidents: 'Incident center',
    transactions: 'All transactions',
    accounts: 'All user accounts',
    banking: 'My PayNova account',
    history: 'My transaction history',
  }

  return names[page] ||
    (admin ? 'Operations overview' : 'Your account')
}

function LoginScreen({
  login,
  form,
  setForm,
  busy,
  toast,
  toastType,
}) {
  const [role, setRole] = useState('user')

  function chooseRole(next) {
    setRole(next)

    setForm(
      next === 'admin'
        ? {
            username: 'admin',
            password: 'RootLensAdmin123!',
          }
        : {
            username: 'demo_user',
            password: 'DemoUser123!',
          }
    )
  }

  return (
    <div className="login-screen">
      <div className="login-glow glow-one" />
      <div className="login-glow glow-two" />

      <div className="login-left">
        <div className="brand">
          <div className="brand-mark">
            <ScanSearch size={21} />
          </div>
          <div>
            <div className="brand-name">
              {role === 'admin'
                ? <>RootLens<span> AI</span></>
                : <>PayNova</>}
            </div>
            <div className="brand-sub">
              {role === 'admin'
                ? 'INCIDENT INTELLIGENCE'
                : 'DIGITAL PAYMENTS'}
            </div>
          </div>
        </div>

        <div className="login-hero">
          <div className="eyebrow mint-text">
            <Sparkles size={14} />
            EVIDENCE-DRIVEN OPERATIONS
          </div>

          <h1>
            When systems fail,
            <br />
            <span>find the why.</span>
          </h1>

          <p>
            Simulate service failures, trace the evidence, and investigate
            the cause behind incidents that appeared to fix themselves.
          </p>

          <div className="login-proof">
            <div>
              <Activity size={17} />
              <span>Incident correlation</span>
            </div>
            <div>
              <Network size={17} />
              <span>Service-level evidence</span>
            </div>
            <div>
              <ShieldCheck size={17} />
              <span>Engineer-controlled fixes</span>
            </div>
          </div>
        </div>

        <div className="login-bottom">
          BUILT FOR INVESTIGATION · NOT GUESSWORK
        </div>
      </div>

      <div className="login-right">
        <form className="login-card" onSubmit={login}>
          <div className="eyebrow">
            {role === 'admin'
              ? 'ROOTLENS AI · ADMIN'
              : 'WELCOME TO PAYNOVA'}
          </div>

          <h2>
            {role === 'admin'
              ? 'Sign in to operations'
              : 'Sign in to your account'}
          </h2>

          <p className="muted">
            {role === 'admin'
              ? 'Monitor incidents and investigate their causes.'
              : 'Manage your demo balance and send payments.'}
          </p>

          <div className="role-switch">
            <button
              type="button"
              className={role === 'user' ? 'selected' : ''}
              onClick={() => chooseRole('user')}
            >
              <Banknote size={17} />
              Demo user
            </button>

            <button
              type="button"
              className={role === 'admin' ? 'selected' : ''}
              onClick={() => chooseRole('admin')}
            >
              <ShieldCheck size={17} />
              Admin
            </button>
          </div>

          <label>
            Username
            <input
              value={form.username}
              onChange={event =>
                setForm({
                  ...form,
                  username: event.target.value,
                })
              }
              autoComplete="username"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={event =>
                setForm({
                  ...form,
                  password: event.target.value,
                })
              }
              autoComplete="current-password"
              required
            />
          </label>

          <button
            className="button button-primary login-submit"
            disabled={busy}
          >
            {busy ? 'Signing in…' : 'Sign in securely'}
            <ChevronRight size={17} />
          </button>

          {toast && (
            <div
              className={
                toastType === 'error'
                  ? 'inline-error'
                  : toastType === 'warning'
                    ? 'inline-warning'
                    : 'inline-success'
              }
              role={toastType === 'error' ? 'alert' : 'status'}
            >
              {toast}
            </div>
          )}

          <div className="demo-credentials">
            <LockKeyhole size={14} />
            <span>
              Local demo credentials are prefilled. No real banking
              connection.
            </span>
          </div>
        </form>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'mint',
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}>
        <Icon size={19} />
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  )
}

function SectionHeading({
  title,
  subtitle,
  action,
  onAction,
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>

      {action && (
        <button
          className="text-button"
          onClick={onAction}
        >
          {action}
          <ChevronRight size={15} />
        </button>
      )}
    </div>
  )
}

function AdminOverview({
  dashboard,
  incidents,
  setPage,
  investigate,
}) {
  const active = incidents.filter(
    item =>
      item.status === 'ACTIVE' ||
      item.status === 'INVESTIGATING'
  )

  return (
    <>
      <div className="welcome-banner">
        <div>
          <div className="eyebrow mint-text">
            ADMINISTRATOR CONSOLE
          </div>
          <h2>Good to see you, operator.</h2>
          <p>
            Monitor simulated banking services and investigate
            failures with evidence.
          </p>
        </div>
        <div className="banner-icon">
          <ScanSearch size={36} />
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Total incidents"
          value={dashboard?.stats?.total_incidents ?? 0}
          sub="Recorded in sandbox"
          icon={ShieldAlert}
        />
        <StatCard
          label="Active investigations"
          value={active.length}
          sub="Require attention"
          icon={Activity}
          tone="amber"
        />
        <StatCard
          label="Recovered incidents"
          value={dashboard?.stats?.recovered_incidents ?? 0}
          sub="Evidence retained"
          icon={Check}
          tone="blue"
        />
        <StatCard
          label="Transactions"
          value={dashboard?.stats?.total_transfers ?? 0}
          sub="Simulated transfers"
          icon={CircleDollarSign}
        />
      </div>

      <div className="content-grid">
        <section className="panel">
          <SectionHeading
            title="Recent incidents"
            subtitle="Recovered incidents remain available for investigation."
            action="View incident center"
            onAction={() => setPage('incidents')}
          />
          <IncidentTable
            incidents={incidents.slice(0, 5)}
            investigate={investigate}
          />
        </section>

        <section className="panel quick-panel">
          <SectionHeading
            title="Incident monitoring"
            subtitle="Review detected incidents."
          />

          <div className="quick-feature">
            <div className="quick-feature-icon">
              <Waypoints size={22} />
            </div>
            <div>
              <strong>Incident investigation</strong>
              <p>
                Review warnings and investigate recovered incidents.
              </p>
            </div>
          </div>

          <button
            className="button button-primary full-button"
            onClick={() => setPage('incidents')}
          >
            Open incident center
            <ChevronRight size={16} />
          </button>

          <div className="mini-note">
            <ShieldCheck size={15} />
            All faults are simulated in the sandbox.
          </div>
        </section>
      </div>

      <section className="panel service-panel">
        <SectionHeading
          title="Service health"
          subtitle="Illustrative sandbox health indicators."
        />

        <div className="service-grid">
          {[
            ['Checkout API', Check],
            ['Payment worker', Activity],
            ['Transaction DB', Database],
            ['Confirmation queue', Network],
          ].map(([name, Icon]) => (
            <div className="service-item" key={name}>
              <div className="service-symbol">
                <Icon size={17} />
              </div>
              <div>
                <strong>{name}</strong>
                <small>
                  <span className="pulse-dot" />
                  Operational
                </small>
              </div>
              <span className="service-health">99.9%</span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function IncidentTable({ incidents, investigate }) {
  if (!incidents.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <Activity size={22} />
        </div>
        <strong>No incidents yet</strong>
        <p>
          Incidents appear when the simulator records a predefined issue.
        </p>
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Incident</th>
            <th>Severity</th>
            <th>Status</th>
            <th>When</th>
            <th />
          </tr>
        </thead>

        <tbody>
          {incidents.map(item => (
            <tr key={item.id}>
              <td>
                <div className="table-primary">{item.title}</div>
                <div className="table-secondary">
                  {item.incident_key} · {item.affected_username || 'System'}
                </div>
              </td>

              <td>
                <span
                  className={`severity ${String(item.severity).toLowerCase()}`}
                >
                  {item.severity}
                </span>
              </td>

              <td>
                <span
                  className={`status-pill ${String(item.status).toLowerCase()}`}
                >
                  {String(item.status).toLowerCase()}
                </span>
              </td>

              <td className="date-cell">
                {date(item.created_at)}
              </td>

              <td>
                <button
                  className="row-action"
                  onClick={() => investigate(item)}
                  aria-label={`Investigate ${item.incident_key}`}
                >
                  <ChevronRight size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IncidentCenter({
  incidents,
  investigation,
  setInvestigation,
  filter,
  setFilter,
  investigate,
  verifyIncident,
  busy,
}) {
  const shown = incidents.filter(
    item =>
      filter === 'all' ||
      String(item.status).toLowerCase() === filter
  )

  return (
    <div className="incident-layout">
      <div className="incident-list-panel panel">
        <SectionHeading
          title="All incidents"
          subtitle={`${incidents.length} incident records`}
        />

        <div className="filter-row">
          {['all', 'recovered', 'investigating', 'verified'].map(value => (
            <button
              key={value}
              className={`filter-chip ${filter === value ? 'selected' : ''}`}
              onClick={() => setFilter(value)}
            >
              {value === 'all'
                ? 'All'
                : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>

        {shown.length ? (
          <div className="incident-cards">
            {shown.map(item => (
              <button
                type="button"
                className={`incident-card ${
                  investigation?.id === item.id ? 'chosen' : ''
                }`}
                key={item.id}
                onClick={() => setInvestigation(item)}
              >
                <div className="incident-card-top">
                  <span
                    className={`severity ${String(item.severity).toLowerCase()}`}
                  >
                    {item.severity}
                  </span>
                  <span
                    className={`status-pill ${String(item.status).toLowerCase()}`}
                  >
                    {String(item.status).toLowerCase()}
                  </span>
                </div>

                <strong>{item.title}</strong>
                <p>{item.description}</p>

                <div className="incident-card-bottom">
                  <span>{item.incident_key}</span>
                  <span>{date(item.created_at)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <strong>No incidents in this filter</strong>
            <p>Try another status.</p>
          </div>
        )}
      </div>

      <div className="investigation-panel panel">
        {investigation ? (
          <>
            <div className="investigation-head">
              <div className="eyebrow">SELECTED INCIDENT</div>
              <span
                className={`status-pill ${String(investigation.status).toLowerCase()}`}
              >
                {String(investigation.status).toLowerCase()}
              </span>
            </div>

            <h2>{investigation.title}</h2>
            <p className="muted">{investigation.description}</p>

            <div className="detail-meta">
              <div>
                <small>Incident ID</small>
                <strong>{investigation.incident_key}</strong>
              </div>
              <div>
                <small>Severity</small>
                <strong>{investigation.severity}</strong>
              </div>
              <div>
                <small>Affected user</small>
                <strong>
                  {investigation.affected_username || 'System'}
                </strong>
              </div>
            </div>

            <button
              type="button"
              className="button button-primary full-button"
              onClick={() => investigate(investigation)}
              disabled={busy}
            >
              {busy ? 'Investigating…' : 'Investigate with RootLens AI'}
              <ChevronRight size={16} />
            </button>

            <div className="divider" />

            <div className="eyebrow">ROOT CAUSE HYPOTHESIS</div>

            <div className="hypothesis-box">
              <Sparkles size={18} />
              <p>
                {investigation.hypothesis ||
                  'Insufficient evidence to confirm a cause. Inspect the evidence before drawing a conclusion.'}
              </p>
            </div>

            <div className="section-heading evidence-heading">
              <div>
                <h3>Collected evidence</h3>
                <p>Events returned by the backend</p>
              </div>
              <span className="count-pill">
                {investigation.evidence?.length || 0} events
              </span>
            </div>

            <div className="evidence-list">
              {(investigation.evidence || []).map((item, index) => (
                <div className="evidence-row" key={index}>
                  <div
                    className={`evidence-level ${String(item.level || 'info').toLowerCase()}`}
                  />

                  <div className="evidence-body">
                    <div className="evidence-top">
                      <strong>{item.service || 'Service'}</strong>
                      <span>{item.time || 'Time not recorded'}</span>
                    </div>

                    <p>{item.message || JSON.stringify(item)}</p>

                    <div className="evidence-type">
                      {String(item.kind || 'event').replaceAll('_', ' ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="fix-box">
              <div className="fix-icon">
                <ShieldCheck size={19} />
              </div>
              <div>
                <strong>Engineer action required</strong>
                <p>
                  Review the evidence, apply a fix in the test environment,
                  and replay the scenario.
                </p>
              </div>
            </div>

            <button
              className="button button-primary full-button"
              onClick={() => verifyIncident(investigation)}
              disabled={investigation.status === 'VERIFIED'}
            >
              {investigation.status === 'VERIFIED'
                ? 'Scenario marked verified'
                : 'Mark fix verified'}
              <Check size={16} />
            </button>
          </>
        ) : (
          <div className="empty-investigation">
            <div className="empty-icon large">
              <Search size={25} />
            </div>
            <h3>Select an incident</h3>
            <p>
              Choose an incident to review it, then open the full
              RootLens AI workspace.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function AccountsPage({ accounts }) {
  return (
    <section className="panel">
      <SectionHeading
        title="Demo accounts"
        subtitle="Sandbox accounts and simulated balances."
      />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Phone number</th>
              <th>Account</th>
              <th>Balance</th>
              <th>Role</th>
            </tr>
          </thead>

          <tbody>
            {accounts.map(account => (
              <tr key={account.username}>
                <td>
                  <div className="table-primary">
                    {account.username}
                  </div>
                </td>
                <td>{account.phone_number || '—'}</td>
                <td>{account.account_number}</td>
                <td>{money(account.balance)}</td>
                <td>
                  <span
                    className={`status-pill ${
                      account.username === 'admin'
                        ? 'investigating'
                        : 'recovered'
                    }`}
                  >
                    {account.username === 'admin' ? 'admin' : 'user'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!accounts.length && (
          <div className="empty-state">
            <p>Accounts appear after the backend seed command runs.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function AllTransactions({ transfers }) {
  return (
    <section className="panel">
      <SectionHeading
        title="All user transactions"
        subtitle="Admin view of recorded demo transfers."
      />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Sender</th>
              <th>Sender phone</th>
              <th>Receiver</th>
              <th>Receiver phone</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>

          <tbody>
            {transfers.map(transfer => (
              <tr key={transfer.transaction_id}>
                <td>
                  <div className="table-primary">
                    {transfer.transaction_id}
                  </div>
                </td>
                <td>{transfer.sender_name}</td>
                <td>{transfer.sender_phone || '—'}</td>
                <td>{transfer.receiver_name}</td>
                <td>{transfer.receiver_phone || '—'}</td>
                <td>{money(transfer.amount)}</td>
                <td>
                  <span
                    className={`status-pill ${String(transfer.status).toLowerCase()}`}
                  >
                    {String(transfer.status).toLowerCase()}
                  </span>
                </td>
                <td className="date-cell">
                  {date(transfer.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!transfers.length && (
          <div className="empty-state">
            <p>No transactions have been recorded yet.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function BankingPage({
  dashboard,
  paymentNotice,
  setPaymentNotice,
  transferForm,
  setTransferForm,
  sendMoney,
  busy,
  setPage,
}) {
  const [recipient, setRecipient] = useState(null)

  const account = dashboard?.account
  const transfers = dashboard?.transfers || []
  const recipients = dashboard?.recipients || []

  useEffect(() => {
    if (!paymentNotice?.transactionId) return

    const latest = transfers.find(
      item => item.transaction_id === paymentNotice.transactionId
    )

    if (latest && latest.status !== paymentNotice.status) {
      setPaymentNotice(current =>
        current
          ? {
              ...current,
              status: latest.status,
              message:
                latest.status === 'COMPLETED'
                  ? 'Your payment has been completed successfully.'
                  : latest.status === 'FAILED'
                    ? 'Your payment failed.'
                    : current.message,
            }
          : current
      )
    }
  }, [dashboard, paymentNotice, transfers, setPaymentNotice])

  function chooseRecipient(member) {
    setRecipient(member)

    setTransferForm({
      ...transferForm,
      receiver: member.phone_number,
      amount: transferForm.amount || '100',
    })
  }

  async function submitPayment(event) {
    event.preventDefault()
    await sendMoney(event)
    setRecipient(null)
  }

  return (
    <>
      <div className="welcome-banner user-banner">
        <div>
          <div className="eyebrow mint-text">
            PAYNOVA · DIGITAL PAYMENTS
          </div>
          <h2>
            Good to see you, {account?.display_name || account?.username || 'there'}.
          </h2>
          <p>
            Your account, payments, and transaction history in one place.
          </p>
        </div>
        <div className="banner-icon">
          <Banknote size={36} />
        </div>
      </div>

      {paymentNotice && (
        <section
          role={paymentNotice.status === 'FAILED' ? 'alert' : 'status'}
          aria-live={paymentNotice.status === 'FAILED' ? 'assertive' : 'polite'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginBottom: 20,
            padding: '16px 18px',
            borderRadius: 16,
            border:
              paymentNotice.status === 'COMPLETED'
                ? '1px solid #34d399'
                : paymentNotice.status === 'FAILED'
                  ? '1px solid #ef4444'
                  : '1px solid #f59e0b',
            background:
              paymentNotice.status === 'COMPLETED'
                ? '#ecfdf5'
                : paymentNotice.status === 'FAILED'
                  ? '#fef2f2'
                  : '#fffbeb',
            color:
              paymentNotice.status === 'FAILED'
                ? '#991b1b'
                : '#0f172a',
          }}
        >
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 40,
              height: 40,
              borderRadius: 12,
              background: '#ffffff',
            }}
          >
            {paymentNotice.status === 'COMPLETED' ? (
              <Check size={20} />
            ) : paymentNotice.status === 'FAILED' ? (
              <AlertTriangle size={20} />
            ) : (
              <Clock3 size={20} />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>
              {paymentNotice.status === 'COMPLETED'
                ? 'Payment successful'
                : paymentNotice.status === 'FAILED'
                  ? 'Payment failed'
                  : 'Payment processing'}
            </strong>

            <p style={{ margin: '5px 0', fontSize: 14 }}>
              {paymentNotice.status === 'PENDING'
                ? 'Your transfer is being processed. Please do not send it again.'
                : paymentNotice.message}
            </p>

            {paymentNotice.transactionId && (
              <small>
                Transaction ID: {paymentNotice.transactionId}
              </small>
            )}
          </div>

          <button
            type="button"
            onClick={() => setPaymentNotice(null)}
            aria-label="Dismiss payment status"
          >
            <X size={16} />
          </button>
        </section>
      )}

      <div className="user-balance-grid">
        <div className="balance-card">
          <div className="balance-top">
            <span>Available balance</span>
            <div className="balance-symbol">
              <CircleDollarSign size={20} />
            </div>
          </div>

          <div className="balance-amount">
            {money(account?.balance)}
          </div>

          <div className="balance-account">
            <span>ACCOUNT NUMBER</span>
            <strong>{account?.account_number || 'Loading…'}</strong>
          </div>

          <div className="balance-decoration" />
        </div>

        <div className="user-info-card">
          <div className="info-icon">
            <ShieldCheck size={21} />
          </div>

          <h3>My PayNova account</h3>

          <div className="account-detail-row">
            <span>Account holder</span>
            <strong>
              {account?.display_name || account?.username || '—'}
            </strong>
          </div>

          <div className="account-detail-row">
            <span>Phone number</span>
            <strong>{account?.phone_number || '—'}</strong>
          </div>

          <div className="account-detail-row">
            <span>Account status</span>
            <strong className="mint-text">Active</strong>
          </div>

          <div className="info-foot">
            <span className="pulse-dot" />
            Demo wallet · No real money moves
          </div>
        </div>
      </div>

      <section className="panel members-panel">
        <SectionHeading
          title="Pay to number"
          subtitle={`Choose a recipient to open their payment window · ${recipients.length} members`}
        />

        <div className="member-card-grid">
          {recipients.map((member, index) => (
            <button
              type="button"
              className={`member-card ${
                recipient?.username === member.username
                  ? 'member-selected'
                  : ''
              }`}
              key={member.username}
              onClick={() => chooseRecipient(member)}
            >
              <div className={`member-avatar avatar-tone-${index % 6}`}>
                {(member.display_name || member.username)
                  .trim()
                  .charAt(0)
                  .toUpperCase()}
              </div>

              <div className="member-card-copy">
                <strong>
                  {member.display_name ||
                    member.username.replaceAll('_', ' ')}
                </strong>
                <span>{member.phone_number}</span>
                <small>
                  Pay this member
                  <ChevronRight size={13} />
                </small>
              </div>
            </button>
          ))}
        </div>
      </section>

      {recipient && (
        <div
          className="payment-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Pay ${recipient.display_name || recipient.username}`}
        >
          <section className="payment-modal panel">
            <button
              type="button"
              className="icon-button payment-modal-close"
              onClick={() => setRecipient(null)}
              aria-label="Close payment window"
            >
              <X size={18} />
            </button>

            <div className="eyebrow mint-text">
              PAYNOVA · NEW TRANSFER
            </div>

            <div className="payment-recipient-head">
              <div className="member-avatar avatar-tone-2">
                {(recipient.display_name || recipient.username)
                  .trim()
                  .charAt(0)
                  .toUpperCase()}
              </div>

              <div>
                <h2>
                  {recipient.display_name ||
                    recipient.username.replaceAll('_', ' ')}
                </h2>
                <p>{recipient.phone_number}</p>
                <small>Account {recipient.account_number}</small>
              </div>
            </div>

            <form className="send-form" onSubmit={submitPayment}>
              <label>
                Pay to number
                <input value={recipient.phone_number} readOnly />
              </label>

              <label>
                Amount
                <div className="amount-input">
                  <span>₹</span>
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    step="0.01"
                    value={transferForm.amount}
                    onChange={event =>
                      setTransferForm({
                        ...transferForm,
                        amount: event.target.value,
                      })
                    }
                    required
                    autoFocus
                  />
                </div>
              </label>

              <div className="payment-safety-note">
                <ShieldCheck size={16} />
                Secure demo transfer. Only simulated transactions are supported.
              </div>

              <button
                className="button button-primary full-button"
                disabled={busy}
              >
                {busy
                  ? 'Processing payment…'
                  : `Send ${money(transferForm.amount)}`}
                <Send size={16} />
              </button>
            </form>
          </section>
        </div>
      )}

      <section className="panel user-history-preview">
        <SectionHeading
          title="Recent transactions"
          subtitle="Your sent and received payments."
          action="View all history"
          onAction={() => setPage('history')}
        />

        <TransferList
          transfers={transfers.slice(0, 6)}
          username={account?.username}
        />
      </section>
    </>
  )
}

function TransferList({ transfers, username }) {
  if (!transfers.length) {
    return (
      <div className="empty-state compact">
        <div className="empty-icon">
          <ArrowUpRight size={20} />
        </div>
        <strong>No transactions yet</strong>
        <p>Send a demo transfer to see it here.</p>
      </div>
    )
  }

  return (
    <div className="transfer-list">
      {transfers.map(transfer => (
        <div
          className="transfer-item"
          key={transfer.transaction_id}
        >
          <div
            className={`transfer-direction ${
              transfer.status === 'COMPLETED'
                ? 'incoming'
                : 'outgoing'
            }`}
          >
            {transfer.status === 'COMPLETED' ? (
              <ArrowUpRight size={18} />
            ) : transfer.status === 'FAILED' ? (
              <AlertTriangle size={18} />
            ) : (
              <Clock3 size={18} />
            )}
          </div>

          <div className="transfer-copy">
            <strong>
              {transfer.sender_name === username
                ? `To ${transfer.receiver_name}`
                : `From ${transfer.sender_name}`}
            </strong>
            <small>
              {transfer.transaction_id} · {date(transfer.created_at)}
            </small>
          </div>

          <div className="transfer-amount">
            <strong>{money(transfer.amount)}</strong>
            <small
              className={`transfer-status ${String(transfer.status).toLowerCase()}`}
            >
              {String(transfer.status).toLowerCase()}
            </small>
          </div>
        </div>
      ))}
    </div>
  )
}

function TransactionHistory({ transfers }) {
  return (
    <section className="panel">
      <SectionHeading
        title="Transaction history"
        subtitle="Transfers associated with your demo account."
      />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Sender</th>
              <th>Receiver</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>

          <tbody>
            {transfers.map(transfer => (
              <tr key={transfer.transaction_id}>
                <td className="table-primary">
                  {transfer.transaction_id}
                </td>
                <td>{transfer.sender_name}</td>
                <td>{transfer.receiver_name}</td>
                <td>{money(transfer.amount)}</td>
                <td>
                  <span
                    className={`status-pill ${String(transfer.status).toLowerCase()}`}
                  >
                    {String(transfer.status).toLowerCase()}
                  </span>
                </td>
                <td className="date-cell">
                  {date(transfer.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!transfers.length && (
          <div className="empty-state">
            <p>No transactions recorded yet.</p>
          </div>
        )}
      </div>
    </section>
  )
}

export default App