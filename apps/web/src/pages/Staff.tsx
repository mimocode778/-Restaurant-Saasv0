import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { get, post, type Me, type Role } from '../api'
import { errorText, ROLE_FR, useAction } from '../helpers'
import { Dialog, Field, Notice, Panel } from '../ui'

interface Member {
  id: string
  fullName: string
  role: Role
  disabled: boolean
}

// Who may add or manage whom (same rule as the API, which checks it again).
const MANAGES: Record<Role, Role[]> = { owner: ['manager', 'waiter'], manager: ['waiter'], waiter: [] }

type Open = { kind: 'pin' | 'password'; member: Member } | null

export function Staff({ me }: { me: Me }) {
  const [list, setList] = useState<Member[] | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()
  const [ok, setOk] = useState<string | null>(null)

  const load = useCallback(() => {
    get<Member[]>('/staff').then(setList, (e) => setLoadError(errorText(e)))
  }, [])
  useEffect(load, [load])

  const can = (m: Member) => m.id !== me.userId && MANAGES[me.role].includes(m.role)

  async function act(path: string, message: string) {
    setOk(null)
    await action.run(async () => {
      await post(path)
      setOk(message)
      load()
    })
  }

  return (
    <>
      <h1>Équipe</h1>
      <Notice>{loadError}</Notice>
      <Notice>{action.error}</Notice>
      <Notice kind="ok">{ok}</Notice>
      <AddMember me={me} onAdded={load} />
      <Panel title="Membres">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nom</th>
                <th>Rôle</th>
                <th>État</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list?.map((m) => (
                <tr key={m.id} className={m.disabled ? 'archived' : undefined}>
                  <td>
                    <strong>{m.fullName}</strong>
                    {m.id === me.userId && <span className="tag">vous</span>}
                  </td>
                  <td>{ROLE_FR[m.role]}</td>
                  <td>{m.disabled ? 'Désactivé' : 'Actif'}</td>
                  <td className="row-actions">
                    {can(m) && !m.disabled && (
                      <>
                        {m.role === 'waiter' && <button onClick={() => setOpen({ kind: 'pin', member: m })}>Nouveau PIN</button>}
                        {m.role === 'manager' && me.role === 'owner' && (
                          <>
                            <button onClick={() => setOpen({ kind: 'password', member: m })}>Nouveau mot de passe</button>
                            <button
                              onClick={() =>
                                confirm(`Désactiver la double vérification de ${m.fullName} (téléphone perdu) ?`) &&
                                act(`/staff/${m.id}/reset-two-step`, `Double vérification désactivée pour ${m.fullName}.`)
                              }
                            >
                              Téléphone perdu
                            </button>
                          </>
                        )}
                        <button
                          className="danger"
                          onClick={() =>
                            confirm(`Désactiver ${m.fullName} ? Toutes ses connexions seront coupées immédiatement.`) &&
                            act(`/staff/${m.id}/disable`, `${m.fullName} est désactivé.`)
                          }
                        >
                          Désactiver
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {open && <ResetSecret open={open} onClose={() => setOpen(null)} onDone={(msg) => { setOpen(null); setOk(msg) }} />}
    </>
  )
}

function AddMember({ me, onAdded }: { me: Me; onAdded: () => void }) {
  const roles = MANAGES[me.role]
  const [role, setRole] = useState<Role>(roles.includes('waiter') ? 'waiter' : roles[0])
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const { busy, error, run } = useAction()
  const [ok, setOk] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setOk(null)
    const body = role === 'waiter' ? { fullName, role, pin } : { fullName, role, email, password }
    await run(async () => {
      await post('/staff', body)
      setOk(`${fullName} a été ajouté.`)
      setFullName('')
      setEmail('')
      setPassword('')
      setPin('')
      onAdded()
    })
  }

  if (roles.length === 0) return null
  return (
    <Panel title="Ajouter un membre">
      <form onSubmit={submit}>
        <div className="two">
          <Field label="Nom complet">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={100} />
          </Field>
          <Field label="Rôle">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>{ROLE_FR[r]}</option>
              ))}
            </select>
          </Field>
        </div>
        {role === 'waiter' ? (
          <Field label="Code PIN (4 à 6 chiffres)" hint="Le serveur l’utilisera sur la tablette. Donnez-le-lui en personne.">
            <input inputMode="numeric" pattern="\d{4,6}" value={pin} onChange={(e) => setPin(e.target.value)} required />
          </Field>
        ) : (
          <div className="two">
            <Field label="E-mail">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Mot de passe provisoire" hint="Au moins 10 caractères. Demandez-lui de le changer ensuite.">
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
            </Field>
          </div>
        )}
        <Notice>{error}</Notice>
        <Notice kind="ok">{ok}</Notice>
        <button className="primary" disabled={busy}>Ajouter</button>
      </form>
    </Panel>
  )
}

function ResetSecret({ open, onClose, onDone }: { open: NonNullable<Open>; onClose: () => void; onDone: (msg: string) => void }) {
  const [value, setValue] = useState('')
  const { busy, error, run } = useAction()
  const isPin = open.kind === 'pin'
  return (
    <Dialog title={`${isPin ? 'Nouveau PIN' : 'Nouveau mot de passe'} — ${open.member.fullName}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => {
            await post(`/staff/${open.member.id}/${isPin ? 'reset-pin' : 'reset-password'}`, isPin ? { pin: value } : { newPassword: value })
            onDone(`${isPin ? 'Nouveau PIN' : 'Nouveau mot de passe'} enregistré pour ${open.member.fullName}. Ses connexions en cours ont été coupées.`)
          })
        }}
      >
        <Field label={isPin ? 'Code PIN (4 à 6 chiffres)' : 'Mot de passe (au moins 10 caractères)'}>
          <input type={isPin ? 'text' : 'password'} inputMode={isPin ? 'numeric' : undefined} value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
        </Field>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Enregistrer</button>
      </form>
    </Dialog>
  )
}
