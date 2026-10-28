
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, CheckCircle2, Clock,
  Download, FileText, Gauge, Lightbulb, MessageSquare,
  RefreshCw, Search, Send, ShieldCheck, Sparkles, Wrench, XCircle,
} from 'lucide-react'
import { jsPDF } from 'jspdf'
import api from '../lib/api'
import './RootLensWorkspace.css'

const NAV = [
  ['dashboard', 'Dashboard', Gauge],
  ['root-cause', 'Root Cause', Search],
  ['evidence', 'Evidence Collection', FileText],
  ['report', 'Incident Report', FileText],
  ['solution', 'Solution', Wrench],
  ['feedback', 'Feedback', MessageSquare],
]

const formatDate = value => {
  if (!value) return 'Not recorded'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString('en-IN')
}

const errorMessage = error =>
  error?.response?.data?.detail ||
  error?.response?.data?.error ||
  error?.message ||
  'An unexpected error occurred.'

const eventTime = event =>
  event?.time || event?.occurred_at || event?.timestamp || event?.created_at

const eventType = event =>
  String(event?.kind || event?.event_type || event?.event_type_display || '')
    .toLowerCase()

const eventTitle = event =>
  event?.message ||
  event?.event_type_display ||
  event?.kind?.replaceAll('_', ' ') ||
  event?.event_type?.replaceAll('_', ' ') ||
  event?.description ||
  'Recorded event'

function getCandidates(analysis) {
  const items = analysis?.tree?.children || analysis?.candidates || []
  if (!Array.isArray(items)) return []
  return [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
}

function getEvents(analysis, incident) {
  if (Array.isArray(analysis?.timeline)) return analysis.timeline
  if (Array.isArray(analysis?.timeline?.events)) return analysis.timeline.events
  if (Array.isArray(analysis?.evidence)) return analysis.evidence
  if (Array.isArray(incident?.transfer_events)) return incident.transfer_events
  if (Array.isArray(incident?.evidence)) return incident.evidence
  return []
}

function getDelay(events) {
  const debit = events.find(e => eventType(e) === 'sender_debited')
  const credit = events.find(e => eventType(e) === 'receiver_credited')

  if (!debit || !credit || !eventTime(debit) || !eventTime(credit)) return null

  const start = new Date(eventTime(debit)).getTime()
  const end = new Date(eventTime(credit)).getTime()

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null

  return { start: eventTime(debit), end: eventTime(credit), ms: end - start }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(3)} seconds`
  return `${(ms / 60000).toFixed(2)} minutes`
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="rl-panel">
      <div className="rl-panel-title">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Note({ children, error = false }) {
  return (
    <div className={`rl-note ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      {error ? <XCircle size={18} /> : <AlertTriangle size={18} />}
      <span>{children}</span>
    </div>
  )
}

function Info({ label, value }) {
  return (
    <div className="rl-info">
      <span>{label}</span>
      <strong>{value === null || value === undefined || value === '' ? 'Not recorded' : String(value)}</strong>
    </div>
  )
}

function Stat({ label, value, icon: Icon }) {
  return (
    <div className="rl-stat">
      <Icon size={19} />
      <small>{label}</small>
      <strong>{value ?? '—'}</strong>
    </div>
  )
}

function EventCard({ event, index }) {
  const details = event?.details && typeof event.details === 'object'
    ? Object.entries(event.details)
    : []

  return (
    <article className="rl-timeline-event" key={event.event_id ?? event.id ?? index}>
      <div>
        <strong>{eventTitle(event)}</strong>
        <small>{formatDate(eventTime(event))}</small>
      </div>

      {event.level && <small>Level: {event.level}</small>}
      {event.service && <small>Service: {event.service}</small>}
      {event.source && <small>Source: {event.source}</small>}
      {event.event_id && <small>Event ID: {event.event_id}</small>}

      {details.length > 0 && (
        <div className="rl-event-details">
          {details.map(([key, value]) => (
            <Info
              key={key}
              label={key.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
              value={typeof value === 'object' ? JSON.stringify(value) : value}
            />
          ))}
        </div>
      )}

      {event.description && <p>{event.description}</p>}
    </article>
  )
}

export default function RootLensWorkspace({ incident, onBack, onVerify }) {
  const [page, setPage] = useState('dashboard')
  const [analysis, setAnalysis] = useState(incident?.analysis || null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [question, setQuestion] = useState('')
  const [chat, setChat] = useState([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const [rating, setRating] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')

  const incidentId = incident?.id ?? incident?.pk
  const incidentKey = incident?.incident_key || `INC-${incidentId ?? 'UNKNOWN'}`
  const title = incident?.title || 'Incident investigation'

  const events = useMemo(() => getEvents(analysis, incident), [analysis, incident])
  const candidates = useMemo(() => getCandidates(analysis), [analysis])
  const cause = analysis?.primary_cause || candidates[0] || null
  const delay = useMemo(() => getDelay(events), [events])

  const loadAnalysis = useCallback(async () => {
    if (!incidentId) {
      setAnalysisError('This incident has no database ID.')
      return
    }

    setAnalysisLoading(true)
    setAnalysisError('')

    try {
      const { data } = await api.get(`/incidents/${incidentId}/analysis/`)
      setAnalysis(previous => ({ ...(previous || {}), ...(data?.analysis || data) }))
    } catch (error) {
      setAnalysisError(errorMessage(error))
    } finally {
      setAnalysisLoading(false)
    }
  }, [incidentId])

  useEffect(() => {
    setAnalysis(incident?.analysis || null)
    setChat([])
    setQuestion('')
    setChatError('')
    setAnalysisError('')
    if (incidentId) loadAnalysis()
  }, [incidentId, incident?.analysis, loadAnalysis])

  async function askAssistant(event) {
    event.preventDefault()
    const message = question.trim()
    if (!message || chatLoading) return

    if (!incidentId) {
      setChatError('The incident ID is missing.')
      return
    }

    setChatError('')
    setChat(previous => [...previous, { role: 'user', text: message }])
    setQuestion('')
    setChatLoading(true)

    try {
      const { data } = await api.post('/chat/', {
        incident_id: incidentId,
        message,
      })

      if (!data?.answer) throw new Error('The AI endpoint returned no answer.')

      setChat(previous => [...previous, {
        role: 'assistant',
        text: data.answer,
        model: data.model || 'Ollama',
      }])
    } catch (error) {
      setChatError(errorMessage(error))
    } finally {
      setChatLoading(false)
    }
  }

  async function verify() {
    if (!onVerify || verifyLoading) return
    setVerifyError('')
    setVerifyLoading(true)
    try {
      await onVerify(incident)
    } catch (error) {
      setVerifyError(errorMessage(error))
    } finally {
      setVerifyLoading(false)
    }
  }

  function downloadReport() {
    const pdf = new jsPDF()
    const margin = 15
    const maxWidth = pdf.internal.pageSize.getWidth() - margin * 2
    let y = 20

    function write(value, size = 10) {
      pdf.setFontSize(size)
      const lines = pdf.splitTextToSize(String(value ?? 'Not recorded'), maxWidth)
      if (y + lines.length * 6 > 280) {
        pdf.addPage()
        y = 20
      }
      pdf.text(lines, margin, y)
      y += lines.length * 6 + 3
    }

    write('RootLens AI — Incident Report', 18)
    write(`Incident: ${incidentKey}`)
    write(`Title: ${title}`)
    write(`Status: ${incident?.status}`)
    write(`Severity: ${incident?.severity}`)
    write(`Fault type: ${incident?.fault_type}`)
    write(`Created: ${formatDate(incident?.created_at)}`)
    write(`Recovered: ${formatDate(incident?.recovered_at)}`)
    write(`Description: ${incident?.description}`)

    write('AI investigation summary', 14)
    write(analysis?.ai_summary || 'No AI summary was returned.')

    write('Root-cause candidates', 14)
    candidates.forEach((item, index) => {
      write(`${index + 1}. ${item.cause || 'Unnamed candidate'} — ${item.score ?? 'Unscored'}% evidence match`)
      write(`Solution: ${item.solution || 'Not provided'}`)
      write(`Supporting evidence: ${(item.supporting_evidence || []).join('; ')}`)
    })

    write('Recorded event timeline', 14)
    events.forEach((item, index) => {
      write(`${index + 1}. ${eventTitle(item)} — ${formatDate(eventTime(item))}`)
      if (item.details) {
        Object.entries(item.details).forEach(([key, value]) => write(`${key}: ${String(value)}`))
      }
    })

    write(`Measured transfer delay: ${delay ? formatDuration(delay.ms) : 'Unavailable'}`)
    write('Evidence-match scores are heuristic rankings, not calibrated probabilities.')
    pdf.save(`${incidentKey}-report.pdf`)
  }

  function submitFeedback(event) {
    event.preventDefault()
    setFeedbackMessage(
      rating && feedback.trim()
        ? 'Feedback storage is not connected to the backend yet.'
        : 'Choose a rating and enter comments.',
    )
  }

  if (!incident) {
    return (
      <div className="rl-workspace">
        <main className="rl-main">
          <Panel title="No incident selected">
            <button className="rl-primary" onClick={onBack}>Back to Admin</button>
          </Panel>
        </main>
      </div>
    )
  }

  return (
    <div className="rl-workspace">
      <aside className="rl-sidebar">
        <div className="rl-brand">
          <div className="rl-brand-icon"><Activity size={23} /></div>
          <div><strong>RootLens <span>AI</span></strong><small>INCIDENT INTELLIGENCE</small></div>
        </div>
        <div className="rl-nav-label">INVESTIGATION WORKSPACE</div>
        <nav className="rl-nav">
          {NAV.map(([id, label, Icon]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="rl-back-button" onClick={onBack}>
          <ArrowLeft size={17} /> Back to Admin
        </button>
      </aside>

      <main className="rl-main">
        <header className="rl-topbar">
          <div>
            <div className="rl-eyebrow">INCIDENT INVESTIGATION / {incidentKey}</div>
            <h1>{NAV.find(item => item[0] === page)?.[1]}</h1>
          </div>
          <span className="rl-status">{incident.status || 'UNKNOWN'}</span>
        </header>

        <div className="rl-content">
          {page === 'dashboard' && (
            <>
              <section className="rl-hero">
                <div>
                  <div className="rl-eyebrow">EVIDENCE-DRIVEN INVESTIGATION</div>
                  <h2>{title}</h2>
                  <p>{incident.description || 'Review the recorded incident evidence.'}</p>
                </div>
                <Activity size={36} />
              </section>

              <div className="rl-stats">
                <Stat label="Incident ID" value={incidentKey} icon={FileText} />
                <Stat label="Severity" value={incident.severity || 'Unknown'} icon={AlertTriangle} />
                <Stat label="Recorded events" value={events.length} icon={ShieldCheck} />
                <Stat label="Transfer delay" value={delay ? formatDuration(delay.ms) : 'Unavailable'} icon={Clock} />
              </div>

              <Panel title="Incident summary">
                <Info label="Fault type" value={incident.fault_type} />
                <Info label="Affected user" value={incident.affected_username} />
                <Info label="Created" value={formatDate(incident.created_at)} />
                <Info label="Recovered" value={formatDate(incident.recovered_at)} />
                <Info label="Transaction" value={incident.transfer_id} />
              </Panel>

              <Panel title="Ollama investigation summary" subtitle={analysis?.ai_model || 'Local AI analysis'}>
                {analysis?.ai_summary
                  ? <p>{analysis.ai_summary}</p>
                  : <Note>{analysisLoading ? 'Loading analysis…' : 'No AI summary was returned by the analysis endpoint.'}</Note>}
                {analysisError && <Note error>{analysisError}</Note>}
                {analysis?.ai_status === 'unavailable' && <Note error>{analysis.ai_error || 'Ollama is unavailable.'}</Note>}
              </Panel>

              <Panel title="Leading root-cause candidate">
                {cause ? (
                  <div className="rl-cause-card">
                    <Sparkles size={22} />
                    <div>
                      <strong>{cause.cause || 'Candidate cause'}</strong>
                      <p>Evidence-match score: {cause.score ?? 'Unscored'}%</p>
                      <p>{cause.solution || 'No solution was returned.'}</p>
                    </div>
                  </div>
                ) : <Note>No root-cause candidate is available.</Note>}
                <button className="rl-primary" onClick={() => setPage('root-cause')}>Examine root cause</button>
              </Panel>
            </>
          )}

          {page === 'root-cause' && (
            <div className="rl-columns">
              <Panel title="Ranked root-cause candidates" subtitle="Evidence-match scores are not probabilities">
                <button className="rl-secondary" onClick={loadAnalysis} disabled={analysisLoading}>
                  <RefreshCw size={15} /> Refresh analysis
                </button>
                {analysisLoading && <Note>Loading analysis…</Note>}
                {analysisError && <Note error>{analysisError}</Note>}
                {candidates.map((item, index) => (
                  <div className="rl-candidate" key={`${item.cause || 'candidate'}-${index}`}>
                    <strong>{index + 1}. {item.cause || 'Unnamed candidate'}</strong>
                    <span>{item.score ?? '—'}% match</span>
                    <div className="rl-score-track">
                      <div className="rl-score-fill" style={{ width: `${Math.max(0, Math.min(100, Number(item.score) || 0))}%` }} />
                    </div>
                    {item.supporting_evidence?.length > 0 && <>
                      <h4>Supporting evidence</h4>
                      <ul>{item.supporting_evidence.map((value, i) => <li key={i}>{value}</li>)}</ul>
                    </>}
                    {item.missing_evidence?.length > 0 && <>
                      <h4>Evidence still needed</h4>
                      <ul>{item.missing_evidence.map((value, i) => <li key={i}>{value}</li>)}</ul>
                    </>}
                    <p><b>Suggested action:</b> {item.solution || 'Not provided.'}</p>
                  </div>
                ))}
                {!analysisLoading && !candidates.length && <Note>No ranked candidates were returned.</Note>}
              </Panel>

              <Panel title="RootLens AI Assistant" subtitle="Local Ollama response through Django">
                <div className="rl-chat-messages">
                  <div className="rl-chat-bubble assistant">Ask about the recorded incident, evidence, causes, or remediation.</div>
                  {chat.map((item, index) => (
                    <div key={index} className={`rl-chat-bubble ${item.role}`}>
                      {item.text}
                      {item.model && <small>Model: {item.model}</small>}
                    </div>
                  ))}
                  {chatLoading && <div className="rl-chat-bubble assistant">Ollama is generating a response…</div>}
                </div>
                {chatError && <Note error>{chatError}</Note>}
                <form className="rl-chat-form" onSubmit={askAssistant}>
                  <input value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about this incident…" disabled={chatLoading} />
                  <button type="submit" className="rl-primary" disabled={chatLoading || !question.trim()} aria-label="Send question">
                    <Send size={17} />
                  </button>
                </form>
              </Panel>
            </div>
          )}

          {page === 'evidence' && (
            <>
              <Panel title="Recorded event timeline" subtitle="Recorded timestamps and simulator events">
                {events.length
                  ? events.map((event, index) => <EventCard key={event.event_id ?? event.id ?? index} event={event} index={index} />)
                  : <Note>No recorded events are attached to this incident.</Note>}
              </Panel>

              <Panel title="Measured transfer delay" subtitle="Calculated from recorded sender-debit and receiver-credit timestamps">
                {delay ? (
                  <>
                    <h2>{formatDuration(delay.ms)}</h2>
                    <Info label="Sender debited" value={formatDate(delay.start)} />
                    <Info label="Receiver credited" value={formatDate(delay.end)} />
                  </>
                ) : (
                  <Note>Both sender-debit and receiver-credit events with timestamps are required to calculate the delay.</Note>
                )}
              </Panel>
            </>
          )}

          {page === 'report' && (
            <Panel title="Incident report" subtitle="Download a report using the current incident records">
              <Info label="Incident" value={incidentKey} />
              <Info label="Title" value={title} />
              <Info label="Status" value={incident.status} />
              <Info label="Fault type" value={incident.fault_type} />
              <Info label="Recorded events" value={events.length} />
              <Info label="Measured delay" value={delay ? formatDuration(delay.ms) : 'Unavailable'} />
              <button className="rl-primary" onClick={downloadReport}><Download size={17} /> Download PDF report</button>
            </Panel>
          )}

          {page === 'solution' && (
            <Panel title="Solution and verification" subtitle="Review the candidate-specific recommendation">
              {cause ? (
                <div className="rl-cause-card">
                  <Wrench size={22} />
                  <div>
                    <strong>{cause.cause || 'Candidate cause'}</strong>
                    <p>{cause.solution || 'No candidate-specific solution was returned.'}</p>
                    <p><b>Verification:</b> {cause.verification || 'Validate the fix against the recorded evidence.'}</p>
                  </div>
                </div>
              ) : <Note>No root cause is established yet.</Note>}
              {cause?.missing_evidence?.length > 0 && <Note>Evidence still needed: {cause.missing_evidence.join('; ')}</Note>}
              {verifyError && <Note error>{verifyError}</Note>}
              <button className="rl-primary" onClick={verify} disabled={verifyLoading || !onVerify}>
                <CheckCircle2 size={17} /> {verifyLoading ? 'Submitting…' : 'Mark scenario verified'}
              </button>
              <p className="rl-muted">This marks the simulated incident as verified; it does not prove a production fix.</p>
            </Panel>
          )}

          {page === 'feedback' && (
            <Panel title="Investigation feedback" subtitle="Feedback is not yet saved to backend storage">
              <form className="rl-feedback-form" onSubmit={submitFeedback}>
                <label>Was this diagnosis useful?</label>
                <div className="rl-rating">
                  {[1, 2, 3, 4, 5].map(value => (
                    <button type="button" key={value} className={rating >= value ? 'selected' : ''} onClick={() => setRating(value)}>{value}</button>
                  ))}
                </div>
                <label htmlFor="rl-feedback">Comments</label>
                <textarea id="rl-feedback" value={feedback} onChange={event => setFeedback(event.target.value)} rows={5} />
                <button className="rl-primary" type="submit">Submit feedback</button>
                {feedbackMessage && <p className="rl-muted">{feedbackMessage}</p>}
              </form>
            </Panel>
          )}
        </div>
      </main>
    </div>
  )
}
