import { useMemo } from 'react'
import {
  AlertTriangle,
  Database,
  Wifi,
  ServerCrash,
  Layers3,
  RefreshCw,
} from 'lucide-react'
import './RootCauseTree.css'

const ISSUE_TYPES = [
  {
    key: 'database',
    name: 'Database Crash',
    color: '#27baff',
    Icon: Database,
    matches: ['database', 'db crash', 'sql'],
    description: 'Database connection, query, or transaction failure.',
  },
  {
    key: 'network',
    name: 'Internet / Network Issue',
    color: '#22dfb5',
    Icon: Wifi,
    matches: ['network', 'internet', 'connectivity', 'timeout'],
    description: 'Network latency or connectivity problems.',
  },
  {
    key: 'service',
    name: 'Service Crash',
    color: '#ffb13b',
    Icon: ServerCrash,
    matches: ['service crash', 'worker crash', 'process crash'],
    description: 'A backend service or worker stopped processing.',
  },
  {
    key: 'queue',
    name: 'Queue Backlog',
    color: '#bd7bff',
    Icon: Layers3,
    matches: ['queue', 'backlog', 'consumer lag'],
    description: 'Queued tasks or messages are delayed.',
  },
]

const getName = item =>
  item?.cause || item?.name || item?.title || item?.label || ''

const getScore = item => {
  if (item?.score === null || item?.score === undefined || item?.score === '') {
    return null
  }

  const value = Number(item.score)

  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null
}

const getCandidates = analysis => {
  const values =
    analysis?.candidates ??
    analysis?.root_causes ??
    analysis?.tree?.children ??
    []

  return Array.isArray(values) ? values : []
}

const getEvidence = item => {
  const values = item?.supporting_evidence ?? item?.evidence

  if (!Array.isArray(values)) return []

  return values
    .map(value =>
      typeof value === 'string'
        ? value
        : value?.description || value?.message || '',
    )
    .filter(Boolean)
    .slice(0, 3)
}

function Confidence({ score, color }) {
  return (
    <div className="rct-confidence">
      <div
        className="rct-confidence-ring"
        style={{
          '--ring-color': color,
          '--ring-score': `${score ?? 0}%`,
        }}
      >
        {score === null ? 'N/A' : `${score}%`}
      </div>
      <small>Evidence match</small>
    </div>
  )
}

function IssueCard({ issue, candidate }) {
  const Icon = issue.Icon
  const score = getScore(candidate)
  const evidence = getEvidence(candidate)

  return (
    <article
      className="rct-issue-card"
      style={{ '--issue-color': issue.color }}
    >
      <div className="rct-issue-heading">
        <span className="rct-issue-icon">
          <Icon size={22} />
        </span>

        <div className="rct-issue-title">
          <h3>{candidate ? getName(candidate) : issue.name}</h3>
          <span>RELATED ISSUE</span>
        </div>

        <Confidence score={score} color={issue.color} />
      </div>

      <p className="rct-issue-description">
        {candidate?.description ||
          candidate?.reason ||
          issue.description}
      </p>

      <div className="rct-evidence-label">SUPPORTING EVIDENCE</div>

      {evidence.length > 0 ? (
        <ul className="rct-evidence-list">
          {evidence.map((item, index) => (
            <li key={`${issue.key}-${index}`}>
              <span />
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rct-no-evidence">
          No supporting evidence returned for this category.
        </p>
      )}

      {score === null && (
        <small className="rct-score-missing">
          Score unavailable
        </small>
      )}
    </article>
  )
}

function RootConnectors() {
  return (
    <svg
      className="rct-root-svg"
      viewBox="0 0 1000 600"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        {ISSUE_TYPES.map(issue => (
          <linearGradient
            key={issue.key}
            id={`rct-line-${issue.key}`}
            x1="0"
            y1="0"
            x2="1"
            y2="1"
          >
            <stop offset="0%" stopColor="#ff536d" />
            <stop offset="100%" stopColor={issue.color} />
          </linearGradient>
        ))}

        <filter id="rct-line-glow">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        filter="url(#rct-line-glow)"
      >
        <path
          d="M500 300 C410 300 410 160 315 160 S210 120 135 110"
          stroke="url(#rct-line-database)"
        />
        <path
          d="M500 300 C590 300 590 160 685 160 S790 120 865 110"
          stroke="url(#rct-line-network)"
        />
        <path
          d="M500 320 C410 335 410 440 315 440 S210 480 135 490"
          stroke="url(#rct-line-service)"
        />
        <path
          d="M500 320 C590 335 590 440 685 440 S790 480 865 490"
          stroke="url(#rct-line-queue)"
        />
      </g>

      {[
        [500, 310, '#ff536d'],
        [135, 110, ISSUE_TYPES[0].color],
        [865, 110, ISSUE_TYPES[1].color],
        [135, 490, ISSUE_TYPES[2].color],
        [865, 490, ISSUE_TYPES[3].color],
      ].map(([cx, cy, color], index) => (
        <circle
          key={index}
          cx={cx}
          cy={cy}
          r="5"
          fill="#071522"
          stroke={color}
          strokeWidth="3"
        />
      ))}
    </svg>
  )
}

export default function RootCauseTree({
  analysis,
  incident,
  loading = false,
  error = '',
  onRefresh,
}) {
  const candidates = useMemo(
    () => getCandidates(analysis),
    [analysis],
  )

  const primary =
    analysis?.primary_cause ||
    analysis?.tree?.root ||
    candidates[0] ||
    null

  const score = getScore(primary)

  const matchedIssues = ISSUE_TYPES.map(issue => {
    const candidate = candidates.find(item => {
      const name = getName(item).toLowerCase()
      return issue.matches.some(term => name.includes(term))
    })

    return { issue, candidate }
  })

  const incidentKey =
    incident?.incident_key ||
    `INC-${incident?.id ?? incident?.pk ?? 'PENDING'}`

  const confirmed = Boolean(
    analysis?.fault_confirmed ||
    analysis?.root_cause_confirmed,
  )

  return (
    <section className="rct-panel">
      <header className="rct-header">
        <div>
          <div className="rct-eyebrow">
            ROOTLENS AI / {incidentKey}
          </div>
          <h2>Root Cause Analysis</h2>
          <p>
            Follow the connected issues leading to the major cause.
          </p>
        </div>

        {onRefresh && (
          <button
            className="rct-refresh"
            type="button"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw size={15} />
            {loading ? 'Analyzing…' : 'Refresh'}
          </button>
        )}
      </header>

      {error && <div className="rct-alert">{error}</div>}

      {loading && (
        <div className="rct-alert">Updating analysis…</div>
      )}

      {analysis?.score_warning && (
        <div className="rct-alert">{analysis.score_warning}</div>
      )}

      <div className="rct-tree">
        <RootConnectors />

        {matchedIssues.map(({ issue, candidate }) => (
          <div
            key={issue.key}
            className={`rct-slot rct-slot-${issue.key}`}
          >
            <IssueCard issue={issue} candidate={candidate} />
          </div>
        ))}

        <article className="rct-major">
          <div className="rct-major-heading">
            <span className="rct-major-icon">
              <AlertTriangle size={24} />
            </span>
            <span className="rct-major-label">MAJOR CAUSE</span>
          </div>

          <h3>
            {primary ? getName(primary) : 'Root cause not established'}
          </h3>

          <div className="rct-major-score">
            {score === null ? 'N/A' : `${score}%`}
          </div>
          <small>Evidence-match score</small>

          <p>
            {primary?.description ||
              primary?.reason ||
              analysis?.hypothesis ||
              incident?.hypothesis ||
              'The available evidence has not established a confirmed root cause.'}
          </p>

          <div className="rct-major-status">
            {confirmed ? 'Confirmed by analysis' : 'Hypothesis — requires verification'}
          </div>
        </article>
      </div>

      <div className="rct-legend">
        <span><i className="rct-dot rct-dot-major" /> Major cause</span>
        <span><i className="rct-dot rct-dot-database" /> Database</span>
        <span><i className="rct-dot rct-dot-network" /> Network</span>
        <span><i className="rct-dot rct-dot-service" /> Service</span>
        <span><i className="rct-dot rct-dot-queue" /> Queue</span>
      </div>

      <footer className="rct-summary">
        <h3>Analysis Summary</h3>
        <p>
          {primary
            ? `The leading hypothesis is ${getName(primary)}. The connected cards show related issue categories and supporting evidence when available.`
            : 'The backend has not returned a major cause. Review the incident evidence before determining which issue caused the failure.'}
        </p>
      </footer>

      <p className="rct-disclaimer">
        Scores are displayed as returned by the backend. The four issue
        categories are investigation paths, not proof that each failure occurred.
      </p>
    </section>
  )
}