import { useEffect, useState } from 'react'
import { get } from '../api'
import { dateTime, errorText } from '../helpers'
import { Notice, Panel } from '../ui'

interface Event {
  occurredAt: string
  kind: string
  method: string | null
  ip: string | null
  userAgent: string | null
  detail: string | null
  fullName: string | null
}

const KIND_FR: Record<string, string> = {
  login_succeeded: 'Connexion réussie',
  login_failed: 'Connexion refusée',
  login_rate_limited: 'Bloqué : trop de tentatives',
  logout: 'Déconnexion',
  logout_everywhere: 'Déconnexion de tous les appareils',
  password_changed: 'Mot de passe changé',
  password_reset_by_manager: 'Mot de passe réinitialisé',
  pin_reset_by_manager: 'PIN réinitialisé',
  two_step_enabled: 'Double vérification activée',
  two_step_disabled: 'Double vérification désactivée',
  recovery_code_used: 'Code de secours utilisé',
  device_paired: 'Tablette appairée',
  device_revoked: 'Tablette retirée',
  staff_created: 'Membre ajouté',
  staff_disabled: 'Membre désactivé',
}
const WARN = new Set(['login_failed', 'login_rate_limited', 'recovery_code_used', 'two_step_disabled'])

const DETAIL_FR: Record<string, string> = {
  'wrong password': 'mauvais mot de passe',
  'wrong PIN': 'mauvais PIN',
  'wrong two-step code': 'mauvais code de vérification',
}

export function History() {
  const [rows, setRows] = useState<Event[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    get<Event[]>('/auth/events?limit=200').then(setRows, (e) => setError(errorText(e)))
  }, [])
  return (
    <>
      <h1>Historique des connexions</h1>
      <p className="muted">Tout ce qui touche aux accès de votre restaurant. Personne ne peut modifier ni effacer cet historique.</p>
      <Notice>{error}</Notice>
      <Panel title="200 derniers événements">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Quand</th>
                <th>Quoi</th>
                <th>Qui</th>
                <th>Détail</th>
                <th>Adresse réseau</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((e, i) => (
                <tr key={i} className={WARN.has(e.kind) ? 'warn' : undefined}>
                  <td className="nowrap">{dateTime(e.occurredAt)}</td>
                  <td>{KIND_FR[e.kind] ?? e.kind}</td>
                  <td>{e.fullName ?? '—'}</td>
                  <td className="muted small">{e.detail ? (DETAIL_FR[e.detail] ?? e.detail) : ''}</td>
                  <td className="muted small" title={e.userAgent ?? ''}>{e.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
