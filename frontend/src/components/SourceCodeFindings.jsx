
import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Fingerprint,
  GitBranch,
  RefreshCw,
  Search,
  ShieldCheck,
  Target,
} from 'lucide-react'
import api from '../lib/api'

function getErrorMessage(error) {
  const code = error?.response?.status

  if (code === 401) {
    return 'Authentication failed. Please log in again and retry.'
  }

  if (code === 403) {
    return 'You do not have permission to analyze this incident.'
  }

  if (code === 404) {
    return 'Incident or source-analysis endpoint not found. Verify the incident ID and Django URL.'
  }

  return (
    error?.response?.data?.detail ||
    error?.response?.data?.error ||
    error?.message ||
    'Source analysis failed. Check the Django backend terminal.'
  )
}

function formatScore(score) {
  const value = Number(score)
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'N/A'
}

function AlgorithmCard({ algorithm }) {
  const title = algorithm.name || 'Analysis algorithm'
  const name = title.toLowerCase()

  const Icon = name.includes('event')
    ? Activity
    : name.includes('tf-idf') || name.includes('cosine')
      ? BrainCircuit
      : GitBranch

  const ready = algorithm.status === 'complete'

  return (
    <article className="rl-scf-algorithm">
      <div className="rl-scf-algorithm-icon">
        <Icon size={19} />
      </div>

      <div className="rl-scf-algorithm-body">
        <strong>{title}</strong>
        <p>{algorithm.purpose || 'No description provided.'}</p>
      </div>

      <span className={`rl-scf-status-badge ${ready ? 'complete' : ''}`}>
        {ready ? 'Ready' : algorithm.status || 'Unknown'}
      </span>
    </article>
  )
}

function EventTimeline({ correlation }) {
  const timeline = Array.isArray(correlation?.timeline)
    ? correlation.timeline
    : []

  const observations = Array.isArray(correlation?.observations)
    ? correlation.observations
    : []

  return (
    <section className="rl-scf-panel">
      <div className="rl-scf-section-heading">
        <Activity size={19} />
        <div>
          <h4>Incident event correlation</h4>
          <p>Recorded event sequence and detected observations.</p>
        </div>
      </div>

      {observations.length > 0 && (
        <div className="rl-scf-observations">
          <strong>Detected observations</strong>
          <ul>
            {observations.map((observation, index) => (
              <li key={`${observation}-${index}`}>{observation}</li>
            ))}
          </ul>
        </div>
      )}

      {timeline.length > 0 ? (
        <div className="rl-scf-timeline">
          {timeline.map((event, index) => (
            <article
              className="rl-scf-event"
              key={`${event.index ?? index}-${event.time}-${event.kind}`}
            >
              <div className="rl-scf-event-marker">
                <span />
              </div>

              <div className="rl-scf-event-content">
                <div className="rl-scf-event-meta">
                  <strong>{event.kind || 'Event'}</strong>
                  <span>{event.time || 'Time unavailable'}</span>
                </div>

                <p>{event.message || 'No event description provided.'}</p>

                <span className="rl-scf-service">
                  Service: {event.service || 'Unknown'}
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="rl-scf-muted">
          No structured event timeline was returned.
        </p>
      )}
    </section>
  )
}

function FindingCard({ finding, index }) {
  const [expanded, setExpanded] = useState(index === 0)

  // Accept either snake_case or camelCase API field names.
  const terms = Array.isArray(finding.matched_terms)
    ? finding.matched_terms
    : Array.isArray(finding.matchedTerms)
      ? finding.matchedTerms
      : []

  const calls = Array.isArray(finding.calls) ? finding.calls : []

  return (
    <article className="rl-scf-card">
      <div className="rl-scf-card-head">
        <div className="rl-scf-card-title">
          <span className="rl-scf-index">CANDIDATE {index + 1}</span>

          <h4>{finding.path || 'Unknown source path'}</h4>

          <p>
            Function / class:{' '}
            <code>{finding.symbol || 'Not identified'}</code>
          </p>

          <p>
            Lines {finding.start_line ?? '?'}–{finding.end_line ?? '?'}
          </p>
        </div>

        <div className="rl-scf-score">
          <strong>{formatScore(finding.score)}</strong>
          <span>text relevance</span>
        </div>
      </div>

      <div className="rl-scf-reason">
        <Target size={17} />
        <div>
          <strong>Why this location was selected</strong>
          <p>
            {finding.reason ||
              'This location matched terms from the incident. Confirm the finding against runtime evidence.'}
          </p>
        </div>
      </div>

      <div className="rl-scf-section">
        <strong>Matched evidence terms</strong>

        {terms.length > 0 ? (
          <div className="rl-scf-terms">
            {terms.map((term, termIndex) => (
              <span className="rl-scf-term" key={`${term}-${termIndex}`}>
                {term}
              </span>
            ))}
          </div>
        ) : (
          <p className="rl-scf-muted">No matching terms were returned.</p>
        )}
      </div>

      {calls.length > 0 && (
        <div className="rl-scf-section">
          <strong>Detected call identifiers</strong>
          <div className="rl-scf-terms">
            {calls.map((call, callIndex) => (
              <span className="rl-scf-term" key={`${call}-${callIndex}`}>
                {call}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        className="rl-scf-expand"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <FileCode2 size={17} />
        {expanded ? 'Hide source excerpt' : 'Inspect source excerpt'}
        {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      </button>

      {expanded && (
        <div className="rl-scf-source">
          <div className="rl-scf-source-label">
            <ShieldCheck size={16} />
            Read-only source excerpt
          </div>

          {finding.excerpt ? (
            <pre>
              <code>{finding.excerpt}</code>
            </pre>
          ) : (
            <p className="rl-scf-muted">
              No source excerpt was returned by the backend.
            </p>
          )}
        </div>
      )}

      <div className="rl-scf-next">
        <Search size={17} />
        <div>
          <strong>Investigation steps</strong>
          <ol>
            <li>
              Open <code>{finding.path || 'the candidate file'}</code> in
              your editor.
            </li>
            <li>
              Inspect <code>{finding.symbol || 'the relevant function'}</code>{' '}
              around lines {finding.start_line ?? '?'}–{finding.end_line ?? '?'}.
            </li>
            <li>Review callers, error handling, and data flow.</li>
            <li>
              Compare the code with the incident timeline before deciding
              whether this location caused the incident.
            </li>
          </ol>
        </div>
      </div>
    </article>
  )
}

export default function SourceCodeFindings({ incidentId }) {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!incidentId) {
      setResult(null)
      setError('Select an incident before analyzing source code.')
      return
    }

    setLoading(true)
    setError('')

    try {
      // Preserve the shared Axios configuration and JWT refresh logic.
      // Attach the token explicitly if it exists.
      const token = sessionStorage.getItem('rootlens_access')

      const response = await api.get(
        `/incidents/${incidentId}/source-analysis/`,
        token
          ? {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }
          : {}
      )

      setResult(response.data)
    } catch (requestError) {
      setResult(null)
      setError(getErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [incidentId])

  useEffect(() => {
    load()
  }, [load])

  const findings = Array.isArray(result?.findings)
    ? result.findings
    : []

  const algorithms = Array.isArray(result?.algorithms)
    ? result.algorithms
    : []

  return (
    <section className="rl-source-analysis">
      <header className="rl-scf-header">
        <div className="rl-scf-heading">
          <div className="rl-scf-icon">
            <Fingerprint size={23} />
          </div>

          <div>
            <h3>Source Code Investigation</h3>
            <p>
              Correlate incident evidence with source files and functions
              worth investigating.
            </p>
          </div>
        </div>

        <button
          type="button"
          className="rl-primary"
          onClick={load}
          disabled={loading || !incidentId}
        >
          <RefreshCw
            size={16}
            className={loading ? 'rl-scf-spinning' : ''}
          />
          {loading ? 'Analyzing…' : 'Analyze again'}
        </button>
      </header>

      <div className="rl-scf-readonly">
        <ShieldCheck size={20} />
        <div>
          <strong>Read-only analysis</strong>
          <p>
            Source files are inspected without executing, editing,
            creating, deleting, or automatically repairing code.
          </p>
        </div>
      </div>

      {loading && (
        <div className="rl-scf-status">
          <RefreshCw size={20} className="rl-scf-spinning" />
          <div>
            <strong>Analyzing incident</strong>
            <p>Correlating events and ranking source locations…</p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rl-scf-error" role="alert">
          <AlertTriangle size={20} />
          <div>
            <strong>Analysis unavailable</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && result && (
        <>
          <section className="rl-scf-panel">
            <div className="rl-scf-section-heading">
              <BrainCircuit size={20} />
              <div>
                <h4>Analysis algorithms</h4>
                <p>Algorithms reported by the backend.</p>
              </div>
            </div>

            <div className="rl-scf-algorithms">
              {algorithms.length > 0 ? (
                algorithms.map((algorithm, index) => (
                  <AlgorithmCard
                    key={`${algorithm.name || 'algorithm'}-${index}`}
                    algorithm={algorithm}
                  />
                ))
              ) : (
                <p className="rl-scf-muted">
                  The backend did not return algorithm status.
                </p>
              )}
            </div>
          </section>

          <div className="rl-scf-stats">
            <div className="rl-scf-stat">
              <span>Source files scanned</span>
              <strong>{result.scanned_files ?? 0}</strong>
            </div>

            <div className="rl-scf-stat">
              <span>Candidate locations</span>
              <strong>{findings.length}</strong>
            </div>

            <div className="rl-scf-stat">
              <span>Incident ID</span>
              <strong>{result.incident_id ?? incidentId}</strong>
            </div>
          </div>

          <EventTimeline correlation={result.event_correlation} />

          <section className="rl-scf-results">
            <div className="rl-scf-results-heading">
              <div>
                <h4>Potentially relevant source locations</h4>
                <p>
                  Ranked by textual relevance. Candidates are not confirmed
                  root causes.
                </p>
              </div>
              <CheckCircle2 size={21} />
            </div>

            {findings.length > 0 ? (
              <div className="rl-scf-findings">
                {findings.map((finding, index) => (
                  <FindingCard
                    key={`${finding.path}:${finding.symbol}:${index}`}
                    finding={finding}
                    index={index}
                  />
                ))}
              </div>
            ) : (
              <div className="rl-scf-empty">
                <Search size={25} />
                <h4>No matching source locations found</h4>
                <p>
                  Check the incident description and logs, then try again.
                  No matches does not mean the project has no bug.
                </p>
              </div>
            )}
          </section>

          <div className="rl-scf-disclaimer">
            <AlertTriangle size={18} />
            <p>
              {result.note ||
                'Relevance scores are not calibrated probabilities. Confirm findings using runtime logs and reproducible behavior.'}
            </p>
          </div>
        </>
      )}
    </section>
  )
}
