import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { get, patch, post, put, type Me } from '../api'
import { chairPositions, footprint, isRound, KIND_FR, type Floor, type FloorItem, type FloorKind } from '../floor'
import { errorText, useAction } from '../helpers'
import { Field, Notice, Panel } from '../ui'

// The 3D view is loaded only when asked for, so the rest of the site stays fast.
const Room3D = lazy(() => import('./Room3D'))

export function Room({ me }: { me: Me }) {
  const canEdit = me.role !== 'waiter'
  const [floor, setFloor] = useState<Floor | null>(null)
  const [mode, setMode] = useState<'3d' | 'plan'>('3d')
  const [selected, setSelected] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()

  const load = useCallback(() => {
    get<Floor>('/floor').then(setFloor, (e) => setLoadError(errorText(e)))
  }, [])
  useEffect(load, [load])

  const item = floor?.items.find((i) => i.id === selected) ?? null

  async function add(kind: FloorKind) {
    if (!floor) return
    const tables = floor.items.filter((i) => i.kind === 'table').length
    let label: string = KIND_FR[kind]
    if (kind === 'table') {
      const used = new Set(floor.items.map((i) => i.label.toLowerCase()))
      let n = tables + 1
      while (used.has(`t${n}`)) n++
      label = `T${n}`
    }
    await action.run(async () => {
      const r = await post<{ id: string }>('/floor/items', {
        kind,
        label,
        ...(kind === 'table' ? { seats: 4 } : {}),
        xCm: Math.round(floor.widthCm / 2),
        zCm: Math.round(floor.depthCm / 2),
      })
      setMode('plan')
      setSelected(r.id)
      load()
    })
  }

  async function change(id: string, changes: Partial<Pick<FloorItem, 'label' | 'seats' | 'xCm' | 'zCm' | 'rotationDeg'>>) {
    // Show the change at once, then save it; reload if the server refuses.
    setFloor((f) => (f ? { ...f, items: f.items.map((i) => (i.id === id ? { ...i, ...changes } : i)) } : f))
    const ok = await action.run(async () => {
      await patch(`/floor/items/${id}`, changes)
      return true
    })
    if (!ok) load()
  }

  return (
    <>
      <div className="page-head">
        <h1>Salle</h1>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === '3d'} className={mode === '3d' ? 'on' : ''} onClick={() => setMode('3d')}>
            Vue 3D
          </button>
          <button role="tab" aria-selected={mode === 'plan'} className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>
            Plan {canEdit ? '(modifier)' : ''}
          </button>
        </div>
      </div>
      <Notice>{loadError}</Notice>
      <Notice>{action.error}</Notice>

      {canEdit && (
        <div className="toolbar">
          <span className="muted small">Ajouter :</span>
          {(['table', 'counter', 'kitchen', 'plant', 'door'] as FloorKind[]).map((k) => (
            <button key={k} onClick={() => add(k)} disabled={action.busy}>
              + {KIND_FR[k]}
            </button>
          ))}
        </div>
      )}

      {floor && floor.items.length === 0 && (
        <p className="empty">
          La salle est vide.{canEdit ? ' Ajoutez vos tables, le comptoir et la cuisine, puis placez-les sur le plan.' : ''}
        </p>
      )}

      {floor && (
        <div className="room-layout">
          <div className="room-stage">
            {mode === '3d' ? (
              <Suspense fallback={<div className="stage-loading">Chargement de la vue 3D…</div>}>
                <Room3D floor={floor} selected={selected} onSelect={setSelected} />
              </Suspense>
            ) : (
              <Plan floor={floor} selected={selected} onSelect={setSelected} onMove={canEdit ? (id, x, z) => change(id, { xCm: x, zCm: z }) : undefined} />
            )}
          </div>
          <aside className="room-side">
            {item ? (
              <ItemPanel key={item.id} item={item} canEdit={canEdit} onChange={(c) => change(item.id, c)} onRemove={async () => {
                if (!confirm(`Retirer « ${item.label} » de la salle ?`)) return
                await action.run(async () => { await post(`/floor/items/${item.id}/archive`); setSelected(null); load() })
              }} />
            ) : (
              <Panel title="Astuce">
                <p className="muted small">
                  {mode === '3d'
                    ? 'Faites glisser pour tourner autour de la salle, molette ou pincement pour zoomer. Cliquez sur une table pour la voir.'
                    : canEdit
                      ? 'Faites glisser les éléments pour les placer. Cliquez sur un élément pour le renommer, le tourner ou changer le nombre de places.'
                      : 'Cliquez sur une table pour la voir.'}
                </p>
              </Panel>
            )}
            {canEdit && <RoomSize floor={floor} onSaved={load} />}
          </aside>
        </div>
      )}
    </>
  )
}

function ItemPanel({ item, canEdit, onChange, onRemove }: {
  item: FloorItem
  canEdit: boolean
  onChange: (c: Partial<FloorItem>) => void
  onRemove: () => void
}) {
  const [label, setLabel] = useState(item.label)
  return (
    <Panel title={`${KIND_FR[item.kind]} — ${item.label}`}>
      {item.kind === 'table' && (
        <p>
          {item.seats} places · <span className="status-free">Libre</span>
          <br />
          <span className="muted small">L’état des tables (occupée, addition…) arrivera avec la caisse.</span>
        </p>
      )}
      {canEdit && (
        <>
          <Field label="Nom">
            <input value={label} maxLength={30} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== item.label && onChange({ label: label.trim() })} />
          </Field>
          {item.kind === 'table' && (
            <Field label="Places">
              <div className="stepper">
                <button onClick={() => onChange({ seats: Math.max(1, (item.seats ?? 1) - 1) })} aria-label="Une place de moins">−</button>
                <span>{item.seats}</span>
                <button onClick={() => onChange({ seats: Math.min(20, (item.seats ?? 1) + 1) })} aria-label="Une place de plus">+</button>
              </div>
            </Field>
          )}
          <div className="row-gap">
            <button onClick={() => onChange({ rotationDeg: (item.rotationDeg + 45) % 360 })}>↻ Tourner</button>
            <button className="danger" onClick={onRemove}>Retirer</button>
          </div>
        </>
      )}
    </Panel>
  )
}

function RoomSize({ floor, onSaved }: { floor: Floor; onSaved: () => void }) {
  const [w, setW] = useState(String(floor.widthCm / 100))
  const [d, setD] = useState(String(floor.depthCm / 100))
  const { busy, error, run } = useAction()
  return (
    <Panel title="Taille de la salle">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => {
            await put('/floor/plan', {
              widthCm: Math.round(Number(w.replace(',', '.')) * 100),
              depthCm: Math.round(Number(d.replace(',', '.')) * 100),
            })
            onSaved()
          })
        }}
      >
        <div className="two">
          <Field label="Largeur (m)">
            <input inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} />
          </Field>
          <Field label="Profondeur (m)">
            <input inputMode="decimal" value={d} onChange={(e) => setD(e.target.value)} />
          </Field>
        </div>
        <Notice>{error}</Notice>
        <button disabled={busy}>Enregistrer</button>
      </form>
    </Panel>
  )
}

// The room seen from above. Items can be dragged when onMove is given.
function Plan({ floor, selected, onSelect, onMove }: {
  floor: Floor
  selected: string | null
  onSelect: (id: string | null) => void
  onMove?: (id: string, xCm: number, zCm: number) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ id: string; x: number; z: number } | null>(null)

  function toRoom(e: ReactPointerEvent) {
    const s = svg.current!
    const pt = s.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(s.getScreenCTM()!.inverse())
    // Snap to 10 cm and keep inside the room.
    const snap = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v / 10) * 10))
    return { x: snap(p.x, floor.widthCm), z: snap(p.y, floor.depthCm) }
  }

  const grid = []
  for (let x = 100; x < floor.widthCm; x += 100) grid.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={floor.depthCm} />)
  for (let z = 100; z < floor.depthCm; z += 100) grid.push(<line key={`z${z}`} x1={0} y1={z} x2={floor.widthCm} y2={z} />)

  return (
    <svg
      ref={svg}
      className="plan"
      viewBox={`-20 -20 ${floor.widthCm + 40} ${floor.depthCm + 40}`}
      onPointerMove={(e) => drag && setDrag({ id: drag.id, ...toRoom(e) })}
      onPointerUp={() => {
        if (drag && onMove) onMove(drag.id, drag.x, drag.z)
        setDrag(null)
      }}
      onPointerDown={(e) => e.target === svg.current && onSelect(null)}
      role="img"
      aria-label="Plan de la salle vu de dessus"
    >
      <rect className="plan-floor" x={0} y={0} width={floor.widthCm} height={floor.depthCm} rx={6} onPointerDown={() => onSelect(null)} />
      <g className="plan-grid">{grid}</g>
      {floor.items.map((item) => {
        const pos = drag?.id === item.id ? drag : { x: item.xCm, z: item.zCm }
        const { w, d } = footprint(item)
        return (
          <g
            key={item.id}
            className={`plan-item kind-${item.kind}${selected === item.id ? ' selected' : ''}${onMove ? ' movable' : ''}`}
            transform={`translate(${pos.x} ${pos.z}) rotate(${item.rotationDeg})`}
            onPointerDown={(e) => {
              e.stopPropagation()
              onSelect(item.id)
              if (onMove) {
                ;(e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId)
                setDrag({ id: item.id, x: item.xCm, z: item.zCm })
              }
            }}
          >
            {chairPositions(item).map((c, i) => (
              <circle key={i} className="plan-chair" cx={c.x} cy={c.z} r={18} />
            ))}
            {isRound(item) ? <circle r={w / 2} /> : <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={item.kind === 'plant' ? 25 : 8} />}
            <text
              transform={`rotate(${-item.rotationDeg})`}
              y={item.kind === 'plant' ? 48 : item.kind === 'door' ? -34 : 0}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {item.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
