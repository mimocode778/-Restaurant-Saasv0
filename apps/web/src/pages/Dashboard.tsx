import { format } from '@app/shared'
import { useEffect, useState } from 'react'
import { get, type Me } from '../api'
import { errorText } from '../helpers'
import { Notice, Panel } from '../ui'

interface Summary {
  tickets: number
  grossMillimes: number
  netMillimes: number
}

export function Dashboard({ me }: { me: Me }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    get<Summary>('/sales/summary').then(setSummary, (e) => setError(errorText(e)))
  }, [])

  return (
    <>
      <h1>Bonjour {me.fullName.split(' ')[0]}</h1>
      <Panel title="Aujourd’hui">
        <Notice>{error}</Notice>
        {summary && (
          <div className="stats">
            <div className="stat">
              <span className="stat-label">Tickets</span>
              <span className="stat-value">{summary.tickets}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Ventes</span>
              <span className="stat-value">{format(summary.grossMillimes)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Après remises et remboursements</span>
              <span className="stat-value">{format(summary.netMillimes)}</span>
            </div>
          </div>
        )}
        <p className="muted small">Journée comptée de minuit à minuit, heure de Tunis.</p>
      </Panel>
      {!me.twoStepEnabled && (
        <Notice kind="info">
          Conseil : activez la double vérification dans <a href="#/compte">Mon compte</a> pour mieux protéger votre accès.
        </Notice>
      )}
    </>
  )
}
