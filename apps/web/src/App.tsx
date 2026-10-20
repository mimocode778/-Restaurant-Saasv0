import { useCallback, useEffect, useState } from 'react'
import { ApiError, get, post, type Me } from './api'
import { Account } from './pages/Account'
import { Dashboard } from './pages/Dashboard'
import { History } from './pages/History'
import { Login } from './pages/Login'
import { Menu } from './pages/Menu'
import { Room } from './pages/Room'
import { Staff } from './pages/Staff'
import { Stock } from './pages/Stock'
import { Tablets } from './pages/Tablets'
import { ROLE_FR } from './helpers'
import { Notice } from './ui'

// The pages, with who may see them. The API checks the same rules again on every request.
const PAGES = [
  { path: '', label: 'Accueil', managersOnly: false },
  { path: 'salle', label: 'Salle (3D)', managersOnly: false },
  { path: 'carte', label: 'Carte et prix', managersOnly: false },
  { path: 'stock', label: 'Stock', managersOnly: true },
  { path: 'equipe', label: 'Équipe', managersOnly: true },
  { path: 'tablettes', label: 'Tablettes', managersOnly: true },
  { path: 'historique', label: 'Historique des connexions', managersOnly: true },
  { path: 'compte', label: 'Mon compte', managersOnly: false },
] as const

function currentPath(): string {
  return window.location.hash.replace(/^#\/?/, '')
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [path, setPath] = useState(currentPath())
  const [error, setError] = useState<string | null>(null)

  const refreshMe = useCallback(() => {
    get<Me>('/auth/me').then(
      (m) => {
        setMe(m)
        setError(null)
      },
      (e) => {
        setMe(null)
        if (!(e instanceof ApiError && e.status === 401)) setError(e.message)
      },
    )
  }, [])

  useEffect(refreshMe, [refreshMe])
  useEffect(() => {
    const onHash = () => setPath(currentPath())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  async function logout() {
    try {
      await post('/auth/logout')
    } finally {
      setMe(null)
      window.location.hash = ''
    }
  }

  if (me === undefined) return <div className="loading">Chargement…</div>
  if (me === null)
    return (
      <>
        {error && <Notice>{error}</Notice>}
        <Login onLoggedIn={refreshMe} />
      </>
    )

  const isManager = me.role !== 'waiter'
  const pages = PAGES.filter((p) => isManager || !p.managersOnly)
  const page = pages.find((p) => p.path === path) ?? pages[0]

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Restaurant</span>
        </div>
        <nav>
          {pages.map((p) => (
            <a key={p.path} href={`#/${p.path}`} className={p === page ? 'active' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <div>
            <strong>{me.fullName}</strong>
            <div className="muted small">{ROLE_FR[me.role]}</div>
          </div>
          <button className="ghost" onClick={logout}>Se déconnecter</button>
        </div>
      </aside>
      <main className="content">
        {page.path === '' && <Dashboard me={me} />}
        {page.path === 'salle' && <Room me={me} />}
        {page.path === 'carte' && <Menu me={me} />}
        {page.path === 'stock' && <Stock />}
        {page.path === 'equipe' && <Staff me={me} />}
        {page.path === 'tablettes' && <Tablets />}
        {page.path === 'historique' && <History />}
        {page.path === 'compte' && <Account me={me} onChanged={refreshMe} onLoggedOut={() => { setMe(null); window.location.hash = '' }} />}
      </main>
    </div>
  )
}
