import {
  displayUnit,
  format,
  formatQuantity,
  formatQuantityPlain,
  parseQuantity,
  parseTnd,
  type BaseUnit,
} from '@app/shared'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { get, patch, post } from '../api'
import { dateTime, errorText, useAction } from '../helpers'
import { Dialog, Field, Notice, Panel } from '../ui'

// Stock works like a bank statement: every delivery, usage, waste and stocktake is a new
// line in a journal that is never edited, and the quantity shown is the sum of the lines.
// Quantities travel as whole grams / millilitres / pieces; screens show kg and L.

type Place = 'fridge' | 'freezer' | 'dry_store' | 'bar' | 'other'
type Reason = 'spoiled' | 'expired' | 'burnt' | 'dropped' | 'other'

interface Pack {
  id: string
  name: string
  quantityBase: number
}
interface Item {
  id: string
  name: string
  baseUnit: BaseUnit
  storagePlace: Place
  alertLevelBase: number | null
  archived: boolean
  quantityBase: number
  belowAlert: boolean
  lastCountAt: string | null
  lastCost: { costMillimes: number; quantityBase: number } | null
  estimatedValueMillimes: number | null
  packs: Pack[]
}
interface MovementResult {
  quantityBase: number
  stockAfterBase: number
  belowZero: boolean
  belowAlert: boolean
}
interface Movement {
  id: string
  kind: 'purchase' | 'usage' | 'waste' | 'count_adjustment'
  occurredAt: string
  quantityBase: number
  packName: string | null
  packCount: number | null
  costMillimes: number | null
  reason: Reason | null
  countedBase: number | null
  note: string | null
  recordedBy: string | null
}
interface CountResult {
  stockItemId: string
  countedBase: number
  differenceBase: number
}
interface ReportLine {
  stockItemId: string
  name: string
  baseUnit: BaseUnit
  openingBase: number
  purchasedBase: number
  purchaseCostMillimes: number
  wastedBase: number
  usedBase: number
  closingBase: number
}

const PLACES: { value: Place; label: string }[] = [
  { value: 'fridge', label: 'Réfrigérateur' },
  { value: 'freezer', label: 'Congélateur' },
  { value: 'dry_store', label: 'Réserve sèche' },
  { value: 'bar', label: 'Bar' },
  { value: 'other', label: 'Autre' },
]

const REASONS: { value: Reason; label: string }[] = [
  { value: 'spoiled', label: 'Abîmé' },
  { value: 'expired', label: 'Périmé' },
  { value: 'burnt', label: 'Brûlé ou raté' },
  { value: 'dropped', label: 'Tombé ou renversé' },
  { value: 'other', label: 'Autre' },
]
const REASON_FR = Object.fromEntries(REASONS.map((r) => [r.value, r.label])) as Record<Reason, string>

const UNITS: { value: BaseUnit; label: string }[] = [
  { value: 'g', label: 'Au poids (kg)' },
  { value: 'ml', label: 'Au volume (L)' },
  { value: 'piece', label: 'À la pièce' },
]

const KIND_FR: Record<Movement['kind'], string> = {
  purchase: 'Livraison',
  usage: 'Utilisation',
  waste: 'Perte',
  count_adjustment: 'Inventaire',
}

const quantityHint = (unit: BaseUnit) => (unit === 'piece' ? 'Nombre entier, exemple : 12' : `En ${displayUnit(unit)}, exemple : 1,5`)

function dayInTunis(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date(Date.now() + offsetDays * 86_400_000))
}

type Tab = 'products' | 'count' | 'report'
type Open =
  | { kind: 'newItem' }
  | { kind: 'editItem'; item: Item }
  | { kind: 'movement'; item: Item; movement: 'purchase' | 'usage' | 'waste' }
  | { kind: 'packs'; item: Item }
  | { kind: 'history'; item: Item }
  | null

export function Stock() {
  const [tab, setTab] = useState<Tab>('products')
  const [items, setItems] = useState<Item[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [open, setOpen] = useState<Open>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const action = useAction()

  const load = useCallback(() => {
    get<Item[]>(`/stock/items${showArchived ? '?archived=true' : ''}`).then(
      (list) => {
        setItems(list)
        setLoadError(null)
      },
      (e) => setLoadError(errorText(e)),
    )
  }, [showArchived])
  useEffect(load, [load])

  const show = (next: Tab) => {
    setTab(next)
    setFlash(null)
  }

  const done = (message?: { kind: 'ok' | 'error'; text: string }) => {
    setOpen(null)
    setFlash(message ?? null)
    load()
  }

  const active = (items ?? []).filter((i) => !i.archived)
  const lowCount = active.filter((i) => i.belowAlert || i.quantityBase < 0).length
  const valued = active.filter((i) => i.estimatedValueMillimes !== null)
  const totalValue = valued.reduce((sum, i) => sum + Math.max(0, i.estimatedValueMillimes ?? 0), 0)

  return (
    <>
      <div className="page-head">
        <h1>Stock</h1>
        <div className="segmented" role="tablist">
          <button className={tab === 'products' ? 'on' : undefined} onClick={() => show('products')}>Produits</button>
          <button className={tab === 'count' ? 'on' : undefined} onClick={() => show('count')}>Inventaire</button>
          <button className={tab === 'report' ? 'on' : undefined} onClick={() => show('report')}>Rapport</button>
        </div>
      </div>
      <Notice>{loadError}</Notice>
      {flash && <Notice kind={flash.kind}>{flash.text}</Notice>}
      <Notice>{action.error}</Notice>

      {tab === 'products' && (
        <>
          <p className="muted">
            Saisissez chaque livraison et chaque perte. Comptez vos produits régulièrement dans l’onglet « Inventaire » :
            le logiciel calcule alors ce qui a vraiment été utilisé.
          </p>
          {items && active.length > 0 && (
            <div className="stats">
              <div className="stat">
                <span className="stat-label">Produits suivis</span>
                <span className="stat-value">{active.length}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Sous le seuil d’alerte</span>
                <span className="stat-value">{lowCount}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Valeur estimée du stock</span>
                <span className="stat-value">{valued.length > 0 ? format(totalValue) : '—'}</span>
                <span className="muted small">Au dernier prix d’achat, {valued.length} produit(s) sur {active.length}</span>
              </div>
            </div>
          )}

          <div className="toolbar">
            <button className="primary" onClick={() => setOpen({ kind: 'newItem' })}>+ Produit</button>
            <label className="toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Afficher les produits archivés
            </label>
          </div>

          {items?.length === 0 && (
            <p className="empty">
              Aucun produit. Commencez par les 20 à 40 produits qui coûtent le plus cher ou disparaissent le plus vite :
              viande, poisson, fromage, huile, café, boissons.
            </p>
          )}

          {PLACES.map((place) => {
            const rows = (items ?? []).filter((i) => i.storagePlace === place.value)
            if (rows.length === 0) return null
            return (
              <Panel key={place.value} title={place.label}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Produit</th>
                        <th className="num">En stock</th>
                        <th className="num">Seuil d’alerte</th>
                        <th className="num">Valeur estimée</th>
                        <th>Dernier inventaire</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((item) => (
                        <tr key={item.id} className={item.archived ? 'archived' : item.belowAlert || item.quantityBase < 0 ? 'warn' : undefined}>
                          <td>
                            <strong>{item.name}</strong>
                            {item.archived && <span className="tag">archivé</span>}
                            {!item.archived && item.quantityBase < 0 && <span className="tag">négatif</span>}
                            {!item.archived && item.quantityBase >= 0 && item.belowAlert && <span className="tag">à commander</span>}
                            {item.packs.length > 0 && <div className="muted small">{item.packs.map((p) => p.name).join(' · ')}</div>}
                          </td>
                          <td className="num"><strong>{formatQuantity(item.quantityBase, item.baseUnit)}</strong></td>
                          <td className="num muted">{item.alertLevelBase === null ? '—' : formatQuantity(item.alertLevelBase, item.baseUnit)}</td>
                          <td className="num muted">{item.estimatedValueMillimes === null ? '—' : format(item.estimatedValueMillimes)}</td>
                          <td className="muted small">{item.lastCountAt ? dateTime(item.lastCountAt) : 'jamais'}</td>
                          <td className="row-actions stock-actions">
                            <div>
                            {item.archived ? (
                              <button onClick={() => action.run(async () => { await post(`/stock/items/${item.id}/restore`); load() })}>Réactiver</button>
                            ) : (
                              <>
                                <button className="primary" onClick={() => setOpen({ kind: 'movement', item, movement: 'purchase' })}>Livraison</button>
                                <button onClick={() => setOpen({ kind: 'movement', item, movement: 'waste' })}>Perte</button>
                                <button onClick={() => setOpen({ kind: 'movement', item, movement: 'usage' })}>Utilisation</button>
                                <button onClick={() => setOpen({ kind: 'history', item })}>Historique</button>
                                <button onClick={() => setOpen({ kind: 'packs', item })}>Formats</button>
                                <button onClick={() => setOpen({ kind: 'editItem', item })}>Modifier</button>
                                <button onClick={() => action.run(async () => { await post(`/stock/items/${item.id}/archive`); load() })}>Archiver</button>
                              </>
                            )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )
          })}
        </>
      )}

      {tab === 'count' && items && <CountSheet items={active} onDone={(text) => { setFlash({ kind: 'ok', text }); load() }} />}
      {tab === 'report' && <Report />}

      {open?.kind === 'newItem' && <ItemForm onClose={() => setOpen(null)} onDone={() => done()} />}
      {open?.kind === 'editItem' && <ItemForm item={open.item} onClose={() => setOpen(null)} onDone={() => done()} />}
      {open?.kind === 'movement' && <MovementForm item={open.item} kind={open.movement} onClose={() => setOpen(null)} onDone={done} />}
      {open?.kind === 'packs' && <Packs item={open.item} onClose={() => { setOpen(null); load() }} />}
      {open?.kind === 'history' && <History item={open.item} onClose={() => setOpen(null)} />}
    </>
  )
}

function ItemForm({ item, onClose, onDone }: { item?: Item; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(item?.name ?? '')
  const [unit, setUnit] = useState<BaseUnit>(item?.baseUnit ?? 'g')
  const [place, setPlace] = useState<Place>(item?.storagePlace ?? 'fridge')
  const [alert, setAlert] = useState(item?.alertLevelBase == null ? '' : formatQuantityPlain(item.alertLevelBase, item.baseUnit))
  const { busy, error, setError, run } = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    let alertLevelBase: number | null = null
    if (alert.trim()) {
      alertLevelBase = parseQuantity(alert, unit)
      if (alertLevelBase === null) return setError(`Seuil invalide. ${quantityHint(unit)}`)
    }
    await run(async () => {
      if (item) await patch(`/stock/items/${item.id}`, { name, storagePlace: place, alertLevelBase })
      else await post('/stock/items', { name, baseUnit: unit, storagePlace: place, alertLevelBase })
      onDone()
    })
  }

  return (
    <Dialog title={item ? `Modifier — ${item.name}` : 'Nouveau produit'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Nom du produit">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus placeholder="Exemple : Mozzarella" />
        </Field>
        <div className="two">
          <Field label="Compté" hint={item ? 'Ne peut plus changer : tout l’historique est compté ainsi' : 'Ne pourra plus changer ensuite'}>
            <select value={unit} onChange={(e) => setUnit(e.target.value as BaseUnit)} disabled={!!item}>
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </Field>
          <Field label="Rangé">
            <select value={place} onChange={(e) => setPlace(e.target.value as Place)}>
              {PLACES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label={`Seuil d’alerte en ${displayUnit(unit)} (facultatif)`} hint="Le produit passe en orange en dessous de cette quantité">
          <input inputMode="decimal" value={alert} onChange={(e) => setAlert(e.target.value)} />
        </Field>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>{item ? 'Enregistrer' : 'Ajouter le produit'}</button>
      </form>
    </Dialog>
  )
}

function MovementForm({ item, kind, onClose, onDone }: {
  item: Item
  kind: 'purchase' | 'usage' | 'waste'
  onClose: () => void
  onDone: (message: { kind: 'ok' | 'error'; text: string }) => void
}) {
  const [packId, setPackId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [packCount, setPackCount] = useState('1')
  const [cost, setCost] = useState('')
  const [reason, setReason] = useState<Reason>('spoiled')
  const [note, setNote] = useState('')
  const { busy, error, setError, run } = useAction()
  const pack = item.packs.find((p) => p.id === packId)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: Record<string, unknown> = { kind }
    if (kind === 'purchase' && pack) {
      const n = Number(packCount)
      if (!Number.isInteger(n) || n < 1 || n > 10_000) return setError('Nombre de colis invalide')
      body.packId = pack.id
      body.packCount = n
    } else {
      const q = parseQuantity(quantity, item.baseUnit)
      if (q === null || q === 0) return setError(`Quantité invalide. ${quantityHint(item.baseUnit)}`)
      body.quantityBase = q
    }
    if (kind === 'purchase' && cost.trim()) {
      const c = parseTnd(cost)
      if (c === null) return setError('Montant invalide. Exemple : 45,600')
      body.costMillimes = c
    }
    if (kind === 'waste') body.reason = reason
    if (note.trim()) body.note = note.trim()

    await run(async () => {
      const r = await post<MovementResult>(`/stock/items/${item.id}/movements`, body)
      const after = formatQuantity(r.stockAfterBase, item.baseUnit)
      if (r.belowZero) {
        onDone({ kind: 'error', text: `${item.name} : le stock devient négatif (${after}). Une livraison n’a peut-être pas été saisie, ou il faut refaire l’inventaire.` })
      } else if (r.belowAlert) {
        onDone({ kind: 'error', text: `${item.name} : ${after} en stock, sous le seuil d’alerte. Pensez à commander.` })
      } else {
        onDone({ kind: 'ok', text: `${KIND_FR[kind]} enregistrée. ${item.name} : ${after} en stock.` })
      }
    })
  }

  const titles = { purchase: 'Livraison reçue', usage: 'Utilisation', waste: 'Perte' }
  return (
    <Dialog title={`${titles[kind]} — ${item.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        {kind === 'purchase' && item.packs.length > 0 && (
          <Field label="Livré">
            <select value={packId} onChange={(e) => setPackId(e.target.value)}>
              <option value="">En quantité ({displayUnit(item.baseUnit)})</option>
              {item.packs.map((p) => (
                <option key={p.id} value={p.id}>En colis : {p.name} ({formatQuantity(p.quantityBase, item.baseUnit)})</option>
              ))}
            </select>
          </Field>
        )}
        {kind === 'purchase' && pack ? (
          <Field label="Nombre de colis">
            <input inputMode="numeric" value={packCount} onChange={(e) => setPackCount(e.target.value)} required autoFocus />
          </Field>
        ) : (
          <Field label={`Quantité en ${displayUnit(item.baseUnit)}`} hint={quantityHint(item.baseUnit)}>
            <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} required autoFocus />
          </Field>
        )}
        {kind === 'purchase' && pack && Number.isInteger(Number(packCount)) && Number(packCount) > 0 && (
          <p className="preview">= {formatQuantity(pack.quantityBase * Number(packCount), item.baseUnit)}</p>
        )}
        {kind === 'purchase' && (
          <Field label="Montant payé hors TVA, en TND (facultatif)" hint="Recopiez le bon de livraison. Sert à calculer la valeur du stock et le coût des produits.">
            <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
        )}
        {kind === 'waste' && (
          <Field label="Raison">
            <select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Remarque (facultatif)">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <p className="muted small">La date, l’heure et votre nom sont enregistrés automatiquement. Une erreur ne s’efface pas : elle se corrige par un nouvel inventaire.</p>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Enregistrer</button>
      </form>
    </Dialog>
  )
}

function Packs({ item, onClose }: { item: Item; onClose: () => void }) {
  const [packs, setPacks] = useState(item.packs)
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const { busy, error, setError, run } = useAction()

  const reload = async () => {
    const fresh = await get<Item>(`/stock/items/${item.id}`)
    setPacks(fresh.packs)
  }

  return (
    <Dialog title={`Formats de livraison — ${item.name}`} onClose={onClose}>
      <p className="muted small">
        Un format permet de saisir une livraison en colis (« 2 caisses ») : le logiciel convertit en {displayUnit(item.baseUnit)}.
      </p>
      {packs.length > 0 && (
        <table>
          <tbody>
            {packs.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{formatQuantity(p.quantityBase, item.baseUnit)}</td>
                <td className="row-actions">
                  <button onClick={() => run(async () => { await post(`/stock/items/${item.id}/packs/${p.id}/archive`); await reload() })} disabled={busy}>Retirer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const q = parseQuantity(quantity, item.baseUnit)
          if (q === null || q === 0) return setError(`Quantité invalide. ${quantityHint(item.baseUnit)}`)
          run(async () => {
            await post(`/stock/items/${item.id}/packs`, { name, quantityBase: q })
            setName('')
            setQuantity('')
            await reload()
          })
        }}
      >
        <div className="two">
          <Field label="Nom du format">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Caisse de 12 bouteilles" />
          </Field>
          <Field label={`Contenu en ${displayUnit(item.baseUnit)}`} hint={quantityHint(item.baseUnit)}>
            <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </Field>
        </div>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Ajouter le format</button>
      </form>
    </Dialog>
  )
}

function History({ item, onClose }: { item: Item; onClose: () => void }) {
  const [rows, setRows] = useState<Movement[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    get<Movement[]>(`/stock/items/${item.id}/movements`).then(setRows, (e) => setError(errorText(e)))
  }, [item.id])
  const q = (n: number) => formatQuantity(n, item.baseUnit)
  return (
    <Dialog title={`Historique — ${item.name}`} onClose={onClose}>
      <Notice>{error}</Notice>
      {rows?.length === 0 && <p className="muted">Aucun mouvement pour l’instant.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Quand</th>
                <th>Quoi</th>
                <th className="num">Quantité</th>
                <th>Par</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap">{dateTime(m.occurredAt)}</td>
                  <td>
                    {KIND_FR[m.kind]}
                    <div className="muted small">
                      {m.packName && `${m.packCount} × ${m.packName}`}
                      {m.costMillimes !== null && ` · ${format(m.costMillimes)} HT`}
                      {m.reason && REASON_FR[m.reason]}
                      {m.countedBase !== null && `Compté : ${q(m.countedBase)}`}
                      {m.note && ` · ${m.note}`}
                    </div>
                  </td>
                  <td className="num">{m.quantityBase > 0 ? '+' : ''}{q(m.quantityBase)}</td>
                  <td className="small">{m.recordedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  )
}

// The weekly count: products listed in the order they sit on the shelves.
// Only the lines that are filled in are sent; empty lines are "not counted this time".
function CountSheet({ items, onDone }: { items: Item[]; onDone: (message: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [results, setResults] = useState<CountResult[] | null>(null)
  const { busy, error, setError, run } = useAction()
  const byId = new Map(items.map((i) => [i.id, i]))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const lines: { stockItemId: string; countedBase: number }[] = []
    for (const item of items) {
      const text = values[item.id]?.trim()
      if (!text) continue
      const counted = parseQuantity(text, item.baseUnit)
      if (counted === null) return setError(`${item.name} : quantité invalide. ${quantityHint(item.baseUnit)}`)
      lines.push({ stockItemId: item.id, countedBase: counted })
    }
    if (lines.length === 0) return setError('Saisissez au moins une quantité comptée.')
    const r = await run(() => post<CountResult[]>('/stock/counts', { lines, ...(note.trim() ? { note: note.trim() } : {}) }))
    if (r) {
      setResults(r)
      setValues({})
      setNote('')
      onDone(`Inventaire enregistré : ${r.length} produit(s) compté(s).`)
    }
  }

  if (items.length === 0) return <p className="empty">Ajoutez d’abord des produits dans l’onglet « Produits ».</p>

  return (
    <>
      <p className="muted">
        Comptez ce qui est réellement sur les étagères et saisissez-le. Laissez vide ce que vous ne comptez pas aujourd’hui.
        Le logiciel enregistre l’écart avec ce qu’il attendait : un écart négatif = de la marchandise manquante.
      </p>
      {results && (
        <Panel title="Résultat du dernier inventaire" actions={<button onClick={() => setResults(null)}>Fermer</button>}>
          <table>
            <thead>
              <tr>
                <th>Produit</th>
                <th className="num">Compté</th>
                <th className="num">Écart</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const item = byId.get(r.stockItemId)
                if (!item) return null
                return (
                  <tr key={r.stockItemId} className={r.differenceBase < 0 ? 'warn' : undefined}>
                    <td>{item.name}</td>
                    <td className="num">{formatQuantity(r.countedBase, item.baseUnit)}</td>
                    <td className="num">{r.differenceBase > 0 ? '+' : ''}{formatQuantity(r.differenceBase, item.baseUnit)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>
      )}
      <form onSubmit={submit}>
        {PLACES.map((place) => {
          const rows = items.filter((i) => i.storagePlace === place.value)
          if (rows.length === 0) return null
          return (
            <Panel key={place.value} title={place.label}>
              <table className="count-table">
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th className="num">Attendu</th>
                    <th className="num">Compté</th>
                    <th className="num">Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const text = values[item.id] ?? ''
                    const counted = text.trim() ? parseQuantity(text, item.baseUnit) : null
                    const diff = counted === null ? null : counted - item.quantityBase
                    return (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td className="num muted">{formatQuantity(item.quantityBase, item.baseUnit)}</td>
                        <td className="num">
                          <input
                            className="count-input"
                            inputMode="decimal"
                            aria-label={`${item.name}, quantité comptée en ${displayUnit(item.baseUnit)}`}
                            placeholder={displayUnit(item.baseUnit)}
                            value={text}
                            onChange={(e) => setValues({ ...values, [item.id]: e.target.value })}
                          />
                        </td>
                        <td className="num">
                          {text.trim() && counted === null && <span className="muted small">invalide</span>}
                          {diff !== null && `${diff > 0 ? '+' : ''}${formatQuantity(diff, item.baseUnit)}`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Panel>
          )
        })}
        <Field label="Remarque (facultatif)">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Exemple : inventaire du lundi matin" />
        </Field>
        <Notice>{error}</Notice>
        <button className="primary wide" disabled={busy}>Enregistrer l’inventaire</button>
      </form>
    </>
  )
}

function Report() {
  const [from, setFrom] = useState(dayInTunis(-7))
  const [to, setTo] = useState(dayInTunis())
  const [rows, setRows] = useState<ReportLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    get<ReportLine[]>(`/stock/report?from=${from}&to=${to}`).then(
      (r) => {
        setRows(r)
        setError(null)
      },
      (e) => setError(errorText(e)),
    )
  }, [from, to])

  const totalCost = (rows ?? []).reduce((sum, r) => sum + r.purchaseCostMillimes, 0)
  return (
    <>
      <p className="muted">
        Ce qui s’est passé pour chaque produit entre deux dates. Le plus utile : choisir les jours de deux inventaires.
        « Utilisé » = stock de début + livré − pertes − stock de fin.
      </p>
      <div className="toolbar">
        <Field label="Du">
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
      </div>
      <Notice>{error}</Notice>
      {rows?.length === 0 && <p className="empty">Aucun produit.</p>}
      {rows && rows.length > 0 && (
        <Panel title="Mouvements de la période" actions={<span className="muted small">Achats de la période : <strong>{format(totalCost)}</strong> HT</span>}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Produit</th>
                  <th className="num">Stock début</th>
                  <th className="num">Livré</th>
                  <th className="num">Coût livré</th>
                  <th className="num">Pertes</th>
                  <th className="num">Utilisé</th>
                  <th className="num">Stock fin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const q = (n: number) => formatQuantity(n, r.baseUnit)
                  return (
                    <tr key={r.stockItemId}>
                      <td>{r.name}</td>
                      <td className="num muted">{q(r.openingBase)}</td>
                      <td className="num">{q(r.purchasedBase)}</td>
                      <td className="num muted">{r.purchaseCostMillimes ? format(r.purchaseCostMillimes) : '—'}</td>
                      <td className="num">{q(r.wastedBase)}</td>
                      <td className="num"><strong>{q(r.usedBase)}</strong></td>
                      <td className="num">{q(r.closingBase)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  )
}
