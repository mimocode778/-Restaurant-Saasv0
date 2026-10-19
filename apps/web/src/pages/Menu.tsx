import { format, formatRate, formatTndPlain, parseRate, parseTnd, splitTtc } from '@app/shared'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { get, patch, post, type Me } from '../api'
import { dateTime, errorText, useAction } from '../helpers'
import { Dialog, Field, Notice, Panel } from '../ui'

interface Price {
  priceTtcMillimes: number
  vatRateBp: number
  htMillimes: number
  vatMillimes: number
  validFrom: string
}
interface Item {
  id: string
  categoryId: string
  name: string
  description: string | null
  position: number
  archived: boolean
  price: Price | null
}
interface Category {
  id: string
  name: string
  position: number
  archived: boolean
  items: Item[]
}

type Open =
  | { kind: 'newItem'; categoryId: string }
  | { kind: 'editItem'; item: Item }
  | { kind: 'price'; item: Item }
  | { kind: 'history'; item: Item }
  | { kind: 'renameCategory'; category: Category }
  | null

export function Menu({ me }: { me: Me }) {
  const canEdit = me.role !== 'waiter'
  const [menu, setMenu] = useState<Category[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [open, setOpen] = useState<Open>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()

  const load = useCallback(() => {
    get<Category[]>(`/menu${showArchived ? '?archived=true' : ''}`).then(
      (m) => {
        setMenu(m)
        setLoadError(null)
      },
      (e) => setLoadError(errorText(e)),
    )
  }, [showArchived])
  useEffect(load, [load])

  const done = () => {
    setOpen(null)
    load()
  }

  const activeCategories = (menu ?? []).filter((c) => !c.archived)

  return (
    <>
      <div className="page-head">
        <h1>Carte et prix</h1>
        {canEdit && (
          <label className="toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Afficher les plats archivés
          </label>
        )}
      </div>
      <p className="muted">Les prix sont saisis TTC, comme sur la carte. Le prix hors taxe et la TVA sont calculés au millime près.</p>
      <Notice>{loadError}</Notice>
      <Notice>{action.error}</Notice>

      {canEdit && <NewCategory onCreated={load} />}

      {menu?.length === 0 && <p className="empty">La carte est vide. Commencez par créer une catégorie, par exemple « Plats ».</p>}

      {menu?.map((cat) => (
        <Panel
          key={cat.id}
          title={cat.archived ? `${cat.name} (archivée)` : cat.name}
          actions={
            canEdit &&
            !cat.archived && (
              <>
                <button onClick={() => setOpen({ kind: 'newItem', categoryId: cat.id })} className="primary">
                  + Plat
                </button>
                <button onClick={() => setOpen({ kind: 'renameCategory', category: cat })}>Renommer</button>
                <button
                  onClick={() => action.run(async () => { await post(`/menu/categories/${cat.id}/archive`); load() })}
                  disabled={action.busy}
                  title="Possible seulement quand la catégorie n’a plus de plat"
                >
                  Archiver
                </button>
              </>
            )
          }
        >
          {cat.items.length === 0 ? (
            <p className="muted small">Aucun plat dans cette catégorie.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Plat</th>
                    <th className="num">Prix TTC</th>
                    <th className="num">TVA</th>
                    <th className="num">HT</th>
                    <th className="num">Montant TVA</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item) => (
                    <tr key={item.id} className={item.archived ? 'archived' : undefined}>
                      <td>
                        <strong>{item.name}</strong>
                        {item.archived && <span className="tag">archivé</span>}
                        {item.description && <div className="muted small">{item.description}</div>}
                      </td>
                      <td className="num">{item.price ? format(item.price.priceTtcMillimes) : '—'}</td>
                      <td className="num">{item.price ? formatRate(item.price.vatRateBp) : '—'}</td>
                      <td className="num muted">{item.price ? format(item.price.htMillimes) : '—'}</td>
                      <td className="num muted">{item.price ? format(item.price.vatMillimes) : '—'}</td>
                      {canEdit && (
                        <td className="row-actions">
                          {item.archived ? (
                            <button onClick={() => action.run(async () => { await post(`/menu/items/${item.id}/restore`); load() })}>Remettre à la carte</button>
                          ) : (
                            <>
                              <button onClick={() => setOpen({ kind: 'price', item })}>Prix</button>
                              <button onClick={() => setOpen({ kind: 'editItem', item })}>Modifier</button>
                              <button onClick={() => setOpen({ kind: 'history', item })}>Historique</button>
                              <button onClick={() => action.run(async () => { await post(`/menu/items/${item.id}/archive`); load() })}>Archiver</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ))}

      {open?.kind === 'newItem' && <ItemForm categories={activeCategories} categoryId={open.categoryId} onClose={() => setOpen(null)} onDone={done} />}
      {open?.kind === 'editItem' && <ItemForm categories={activeCategories} item={open.item} onClose={() => setOpen(null)} onDone={done} />}
      {open?.kind === 'price' && <PriceForm item={open.item} onClose={() => setOpen(null)} onDone={done} />}
      {open?.kind === 'history' && <History item={open.item} onClose={() => setOpen(null)} />}
      {open?.kind === 'renameCategory' && <RenameCategory category={open.category} onClose={() => setOpen(null)} onDone={done} />}
    </>
  )
}

function NewCategory({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const { busy, error, run } = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      await post('/menu/categories', { name })
      setName('')
      onCreated()
    })
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <input placeholder="Nouvelle catégorie (ex. Entrées, Plats, Boissons)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
      <button className="primary" disabled={busy}>
        Créer la catégorie
      </button>
      <Notice>{error}</Notice>
    </form>
  )
}

function RenameCategory({ category, onClose, onDone }: { category: Category; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(category.name)
  const { busy, error, run } = useAction()
  return (
    <Dialog title="Renommer la catégorie" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => {
            await patch(`/menu/categories/${category.id}`, { name })
            onDone()
          })
        }}
      >
        <Field label="Nom">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        </Field>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Enregistrer</button>
      </form>
    </Dialog>
  )
}

// Shows, while typing, what the customer pays and how it splits.
function SplitPreview({ price, rate }: { price: string; rate: string }) {
  const ttc = parseTnd(price)
  const bp = parseRate(rate)
  if (ttc === null || bp === null) return null
  const s = splitTtc(ttc, bp)
  return (
    <p className="preview">
      {format(s.ttc)} TTC = <strong>{format(s.ht)}</strong> HT + <strong>{format(s.vat)}</strong> de TVA ({formatRate(bp)})
    </p>
  )
}

function ItemForm({ categories, categoryId, item, onClose, onDone }: {
  categories: Category[]
  categoryId?: string
  item?: Item
  onClose: () => void
  onDone: () => void
}) {
  const [cat, setCat] = useState(item?.categoryId ?? categoryId ?? categories[0]?.id ?? '')
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [price, setPrice] = useState('')
  const [rate, setRate] = useState('')
  const { busy, error, setError, run } = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (item) {
      await run(async () => {
        await patch(`/menu/items/${item.id}`, { categoryId: cat, name, description: description.trim() || null })
        onDone()
      })
      return
    }
    const ttc = parseTnd(price)
    const bp = parseRate(rate)
    if (ttc === null) return setError('Prix invalide. Exemple : 12,500')
    if (bp === null) return setError('Taux de TVA invalide. Exemple : 19')
    await run(async () => {
      await post('/menu/items', { categoryId: cat, name, ...(description.trim() ? { description: description.trim() } : {}), priceTtcMillimes: ttc, vatRateBp: bp })
      onDone()
    })
  }

  return (
    <Dialog title={item ? 'Modifier le plat' : 'Nouveau plat'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Catégorie">
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Nom du plat">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        </Field>
        <Field label="Description (facultatif)">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
        </Field>
        {!item && (
          <div className="two">
            <Field label="Prix TTC (TND)" hint="Exemple : 12,500">
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
            </Field>
            <Field label="TVA (%)" hint="À confirmer avec votre comptable">
              <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
            </Field>
          </div>
        )}
        {!item && <SplitPreview price={price} rate={rate} />}
        {item && <p className="muted small">Pour changer le prix, utilisez le bouton « Prix » : l’ancien prix reste dans l’historique.</p>}
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>{item ? 'Enregistrer' : 'Ajouter à la carte'}</button>
      </form>
    </Dialog>
  )
}

function PriceForm({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState(item.price ? formatTndPlain(item.price.priceTtcMillimes) : '')
  const [rate, setRate] = useState(item.price ? formatRate(item.price.vatRateBp).replace(' %', '') : '')
  const { busy, error, setError, run } = useAction()
  return (
    <Dialog title={`Prix — ${item.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const ttc = parseTnd(price)
          const bp = parseRate(rate)
          if (ttc === null) return setError('Prix invalide. Exemple : 12,500')
          if (bp === null) return setError('Taux de TVA invalide. Exemple : 19')
          run(async () => {
            await post(`/menu/items/${item.id}/price`, { priceTtcMillimes: ttc, vatRateBp: bp })
            onDone()
          })
        }}
      >
        <div className="two">
          <Field label="Nouveau prix TTC (TND)">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required autoFocus />
          </Field>
          <Field label="TVA (%)">
            <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
          </Field>
        </div>
        <SplitPreview price={price} rate={rate} />
        <p className="muted small">L’ancien prix n’est pas effacé : il reste dans l’historique, avec la date et la personne qui l’a changé.</p>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Appliquer le nouveau prix</button>
      </form>
    </Dialog>
  )
}

function History({ item, onClose }: { item: Item; onClose: () => void }) {
  const [rows, setRows] = useState<(Price & { changedBy: string })[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    get<(Price & { changedBy: string })[]>(`/menu/items/${item.id}/prices`).then(setRows, (e) => setError(errorText(e)))
  }, [item.id])
  return (
    <Dialog title={`Historique des prix — ${item.name}`} onClose={onClose}>
      <Notice>{error}</Notice>
      {rows && (
        <table>
          <thead>
            <tr>
              <th>Depuis</th>
              <th className="num">Prix TTC</th>
              <th className="num">TVA</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{dateTime(r.validFrom)}</td>
                <td className="num">{format(r.priceTtcMillimes)}</td>
                <td className="num">{formatRate(r.vatRateBp)}</td>
                <td>{r.changedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  )
}
