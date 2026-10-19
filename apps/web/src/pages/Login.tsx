import { useState, type FormEvent } from 'react'
import { ApiError, post } from '../api'
import { useAction } from '../helpers'
import { Field, Notice } from '../ui'

// Login for owners and managers. Waiters log in with their PIN on a paired tablet.
export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [useRecovery, setUseRecovery] = useState(false)
  const [code, setCode] = useState('')
  const { busy, error, setError, run } = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: Record<string, unknown> = { email, password, useCookie: true }
    if (needCode && code) body[useRecovery ? 'recoveryCode' : 'twoStepCode'] = code.trim()
    await run(async () => {
      try {
        await post('/auth/login', body)
        onLoggedIn()
      } catch (err) {
        // Correct password, but the second step is on: ask for the code.
        if (err instanceof ApiError && (err.body as { twoStepRequired?: boolean })?.twoStepRequired) {
          setNeedCode(true)
          setError(null)
          return
        }
        throw err
      }
    })
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true" />
          <span>Restaurant</span>
        </div>
        <h1>Connexion</h1>
        <p className="muted">Propriétaires et gérants. Les serveurs se connectent avec leur code PIN sur la tablette.</p>

        <Field label="E-mail">
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={needCode} />
        </Field>
        <Field label="Mot de passe">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={needCode} />
        </Field>

        {needCode && (
          <>
            <Field
              label={useRecovery ? 'Code de secours' : 'Code à 6 chiffres'}
              hint={useRecovery ? 'Un des 10 codes notés à l’activation. Chaque code ne sert qu’une fois.' : 'Ouvrez l’application d’authentification de votre téléphone.'}
            >
              <input
                autoFocus
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={useRecovery ? 'ABCD-EFGH-JKMN' : '123456'}
              />
            </Field>
            <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setCode('') }}>
              {useRecovery ? 'Utiliser le code du téléphone' : 'Téléphone perdu ? Utiliser un code de secours'}
            </button>
          </>
        )}

        <Notice>{error}</Notice>
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </main>
  )
}
