// Shared description of the dining room, used by the room editor (seen from above)
// and by the 3D view. All sizes are in centimetres.

export type FloorKind = 'table' | 'counter' | 'kitchen' | 'plant' | 'door'

export interface FloorItem {
  id: string
  kind: FloorKind
  label: string
  seats: number | null
  xCm: number
  zCm: number
  rotationDeg: number
}

export interface Floor {
  widthCm: number
  depthCm: number
  items: FloorItem[]
}

export const KIND_FR: Record<FloorKind, string> = {
  table: 'Table',
  counter: 'Comptoir',
  kitchen: 'Cuisine',
  plant: 'Plante',
  door: 'Porte',
}

// Small tables (up to 4 seats) are round; bigger ones are long rectangles.
export function isRound(item: Pick<FloorItem, 'kind' | 'seats'>): boolean {
  return item.kind === 'table' && (item.seats ?? 0) <= 4
}

// Footprint of each item, before rotation: width (along x) and depth (along z).
export function footprint(item: Pick<FloorItem, 'kind' | 'seats'>): { w: number; d: number } {
  switch (item.kind) {
    case 'table': {
      const seats = item.seats ?? 2
      if (seats <= 4) return { w: 90, d: 90 }
      return { w: 80 + Math.ceil(seats / 2) * 60, d: 90 }
    }
    case 'counter':
      return { w: 300, d: 70 }
    case 'kitchen':
      return { w: 320, d: 220 }
    case 'plant':
      return { w: 50, d: 50 }
    case 'door':
      return { w: 110, d: 20 }
  }
}

// Where the chairs go around a table, relative to its centre (before rotation).
export function chairPositions(item: Pick<FloorItem, 'kind' | 'seats'>): { x: number; z: number; angle: number }[] {
  const seats = item.seats ?? 0
  if (item.kind !== 'table' || seats === 0) return []
  if (isRound(item)) {
    return Array.from({ length: seats }, (_, i) => {
      const a = (i / seats) * Math.PI * 2
      return { x: Math.sin(a) * 75, z: Math.cos(a) * 75, angle: a }
    })
  }
  const { w } = footprint(item)
  const perSide = Math.ceil(seats / 2)
  const step = (w - 40) / perSide
  return Array.from({ length: seats }, (_, i) => {
    const side = i < perSide ? 1 : -1
    const k = i < perSide ? i : i - perSide
    return { x: -w / 2 + 20 + step * (k + 0.5), z: side * 70, angle: side === 1 ? 0 : Math.PI }
  })
}
