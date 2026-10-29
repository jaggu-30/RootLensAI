
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, CheckCircle2, Clock,
  Download, FileText, Gauge, Lightbulb, MessageSquare,
  Network, RefreshCw, Search, Send, ShieldCheck, Sparkles,
  Wrench, XCircle,
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

const money = value =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0))

const date = value => {
  if (!value) return 'Not recorded'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString('en-IN')
}

const errorText = error =>
  error?.response?.data?.detail ||
  error?.response?.data?.error ||
  error?.response?.data?.message ||
  error?.message ||
  'An unexpected error occurred.'

const incidentIdOf = incident => incident?.id ?? incident?.pk ?? null

const evidenceOf = incident =>
  Array.isArray(incident?.evidence) ? incident.evidence : []

const timelineOf = (analysis, incident) => {
  const events = analysis?.timeline
  if (Array.isArray(events)) return events
  if (Array.isArray(events?.events)) return events.events
  if (Array.isArray(incident?.transfer_events)) return incident.transfer_events
  return evidenceOf(incident)
}

const eventName = event =>
  event?.message ||
  event?.event_type_display ||
  event?.kind ||
  event?.event_type ||
  event?.description ||
  'Recorded event'

const eventTime = event =>
  event?.time || event?.occurred_at || event?.timestamp || event?.created_at

const eventDetails = event => {
  if (event?.details && typeof event.details === 'object') {
    return Object.entries(event.details)
      .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`)
      .join(' · ')
  }
  return event?.description || event?.detail || ''
}

function candidatesOf(analysis) {
  const candidates = analysis?.tree?.children
    || analysis?.candidates
    || analysis?.root_causes
    || []

  if (!Array.isArray(candidates)) return []

  return [...candidates].sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0),
  )
}

function measuredDelay(events) {
  const find = names => events.find(event => {
    const name = String(
      event?.kind || event?.event_type || event?.event_type_display || '',
    ).toLowerCase()
    return names.some(item => name.includes(item))
  })

  const debit = find(['sender_debited', 'sender debited'])
  const credit = find(['receiver_credited', 'receiver credited'])
  const debitTime = eventTime(debit)
  const creditTime = eventTime(credit)

  if (!debitTime || !creditTime) return null

  const start = new Date(debitTime).getTime()
  const end = new Date(creditTime).getTime()

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null
  }

  return {
    start: debitTime,
    end: creditTime,
    milliseconds: end - start,
  }
}

function duration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds} ms`
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(2)} seconds`
  return `${(milliseconds / 60000).toFixed(2)} minutes`
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

function Stat({ label, value, icon: Icon = Activity }) {
  return (
    <div className="rl-stat">
      <Icon size={19} />
      <small>{label}</small>
      <strong>{value ?? '—'}</strong>
    </div>
  )
}

export default function RootLensWorkspace({ incident, onBack, onVerify }) {
  const [page, setPage] = useState('dashboard')
  const [analysis, setAnalysis] = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [question, setQuestion] = useState('')
  const [chat, setChat] = useState([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [verificationError, setVerificationError] = useState('')
  const [rating, setRating] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')

  const incidentId = incidentIdOf(incident)
  const evidence = useMemo(() => evidenceOf(incident), [incident])
  const timeline = useMemo(
    () => timelineOf(analysis, incident),
    [analysis, incident],
  )
  const candidates = useMemo(() => candidatesOf(analysis), [analysis])
  const primaryCause = analysis?.primary_cause || candidates[0] || null
  const incidentKey = incident?.incident_key || `INC-${incidentId ?? 'PENDING'}`
  const title = incident?.title || 'Incident investigation'

  const loadAnalysis = useCallback(async () => {
    if (!incidentId) {
      setAnalysisError('This incident has no database ID.')
      return
    }

    setAnalysisLoading(true)
    setAnalysisError('')

    try {
      const { data } = await api.get(`/incidents/${incidentId}/analysis/`)
      setAnalysis(data?.analysis || data)
    } catch (error) {
      setAnalysisError(errorText(error))
    } finally {
      setAnalysisLoading(false)
    }
  }, [incidentId])

  useEffect(() => {
    setAnalysis(null)
    setChat([])
    setChatError('')
    setAnalysisError('')
    setQuestion('')

    if (incidentId) loadAnalysis()
  }, [incidentId, loadAnalysis])

  async function askAssistant(event) {
    event.preventDefault()
    const message = question.trim()

    if (!message || chatLoading) return

    if (!incidentId) {
      setChatError('Select an incident with a valid database ID.')
      return
    }

    setChatError('')
    setChat(previous => [...previous, { role: 'user', text: message }])
    setQuestion('')
    setChatLoading(true)

    try {
      // Django config/urls.py defines POST /api/chat/.
      const { data } = await api.post('/chat/', {
        incident_id: incidentId,
        message,
      })

      if (!data?.answer) {
        throw new Error('The chat endpoint returned no answer.')
      }

      setChat(previous => [
        ...previous,
        {
          role: 'assistant',
          text: data.answer,
          model: data.model || 'Ollama',
        },
      ])
    } catch (error) {
      setChatError(errorText(error))
    } finally {
      setChatLoading(false)
    }
  }

  async function verifyIncident() {
    if (!incident || !onVerify || verificationLoading) return

    setVerificationError('')
    setVerificationLoading(true)

    try {
      await onVerify(incident)
    } catch (error) {
      setVerificationError(errorText(error))
    } finally {
      setVerificationLoading(false)
    }
  }

  function downloadReport() {
    const pdf = new jsPDF()
    const margin = 15
    const maxWidth = pdf.internal.pageSize.getWidth() - margin * 2
    let y = 20

    const write = (value, size = 10) => {
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
    write(`Status: ${incident?.status || 'Unknown'}`)
    write(`Severity: ${incident?.severity || 'Unknown'}`)
    write(`Fault type: ${incident?.fault_type || 'Not recorded'}`)
    write(`Created: ${date(incident?.created_at)}`)
    write(`Recovered: ${date(incident?.recovered_at)}`)
    write(`Description: ${incident?.description || 'Not recorded'}`)
    write(`Assessment: ${incident?.hypothesis || analysis?.hypothesis || 'Not established'}`)

    if (primaryCause) {
      write(`Leading candidate: ${primaryCause.cause || 'Not named'}`)
      write(`Relative ranking share: ${primaryCause.ranking_share ?? 'Unavailable'}%`)
      write(`Supporting evidence: ${(primaryCause.supporting_evidence || []).join('; ') || 'None listed'}`)
      write(`Missing evidence: ${(primaryCause.missing_evidence || []).join('; ') || 'None listed'}`)
      write(`Suggested solution: ${primaryCause.solution || 'Not provided'}`)
    }

    write('Recorded event timeline', 14)
    if (timeline.length) {
      timeline.forEach((item, index) => {
        write(`${index + 1}. ${eventName(item)} | ${date(eventTime(item))} | ${eventDetails(item)}`)
      })
    } else {
      write('No event timeline was returned.')
    }

    write('Evidence', 14)
    evidence.forEach((item, index) => {
      write(`${index + 1}. ${typeof item === 'string' ? item : JSON.stringify(item)}`)
    })

    write('Scores are heuristic evidence-match rankings, not calibrated probabilities.')
    pdf.save(`${incidentKey}-incident-report.pdf`)
  }

  function submitFeedback(event) {
    event.preventDefault()
    setFeedbackMessage(
      rating && feedback.trim()
        ? 'Feedback is not connected to backend storage yet.'
        : 'Select a rating and enter comments.',
    )
  }

  if (!incident) {
    return (
      <div className="rl-workspace">
        <main className="rl-main">
          <Panel title="No incident selected">
            <p>Select an incident from the admin incident center.</p>
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
                  <p>{incident.description || 'Review the recorded incident evidence and investigate the likely cause.'}</p>
                </div>
                <Activity size={36} />
              </section>

              <div className="rl-stats">
                <Stat label="Incident ID" value={incidentKey} icon={FileText} />
                <Stat label="Severity" value={incident.severity || 'Unknown'} icon={AlertTriangle} />
                <Stat label="Evidence items" value={evidence.length} icon={ShieldCheck} />
                <Stat label="Timeline events" value={timeline.length} icon={Clock} />
              </div>

              <Panel title="Incident summary" subtitle="Values from the incident record">
                <Info label="Fault type" value={incident.fault_type} />
                <Info label="Affected user" value={incident.affected_username} />
                <Info label="Created" value={date(incident.created_at)} />
                <Info label="Recovered" value={date(incident.recovered_at)} />
                <Info label="Transaction" value={incident.transfer_id} />
              </Panel>

              <Panel title="Root-cause assessment" subtitle="Ranked candidates from the analysis endpoint">
                {analysisLoading && <Note>Loading analysis…</Note>}
                {analysisError && <Note error>{analysisError}</Note>}
                {primaryCause && (
                  <div className="rl-cause-card">
                    <Sparkles size={22} />
                    <div>
                      <strong>{primaryCause.cause || 'Leading candidate'}</strong>
                      <p>Relative ranking share: {primaryCause.ranking_share ?? 'Unavailable'}%</p>
                      <p>{primaryCause.solution || 'Review the supporting evidence before applying a fix.'}</p>
                    </div>
                  </div>
                )}
                <button className="rl-primary" onClick={() => setPage('root-cause')}>
                  Examine root cause
                </button>
              </Panel>
            </>
          )}

          {page === 'root-cause' && (
            <div className="rl-root-layout">
              <Panel title="Root-cause tree" subtitle="Every issue below comes from this incident's analysis response">
                <div className="rl-root-toolbar">
                  <div className="rl-root-status">{candidates.length} issue{candidates.length === 1 ? '' : 's'} returned by analysis</div>
                  <button className="rl-secondary" onClick={loadAnalysis} disabled={analysisLoading}>
                    <RefreshCw size={15} /> {analysisLoading ? 'Refreshing…' : 'Refresh analysis'}
                  </button>
                </div>
                {analysisLoading && <Note>Loading root-cause analysis…</Note>}
                {analysisError && <Note error>{analysisError}</Note>}
                {analysis?.score_warning && <Note>{analysis.score_warning}</Note>}

                {primaryCause && (
                  <div className="rl-tree-root-wrap">
                    <div className="rl-tree-root">
                      <div className="rl-tree-root-kicker"><Lightbulb size={16} /> LEADING ROOT-CAUSE HYPOTHESIS</div>
                      <h3>{primaryCause.cause || primaryCause.name || primaryCause.title || 'Cause not named by analysis'}</h3>
                      <div className="rl-tree-root-meta">
                        <span>{(primaryCause.ranking_share ?? primaryCause.score) == null ? 'Score not provided' : `${primaryCause.ranking_share ?? primaryCause.score}% ranking share`}</span>
                        <span>{primaryCause.confidence == null ? 'Confidence not provided' : `${primaryCause.confidence}% confidence`}</span>
                      </div>
                      {primaryCause.solution && <p>{primaryCause.solution}</p>}
                    </div>
                    {candidates.filter(candidate => candidate !== primaryCause &&
                      (candidate.cause || candidate.name || candidate.title) !==
                      (primaryCause.cause || primaryCause.name || primaryCause.title)).length > 0 && (
                      <div className="rl-tree-branch-stem" aria-hidden="true" />
                    )}
                  </div>
                )}

                {(() => {
                  const issues = candidates.filter(candidate => candidate !== primaryCause &&
                    (candidate.cause || candidate.name || candidate.title) !==
                    (primaryCause?.cause || primaryCause?.name || primaryCause?.title))
                  return issues.length > 0 ? (
                    <div className="rl-issue-grid">
                      {issues.map((issue, index) => {
                        const name = issue.cause || issue.name || issue.title || `Issue ${index + 1}`
                        const score = issue.ranking_share ?? null
                        const evidence = issue.supporting_evidence || issue.evidence || []
                        const missing = issue.missing_evidence || issue.evidence_needed || []
                        const solution = issue.solution || issue.recommendation || issue.remediation
                        const numericScore = score == null ? NaN : Number(score)
                        const safeScore = Number.isFinite(numericScore) ? Math.max(0, Math.min(100, numericScore)) : null
                        return (
                          <article className="rl-issue-card" key={`${name}-${index}`}>
                            <div className="rl-issue-card-top">
                              <span className="rl-issue-index">{String(index + 1).padStart(2, '0')}</span>
                              <span className="rl-issue-score">{score == null ? 'Unscored' : `${score}% ranking share`}</span>
                            </div>
                            <h3>{name}</h3>
                            {issue.description && <p className="rl-issue-description">{issue.description}</p>}
                            <div className="rl-issue-progress"><span style={{ width: safeScore == null ? '0%' : `${safeScore}%` }} /></div>
                            <div className="rl-issue-evidence">
                              <strong>Supporting evidence</strong>
                              {Array.isArray(evidence) && evidence.length > 0
                                ? <ul>{evidence.map((item, i) => <li key={i}>{typeof item === 'string' ? item : item.message || item.description || JSON.stringify(item)}</li>)}</ul>
                                : <p>No supporting evidence was returned for this issue.</p>}
                            </div>
                            {Array.isArray(missing) && missing.length > 0 && (
                              <div className="rl-issue-evidence rl-issue-missing">
                                <strong>Evidence still needed</strong>
                                <ul>{missing.map((item, i) => <li key={i}>{typeof item === 'string' ? item : item.message || item.description || JSON.stringify(item)}</li>)}</ul>
                              </div>
                            )}
                            {solution && <div className="rl-issue-solution"><strong>Suggested check</strong><p>{solution}</p></div>}
                          </article>
                        )
                      })}
                    </div>
                  ) : !analysisLoading && !analysisError && candidates.length > 0 ? (
                    <Note>Only one root-cause candidate was returned. The backend did not provide alternative issues to display.</Note>
                  ) : null
                })()}

                {!analysisLoading && !analysisError && candidates.length === 0 && (
                  <Note>No issue candidates were returned by the backend for this incident. Check the analysis API response; the interface will not invent issues.</Note>
                )}

                <ConfidenceComparisonGraph candidates={candidates} primaryCause={primaryCause} />
                <EvidenceComparisonGraph candidates={candidates} />
              </Panel>

              <Panel title="RootLens AI Assistant" subtitle="Answers are generated by the Django chat endpoint">
                <div className="rl-chat-messages">
                  <div className="rl-chat-bubble assistant">
                    Ask about {incidentKey}, the evidence, the suspected cause, or possible remediation.
                  </div>
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
                  <input value={question} onChange={event => setQuestion(event.target.value)}
                    placeholder="Ask why this incident happened…" disabled={chatLoading} />
                  <button className="rl-primary" disabled={chatLoading || !question.trim()} aria-label="Send question">
                    <Send size={17} />
                  </button>
                </form>
              </Panel>
            </div>
          )}

          {page === 'evidence' && (
            <>
              <EvidenceSignalDistribution evidence={evidence} />
              <Panel title="Recorded event timeline" subtitle="Only timestamps returned by the backend are shown">
                {timeline.length ? timeline.map((item, index) => (
                  <div className="rl-timeline-event" key={item.event_id ?? item.id ?? index}>
                    <div><strong>{eventName(item)}</strong><small>{date(eventTime(item))}</small></div>
                    {eventDetails(item) && <p>{eventDetails(item)}</p>}
                  </div>
                )) : <Note>No structured timeline was returned. No timestamps have been invented.</Note>}
              </Panel>
              <Panel title="Measured transfer delay" subtitle="Requires sender-debit and receiver-credit timestamps">
                {(() => {
                  const delay = measuredDelay(timeline)
                  return delay
                    ? <><h2>{duration(delay.milliseconds)}</h2><Info label="Sender debited" value={date(delay.start)} /><Info label="Receiver credited" value={date(delay.end)} /></>
                    : <Note>Both sender-debit and receiver-credit timestamps are required to calculate a delay.</Note>
                })()}
              </Panel>
              <Panel title="Raw recorded evidence">
                {evidence.length ? evidence.map((item, index) => (
                  <pre className="rl-evidence" key={index}>{typeof item === 'string' ? item : JSON.stringify(item, null, 2)}</pre>
                )) : <Note>No structured evidence is attached.</Note>}
              </Panel>
            </>
          )}

          {page === 'report' && (
            <>
            <TimelineEvidenceGraph timeline={timeline} evidence={evidence} />
            <RecoveryDurationGraph timeline={timeline} />
            <Panel title="Incident report" subtitle="Download a report from the currently returned incident data">
              <Info label="Incident" value={incidentKey} />
              <Info label="Title" value={title} />
              <Info label="Status" value={incident.status} />
              <Info label="Fault type" value={incident.fault_type} />
              <Info label="Created" value={date(incident.created_at)} />
              <Info label="Hypothesis" value={incident.hypothesis || analysis?.hypothesis || 'Not established'} />
              {primaryCause && <Info label="Leading candidate" value={`${primaryCause.cause} (${primaryCause.ranking_share ?? primaryCause.score ?? 'unscored'}% ranking share)`} />}
              <button className="rl-primary" onClick={downloadReport}><Download size={17} /> Download PDF report</button>
            </Panel>
            </>
          )}

          {page === 'solution' && (
            <div className="rl-solution-page">
              <Panel
                title="Solution and verification"
                subtitle="Issue-specific remediation based on the current incident analysis"
              >
                <div className="rl-root-toolbar">
                  <div className="rl-root-status">
                    {candidates.length} candidate{candidates.length === 1 ? '' : 's'} available for remediation
                  </div>
                  <button className="rl-secondary" onClick={loadAnalysis} disabled={analysisLoading}>
                    <RefreshCw size={15} /> {analysisLoading ? 'Refreshing…' : 'Refresh analysis'}
                  </button>
                </div>

                {analysisLoading && <Note>Loading incident analysis and recommended solutions…</Note>}
                {analysisError && <Note error>{analysisError}</Note>}
                {verificationError && <Note error>{verificationError}</Note>}

                {!analysisLoading && !analysisError && candidates.length === 0 && (
                  <Note>No root-cause candidates were returned. Refresh the analysis before choosing a fix; no issue or solution has been invented.</Note>
                )}

                {candidates.map((candidate, index) => {
                  const name = candidate.cause || candidate.name || candidate.title || `Candidate ${index + 1}`
                  const isPrimary = candidate === primaryCause || (
                    primaryCause && name === (primaryCause.cause || primaryCause.name || primaryCause.title)
                  )
                  const score = candidate.score ?? candidate.evidence_match_score ?? null
                  const numericScore = score == null ? NaN : Number(score)
                  const safeScore = score != null && Number.isFinite(numericScore)
                    ? Math.max(0, Math.min(100, numericScore))
                    : null
                  const supporting = candidate.supporting_evidence ?? candidate.evidence ?? []
                  const missing = candidate.missing_evidence ?? candidate.evidence_needed ?? []
                  const solution = candidate.solution || candidate.recommendation || candidate.remediation || ''
                  const verification = candidate.verification || candidate.verification_steps || candidate.validation || ''
                  const asList = value => Array.isArray(value) ? value : value ? [value] : []
                  const supportingItems = asList(supporting)
                  const missingItems = asList(missing)
                  const verificationItems = asList(verification)

                  return (
                    <article className={`rl-issue-card rl-solution-card ${isPrimary ? 'is-primary' : ''}`} key={`${name}-${index}`}>
                      <div className="rl-issue-card-top">
                        <span className="rl-issue-index">{String(index + 1).padStart(2, '0')}</span>
                        <div className="rl-solution-card-badges">
                          {isPrimary && <span className="rl-solution-primary-label">LEADING CANDIDATE</span>}
                          <span className="rl-issue-score">{score == null ? 'Score unavailable' : `${score}% evidence match`}</span>
                        </div>
                      </div>
                      <h3>{name}</h3>
                      {candidate.description && <p className="rl-issue-description">{candidate.description}</p>}
                      {safeScore != null && (
                        <div className="rl-issue-progress" aria-label={`Evidence match ${safeScore}%`}>
                          <span style={{ width: `${safeScore}%` }} />
                        </div>
                      )}

                      <div className="rl-issue-solution">
                        <strong><Wrench size={15} /> Recommended remediation</strong>
                        <p>{solution || 'No candidate-specific remediation was returned by the backend. Review the evidence and determine a fix before taking action.'}</p>
                      </div>

                      {verificationItems.length > 0 && (
                        <div className="rl-issue-evidence rl-solution-verification">
                          <strong><CheckCircle2 size={15} /> Verification steps</strong>
                          <ul>{verificationItems.map((item, i) => (
                            <li key={i}>{typeof item === 'string' ? item : item?.description || item?.step || item?.message || JSON.stringify(item)}</li>
                          ))}</ul>
                        </div>
                      )}

                      <div className="rl-issue-evidence">
                        <strong>Supporting evidence</strong>
                        {supportingItems.length > 0 ? (
                          <ul>{supportingItems.map((item, i) => (
                            <li key={i}>{typeof item === 'string' ? item : item?.message || item?.description || JSON.stringify(item)}</li>
                          ))}</ul>
                        ) : <p>No supporting evidence was returned for this candidate.</p>}
                      </div>

                      {missingItems.length > 0 && (
                        <div className="rl-issue-evidence rl-issue-missing">
                          <strong>Evidence still needed</strong>
                          <ul>{missingItems.map((item, i) => (
                            <li key={i}>{typeof item === 'string' ? item : item?.message || item?.description || JSON.stringify(item)}</li>
                          ))}</ul>
                        </div>
                      )}
                    </article>
                  )
                })}

                <div className="rl-solution-verification-footer">
                  <div>
                    <strong>Scenario verification</strong>
                    <p className="rl-muted">This action records the simulated incident as verified. It does not establish that a production fix has been proven.</p>
                  </div>
                  <button className="rl-primary" onClick={verifyIncident} disabled={verificationLoading || !onVerify}>
                    <CheckCircle2 size={17} /> {verificationLoading ? 'Verifying…' : 'Mark scenario verified'}
                  </button>
                </div>
              </Panel>
            </div>
          )}

          {page === 'feedback' && (
            <Panel title="Investigation feedback" subtitle="Feedback is currently kept in this browser session only">
              <form className="rl-feedback-form" onSubmit={submitFeedback}>
                <label>Was this diagnosis useful?</label>
                <div className="rl-rating">
                  {[1, 2, 3, 4, 5].map(value => (
                    <button type="button" key={value} className={rating >= value ? 'selected' : ''}
                      onClick={() => setRating(value)}>{value}</button>
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


function ConfidenceComparisonGraph({ candidates, primaryCause }) {
  const rows = candidates.map((candidate, index) => {
    const rawScore = candidate?.ranking_share ?? null
    const parsed = rawScore === null || rawScore === '' ? NaN : Number(rawScore)
    const score = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null
    const name = candidate?.cause || candidate?.name || candidate?.title || `Candidate ${index + 1}`
    const isPrimary = candidate === primaryCause || name === (primaryCause?.cause || primaryCause?.name || primaryCause?.title)
    return { name, score, isPrimary, index }
  }).sort((a, b) => {
    if (a.score === null && b.score === null) return a.index - b.index
    if (a.score === null) return 1
    if (b.score === null) return -1
    return b.score - a.score
  })
  const scored = rows.filter(row => row.score !== null)
  const unscored = rows.filter(row => row.score === null)

  return (
    <section className="rl-panel rl-confidence-panel" aria-label="Root cause confidence comparison">
      <div className="rl-panel-title">
        <div>
          <h2>Root Cause Confidence Comparison</h2>
          <p>Relative ranking shares calculated by the backend. They sum to 100% across returned candidates; they are not calibrated probabilities.</p>
        </div>
      </div>
      {!rows.length ? (
        <Note>No root-cause candidates are available to compare.</Note>
      ) : !scored.length ? (
        <Note>The backend did not return ranking_share values. Restart the backend and refresh analysis to load the updated scoring response.</Note>
      ) : (
        <>
          <div className="rl-confidence-axis" aria-hidden="true">
            <span>Candidate</span>
            <div><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
          </div>
          <div className="rl-confidence-chart">
            {scored.map((row) => (
              <div className={`rl-confidence-row ${row.isPrimary ? 'is-primary' : ''}`} key={`${row.name}-${row.index}`}>
                <div className="rl-confidence-name" title={row.name}>
                  {row.isPrimary && <span className="rl-confidence-leading">LEADING</span>}
                  <span>{row.name}</span>
                </div>
                <div className="rl-confidence-track" role="img" aria-label={`${row.name}: ${row.score}% ranking share`}>
                  <div className="rl-confidence-fill" style={{ width: `${row.score}%` }} />
                </div>
                <strong className="rl-confidence-value">{row.score}%</strong>
              </div>
            ))}
          </div>
          {unscored.length > 0 && (
            <div className="rl-confidence-unscored">
              <strong>Scores unavailable</strong>
              <p>{unscored.map(row => row.name).join(' · ')}</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}


function EvidenceComparisonGraph({ candidates }) {
  // These counts must come from backend-computed record matches and evidence
  // gaps. Do not count explanatory sentences as evidence records.
  const rows = candidates.map((candidate, index) => {
    const supportingRaw = candidate?.supporting_evidence_count
    const missingRaw = candidate?.missing_evidence_count
    const supportingCount = supportingRaw === null || supportingRaw === undefined
      ? null
      : Number(supportingRaw)
    const missingCount = missingRaw === null || missingRaw === undefined
      ? null
      : Number(missingRaw)

    return {
      name: candidate?.cause || candidate?.name || candidate?.title || `Candidate ${index + 1}`,
      supportingCount: Number.isFinite(supportingCount) && supportingCount >= 0 ? supportingCount : null,
      missingCount: Number.isFinite(missingCount) && missingCount >= 0 ? missingCount : null,
      index,
    }
  })

  const availableCounts = rows.flatMap(row => [
    row.supportingCount,
    row.missingCount,
  ]).filter(value => value !== null)
  const maxCount = Math.max(1, ...availableCounts)
  const tickValues = [...new Set([0, Math.ceil(maxCount / 2), maxCount])]

  return (
    <section className="rl-panel rl-evidence-comparison" aria-label="Supporting versus missing evidence comparison">
      <div className="rl-panel-title">
        <div>
          <h2>Supporting vs. Missing Evidence</h2>
          <p>Bars count matched incident records and distinct required telemetry checks returned by the backend—not explanation sentences.</p>
        </div>
      </div>
      {!rows.length ? (
        <Note>No root-cause candidates are available for evidence comparison.</Note>
      ) : !availableCounts.length ? (
        <Note>The analysis API has not returned evidence counts yet. Refresh the analysis after updating the backend.</Note>
      ) : (
        <>
          <div className="rl-evidence-legend">
            <span><i className="rl-evidence-key supporting" /> Matching recorded evidence</span>
            <span><i className="rl-evidence-key missing" /> Evidence gaps to investigate</span>
          </div>
          <div className="rl-evidence-axis" aria-hidden="true">
            <span>Root-cause candidate</span>
            <div>{tickValues.map(value => <span key={value}>{value}</span>)}</div>
          </div>
          <div className="rl-evidence-rows">
            {rows.map(row => (
              <div className="rl-evidence-row" key={`${row.name}-${row.index}`}>
                <div className="rl-evidence-candidate" title={row.name}>{row.name}</div>
                <div className="rl-evidence-bars">
                  <div className="rl-evidence-bar-line">
                    <span className="rl-evidence-bar-label">Supporting</span>
                    {row.supportingCount !== null ? (
                      <>
                        <div className="rl-evidence-track" role="img" aria-label={`${row.name}: ${row.supportingCount} matching recorded evidence items`}>
                          <div className="rl-evidence-fill supporting" style={{ width: `${row.supportingCount / maxCount * 100}%` }} />
                        </div>
                        <strong>{row.supportingCount}</strong>
                      </>
                    ) : <span className="rl-evidence-unavailable">Unavailable</span>}
                  </div>
                  <div className="rl-evidence-bar-line">
                    <span className="rl-evidence-bar-label">Gaps</span>
                    {row.missingCount !== null ? (
                      <>
                        <div className="rl-evidence-track" role="img" aria-label={`${row.name}: ${row.missingCount} evidence gaps to investigate`}>
                          <div className="rl-evidence-fill missing" style={{ width: `${row.missingCount / maxCount * 100}%` }} />
                        </div>
                        <strong>{row.missingCount}</strong>
                      </>
                    ) : <span className="rl-evidence-unavailable">Unavailable</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="rl-muted">A zero means the backend found no matching recorded evidence or returned no evidence gaps. Unreturned counts are labelled unavailable; narrative descriptions are not counted as records.</p>
        </>
      )}
    </section>
  )
}


function EvidenceSignalDistribution({ evidence }) {
  const categoryFor = item => {
    const raw = [
      item?.kind,
      item?.event_type,
      item?.event_type_display,
      item?.category,
      item?.source,
      item?.service,
      item?.message,
      item?.description,
      item?.detail,
      item?.fault_type,
    ].filter(value => value != null).join(' ').toLowerCase()

    if (!raw.trim()) return 'Unclassified'
    if (/network|timeout|timed out|latency|connection refused|retry/.test(raw)) return 'Network'
    if (/database|sql|query|transaction|connection pool|rollback/.test(raw)) return 'Database'
    if (/worker|service|process|crash|restart|exception|health check/.test(raw)) return 'Worker / Service'
    if (/queue|consumer|backlog|message pending|lag/.test(raw)) return 'Queue'
    if (/recovery|recover|reconcile|compensat/.test(raw)) return 'Recovery'
    if (/sender|receiver|debit|credit|transfer|payment|ledger/.test(raw)) return 'Transfer'
    return 'Other / Unclassified'
  }

  const rows = useMemo(() => {
    const records = Array.isArray(evidence) ? evidence : []
    const counts = new Map()
    records.forEach(item => {
      // Only structured evidence records are counted; narrative strings are not treated
      // as independently verified signals.
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      const category = categoryFor(item)
      counts.set(category, (counts.get(category) || 0) + 1)
    })
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [evidence])

  const maxCount = Math.max(1, ...rows.map(row => row.count))
  const total = rows.reduce((sum, row) => sum + row.count, 0)

  return (
    <Panel
      title="Evidence Signal Distribution"
      subtitle="Counts of structured evidence records grouped by signals in their returned fields"
    >
      <div className="rl-esd-summary">
        <span><strong>{total}</strong> structured records counted</span>
        <span><strong>{rows.length}</strong> categories present</span>
      </div>
      {!rows.length ? (
        <Note>No structured evidence records were returned for this incident. The chart will populate when evidence records are available.</Note>
      ) : (
        <div className="rl-esd-chart" role="img" aria-label="Evidence record counts grouped by dynamically detected signal category">
          <div className="rl-esd-axis">
            <span>Signal category</span>
            <div className="rl-esd-ticks">
              {[0, Math.ceil(maxCount / 2), maxCount].filter((value, index, all) => all.indexOf(value) === index).map(value => (
                <span key={value}>{value}</span>
              ))}
            </div>
          </div>
          <div className="rl-esd-rows">
            {rows.map(row => (
              <div className="rl-esd-row" key={row.name}>
                <div className="rl-esd-label" title={row.name}>{row.name}</div>
                <div className="rl-esd-track" aria-label={`${row.name}: ${row.count} records`}>
                  <div className="rl-esd-bar" style={{ width: `${row.count / maxCount * 100}%` }} />
                </div>
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
          <p className="rl-muted">
            Categories are inferred from fields on actual structured evidence records. Records without recognizable signals are grouped as unclassified; explanatory candidate text is not counted.
          </p>
        </div>
      )}
    </Panel>
  )
}


function TimelineEvidenceGraph({ timeline, evidence }) {
  const toPoint = (item, index, kind) => {
    if (!item || typeof item !== 'object') return null
    const rawTime = eventTime(item)
    const timestamp = rawTime ? new Date(rawTime).getTime() : NaN
    if (!Number.isFinite(timestamp)) return null
    const label = eventName(item)
    return { timestamp, label, kind, index, detail: eventDetails(item) }
  }

  const timelinePoints = timeline.map((item, index) => toPoint(item, index, 'timeline')).filter(Boolean)
  const evidencePoints = evidence.map((item, index) => toPoint(item, index, 'evidence')).filter(Boolean)
  const points = [...timelinePoints, ...evidencePoints].sort((a, b) => a.timestamp - b.timestamp)
  const uniqueRows = []
  const rowByKey = new Map()
  const previousByKind = { timeline: null, evidence: null }
  points.forEach(point => {
    const key = `${point.kind}:${point.label}`
    if (!rowByKey.has(key)) {
      rowByKey.set(key, uniqueRows.length)
      uniqueRows.push({ key, kind: point.kind, label: point.label })
    }
    point.row = rowByKey.get(key)
    point.previousTimestamp = previousByKind[point.kind]
    previousByKind[point.kind] = point.timestamp
  })

  if (!points.length) {
    return (
      <Panel title="Timeline vs Evidence" subtitle="Event timestamps on the horizontal axis; event names on the vertical axis">
        <Note>No usable timestamps were returned for timeline events or evidence records, so this chart cannot be plotted yet.</Note>
      </Panel>
    )
  }

  const width = 1000
  const left = 270
  const right = 28
  const top = 30
  const rowHeight = 42
  const height = Math.max(190, top + uniqueRows.length * rowHeight + 48)
  const plotWidth = width - left - right
  const minTime = Math.min(...points.map(point => point.timestamp))
  const maxTime = Math.max(...points.map(point => point.timestamp))
  const span = maxTime - minTime
  const x = timestamp => left + (span === 0 ? plotWidth / 2 : ((timestamp - minTime) / span) * plotWidth)
  const y = row => top + row * rowHeight + rowHeight / 2
  const ticks = span === 0 ? [minTime] : [minTime, minTime + span / 2, maxTime]
  const formatTick = timestamp => new Date(timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <Panel title="Timeline vs Evidence" subtitle="Timeline is on the X-axis; recorded event and evidence names are on the Y-axis">
      <div className="rl-te-legend">
        <span><i className="rl-te-dot timeline" /> Timeline events <b>{timelinePoints.length}</b></span>
        <span><i className="rl-te-dot evidence" /> Timestamped evidence <b>{evidencePoints.length}</b></span>
      </div>
      <div className="rl-te-chart-wrap">
        <svg className="rl-te-chart rl-te-chart-rows" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Timeline on the horizontal axis and event names on the vertical axis">
          {ticks.map((tick, index) => (
            <g key={`${tick}-${index}`}>
              <line x1={x(tick)} y1={top - 8} x2={x(tick)} y2={height - 38} className="rl-te-grid" />
              <text x={x(tick)} y={height - 12} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="rl-te-tick">{formatTick(tick)}</text>
            </g>
          ))}
          {uniqueRows.map((row, index) => (
            <g key={row.key}>
              <line x1={left} y1={y(index)} x2={width - right} y2={y(index)} className="rl-te-row-line" />
              <text x={left - 12} y={y(index) + 4} textAnchor="end" className="rl-te-label">{row.label.length > 34 ? `${row.label.slice(0, 31)}…` : row.label}</text>
            </g>
          ))}
          {points.map((point, index) => {
            const currentX = x(point.timestamp)
            const previousX = point.previousTimestamp == null ? currentX : x(point.previousTimestamp)
            // The bar represents elapsed time since the previous record of the same type.
            // The first record has a short timestamp marker because no earlier interval exists.
            const barX = point.previousTimestamp == null ? currentX - 4 : Math.min(previousX, currentX)
            const barWidth = point.previousTimestamp == null ? 8 : Math.max(3, Math.abs(currentX - previousX))
            return (
              <rect
                key={`${point.kind}-${point.timestamp}-${point.index}`}
                x={barX}
                y={y(point.row) - 6}
                width={barWidth}
                height="12"
                rx="3"
                className={`rl-te-bar ${point.kind}`}
              >
                <title>{`${point.kind === 'timeline' ? 'Timeline event' : 'Evidence'}: ${point.label} — ${new Date(point.timestamp).toLocaleString()}${point.previousTimestamp == null ? ' — first recorded item of this type' : ` — ${duration(point.timestamp - point.previousTimestamp)} since previous ${point.kind === 'timeline' ? 'event' : 'evidence record'}`}${point.detail ? ` — ${point.detail}` : ''}`}</title>
              </rect>
            )
          })}
        </svg>
      </div>
      {!evidencePoints.length && <Note>No evidence records contain usable timestamps. Timeline events are plotted, but evidence records cannot be placed on the time axis.</Note>}
      <p className="rl-muted">Each row represents a returned event/evidence label. Bars show the elapsed time since the previous record of the same type; the first record is marked at its timestamp. Hover over a bar for details.</p>
    </Panel>
  )
}


function RecoveryDurationGraph({ timeline }) {
  const normalizedName = item => String(
    item?.kind || item?.event_type || item?.event_type_display || item?.message || item?.description || ''
  ).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

  const eventByAliases = aliases => {
    const matches = timeline
      .map(item => {
        const rawTime = eventTime(item)
        const timestamp = rawTime ? new Date(rawTime).getTime() : NaN
        return { item, name: normalizedName(item), timestamp, rawTime }
      })
      .filter(row => Number.isFinite(row.timestamp) && aliases.some(alias => row.name.includes(alias)))
      .sort((a, b) => a.timestamp - b.timestamp)
    return matches[0] || null
  }

  const stages = [
    { label: 'Request received → Sender debited', start: ['request_received', 'request_received'], end: ['sender_debited', 'sender_debited'] },
    { label: 'Sender debited → Recovery started', start: ['sender_debited'], end: ['recovery_started'] },
    { label: 'Recovery started → Receiver credited', start: ['recovery_started'], end: ['receiver_credited'] },
    { label: 'Receiver credited → Transfer completed', start: ['receiver_credited'], end: ['transfer_completed'] },
    { label: 'Transfer completed → Recovery completed', start: ['transfer_completed'], end: ['recovery_completed'] },
    { label: 'Total recovery duration', start: ['request_received'], end: ['recovery_completed'] },
  ]

  const rows = stages.map(stage => {
    const start = eventByAliases(stage.start)
    const end = eventByAliases(stage.end)
    if (!start || !end || end.timestamp < start.timestamp) {
      return { ...stage, available: false, reason: !start || !end ? 'Required timestamp missing' : 'End timestamp precedes start' }
    }
    return {
      ...stage,
      available: true,
      startTimestamp: start.timestamp,
      endTimestamp: end.timestamp,
      milliseconds: end.timestamp - start.timestamp,
      startRaw: start.rawTime,
      endRaw: end.rawTime,
    }
  })
  const available = rows.filter(row => row.available)
  const maxDuration = Math.max(1, ...available.map(row => row.milliseconds))
  const chartWidth = 680
  const labelWidth = 270
  const barWidth = chartWidth - labelWidth - 70
  const ticks = [0, maxDuration / 2, maxDuration]
  const tickLabel = value => value < 1000 ? `${Math.round(value)} ms`
    : value < 60000 ? `${(value / 1000).toFixed(2)} s`
    : `${(value / 60000).toFixed(2)} min`

  return (
    <Panel
      title="Incident Recovery Duration"
      subtitle="Elapsed time between recorded recovery events; only stages with valid start and end timestamps are plotted"
    >
      {!available.length ? (
        <Note>No recovery stages can be plotted because the required event timestamps are missing or out of order. No durations have been estimated.</Note>
      ) : (
        <>
          <div className="rl-recovery-chart-wrap">
            <svg
              className="rl-recovery-chart"
              viewBox={`0 0 ${chartWidth} ${Math.max(150, 68 + available.length * 48)}`}
              role="img"
              aria-label="Horizontal bar chart of measured incident recovery stage durations"
            >
              {ticks.map((tick, index) => {
                const x = labelWidth + (tick / maxDuration) * barWidth
                return (
                  <g key={`${tick}-${index}`}>
                    <line x1={x} y1="24" x2={x} y2={Math.max(115, 40 + available.length * 48)} className="rl-recovery-grid" />
                    <text x={x} y="15" textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="rl-recovery-tick">{tickLabel(tick)}</text>
                  </g>
                )
              })}
              {available.map((row, index) => {
                const y = 48 + index * 48
                const width = Math.max(2, (row.milliseconds / maxDuration) * barWidth)
                return (
                  <g key={row.label}>
                    <text x={labelWidth - 12} y={y + 4} textAnchor="end" className="rl-recovery-label">
                      {row.label.length > 38 ? `${row.label.slice(0, 35)}…` : row.label}
                    </text>
                    <rect x={labelWidth} y={y - 9} width={barWidth} height="18" rx="5" className="rl-recovery-track" />
                    <rect x={labelWidth} y={y - 9} width={width} height="18" rx="5" className={row.label === 'Total recovery duration' ? 'rl-recovery-bar total' : 'rl-recovery-bar'}>
                      <title>{`${row.label}: ${duration(row.milliseconds)}. Start: ${new Date(row.startTimestamp).toLocaleString()}. End: ${new Date(row.endTimestamp).toLocaleString()}.`}</title>
                    </rect>
                    <text x={labelWidth + barWidth + 10} y={y + 4} className="rl-recovery-value">{duration(row.milliseconds)}</text>
                  </g>
                )
              })}
            </svg>
          </div>
          {rows.some(row => !row.available) && (
            <div className="rl-recovery-unavailable">
              <strong>Stages unavailable</strong>
              {rows.filter(row => !row.available).map(row => (
                <p key={row.label}>{row.label}: {row.reason}.</p>
              ))}
            </div>
          )}
          <p className="rl-muted">Durations are calculated from the earliest matching recorded timestamp for each event type. Bars represent elapsed time, not proof that a service was actively processing throughout the interval.</p>
        </>
      )}
    </Panel>
  )
}

function Info({ label, value }) {
  return <div className="rl-info"><span>{label}</span><strong>{value || 'Not recorded'}</strong></div>
}
