import { Activity, ArrowRight, X } from 'lucide-react'
export default function IncidentModal({ incident, onInvestigate, onClose }) {
  if (!incident) return null
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="incident-prompt-title">
    <div className="modal-card">
      <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={18}/></button>
      <div className="modal-symbol"><Activity size={24}/></div>
      <div className="eyebrow">ROOTLENS AI · INCIDENT RECOVERED</div>
      <h2 id="incident-prompt-title">Do you want to know why this happened?</h2>
      <p className="muted">{incident.title} has recovered in the simulator. The evidence is saved, but the underlying cause may still need attention.</p>
      <div className="modal-incident"><span>{incident.incident_key}</span><span className="status-pill recovered">Recovered</span></div>
      <div className="modal-actions"><button className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" onClick={() => onInvestigate(incident)}>Investigate incident <ArrowRight size={16}/></button></div>
    </div>
  </div>
}
