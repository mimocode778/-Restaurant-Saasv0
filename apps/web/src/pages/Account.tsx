import QRCode from 'qrcode'
import { useState, type FormEvent } from 'react'
import { post, type Me } from '../api'
import { ROLE_FR, useAction } from '../helpers'
import { Field, Notice, Panel } from '../ui'

export function Account({ me, onChanged, onLoggedOut }: { me: Me; onChanged: () => void; onLoggedOut: () => void }) {
  return (
    <>
      <h1>Mon compte</h1>
      <Panel title="Moi">
        <p>
          <strong>{me.fullName}</strong> · {ROLE_FR[me.role]}
        </p>
      </Panel>
      <ChangePassword />
      {me.role !== 'waiter' && <TwoStep me={me} onChanged={onChanged} />}
      <LogoutEverywhere onLoggedOut={onLoggedOut} />
    </>
  )
}

function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [ok, setOk] = useState<string | null>(null)
  const { busy, error, setError, run } = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    setOk(null)
    if (next !== repeat) return setError('Les deux nouveaux mots de passe ne sont pas identiques')
    await run(async () => {
      await post('/auth/password', { currentPassword: current, newPassword: next })
      setOk('Mot de passe changé. Vos autres appareils ont été déconnectés.')
      setCurrent('')
      setNext('')
      setRepeat('')
    })
  }
  return (
    <Panel title="Changer de mot de passe">
      <form onSubmit={submit}>
        <Field label="Mot de passe actuel">
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <div className="two">
          <Field label="Nouveau mot de passe" hint="Au moins 10 caractères. Une phrase est plus sûre et plus facile à retenir.">
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
          </Field>
          <Field label="Répétez le nouveau mot de passe">
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </Field>
        </div>
        <Notice>{error}</Notice>
        <Notice kind="ok">{ok}</Notice>
        <button className="primary" disabled={busy}>Changer</button>
      </form>
    </Panel>
  )
}

function TwoStep({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [password, setPassword] = useState('')
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const { busy, error, run } = useAction()

  async function start(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      const r = await post<{ secret: string; otpauthUrl: string }>('/auth/two-step/setup', { currentPassword: password })
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) })
      setPassword('')
    })
  }

  async function confirmCode(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      const r = await post<{ recoveryCodes: string[] }>('/auth/two-step/confirm', { code: code.trim() })
      setRecovery(r.recoveryCodes)
      setSetup(null)
      setCode('')
    })
  }

  async function disable(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      await post('/auth/two-step/disable', { currentPassword: password, code: code.trim() })
      setPassword('')
      setCode('')
      onChanged()
    })
  }

  if (recovery) {
    return (
      <Panel title="Double vérification activée">
        <p><strong>Vos 10 codes de secours — affichés une seule fois.</strong></p>
        <p className="muted small">Imprimez-les ou notez-les sur papier et rangez-les en lieu sûr. Si vous perdez votre téléphone, chaque code permet une connexion.</p>
        <ul className="codes">
          {recovery.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
        <button className="primary" onClick={() => { setRecovery(null); onChanged() }}>J’ai noté mes codes</button>
      </Panel>
    )
  }

  if (me.twoStepEnabled) {
    return (
      <Panel title="Double vérification : activée ✓">
        <p className="muted">À chaque connexion, un code de votre téléphone est demandé en plus du mot de passe.</p>
        <form onSubmit={disable}>
          <p className="small">Pour la désactiver :</p>
          <div className="two">
            <Field label="Mot de passe">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="Code à 6 chiffres">
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
          </div>
          <Notice>{error}</Notice>
          <button className="danger" disabled={busy}>Désactiver</button>
        </form>
      </Panel>
    )
  }

  return (
    <Panel title="Double vérification : désactivée">
      {!setup ? (
        <form onSubmit={start}>
          <p className="muted">
            Recommandé pour les propriétaires. Installez sur votre téléphone une application d’authentification
            (Google Authenticator, Microsoft Authenticator…), puis commencez.
          </p>
          <Field label="Votre mot de passe actuel">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Notice>{error}</Notice>
          <button className="primary" disabled={busy}>Commencer</button>
        </form>
      ) : (
        <form onSubmit={confirmCode}>
          <ol className="steps">
            <li>Dans l’application, choisissez « Ajouter un compte » puis « Scanner un QR code ».</li>
            <li>Scannez ce code :</li>
          </ol>
          <img className="qr" src={setup.qr} alt="QR code à scanner avec l’application d’authentification" />
          <p className="muted small">Pas de caméra ? Saisissez cette clé dans l’application : <code>{setup.secret}</code></p>
          <Field label="Code à 6 chiffres affiché par l’application">
            <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
          <Notice>{error}</Notice>
          <button className="primary" disabled={busy}>Activer</button>
        </form>
      )}
    </Panel>
  )
}

function LogoutEverywhere({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { busy, error, run } = useAction()
  return (
    <Panel title="Déconnecter tous mes appareils">
      <p className="muted">Utile si vous avez perdu un appareil ou oublié de vous déconnecter ailleurs. Vous serez aussi déconnecté ici.</p>
      <Notice>{error}</Notice>
      <button
        className="danger"
        disabled={busy}
        onClick={() => confirm('Déconnecter tous vos appareils, y compris celui-ci ?') && run(async () => { await post('/auth/logout-everywhere'); onLoggedOut() })}
      >
        Tout déconnecter
      </button>
    </Panel>
  )
}
