import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { get, post } from '../api'
import { dateTime, errorText, useAction } from '../helpers'
import { Field, Notice, Panel } from '../ui'

interface Device {
  id: string
  name: string
  createdAt: string
  revokedAt: string | null
}

export function Tablets() {
  const [list, setList] = useState<Device[] | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()

  const load = useCallback(() => {
    get<Device[]>('/auth/devices').then(setList, (e) => setLoadError(errorText(e)))
  }, [])
  useEffect(load, [load])

  async function pair(e: FormEvent) {
    e.preventDefault()
    const res = await action.run(() => post<{ deviceToken: string }>('/auth/devices', { name }))
    if (res) {
      setToken(res.deviceToken)
      setName('')
      load()
    }
  }

  return (
    <>
      <h1>Tablettes</h1>
      <p className="muted">Les serveurs se connectent avec leur code PIN, uniquement sur une tablette appairée ici.</p>
      <Notice>{loadError}</Notice>
      <Notice>{action.error}</Notice>
      <Panel title="Appairer une tablette">
        <form className="inline-form" onSubmit={pair}>
          <Field label="Nom de la tablette">
            <input placeholder="ex. Tablette salle" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </Field>
          <button className="primary" disabled={action.busy}>Appairer</button>
        </form>
        {token && (
          <div className="secret-box">
            <p><strong>Clé de la tablette — affichée une seule fois.</strong></p>
            <code>{token}</code>
            <p className="muted small">
              Elle sera saisie sur l’écran de la tablette (écran caisse, prochaine étape). Ne l’envoyez pas par message :
              quiconque l’a peut tenter des codes PIN. Si elle est perdue, retirez la tablette ci-dessous et appairez-la à nouveau.
            </p>
            <button onClick={() => setToken(null)}>J’ai noté la clé</button>
          </div>
        )}
      </Panel>
      <Panel title="Tablettes appairées">
        {list?.length === 0 && <p className="muted small">Aucune tablette pour l’instant.</p>}
        <div className="table-wrap">
          <table>
            <tbody>
              {list?.map((d) => (
                <tr key={d.id} className={d.revokedAt ? 'archived' : undefined}>
                  <td><strong>{d.name}</strong></td>
                  <td className="muted">Appairée le {dateTime(d.createdAt)}</td>
                  <td>{d.revokedAt ? `Retirée le ${dateTime(d.revokedAt)}` : 'Active'}</td>
                  <td className="row-actions">
                    {!d.revokedAt && (
                      <button
                        className="danger"
                        onClick={() =>
                          confirm(`Retirer « ${d.name} » ? Les serveurs connectés dessus seront déconnectés.`) &&
                          action.run(async () => { await post(`/auth/devices/${d.id}/revoke`); load() })
                        }
                      >
                        Retirer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
