import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { chairPositions, footprint, isRound, type Floor, type FloorItem } from '../floor'

// The dining room in 3D. Everything is built from simple shapes in code (no model files),
// in a low-poly "management game" style with Sidi Bou Saïd colours.
// 1 unit in the scene = 1 metre; the room data is in centimetres.

const C = {
  blue: '#1d4f91',
  blueLight: '#3d7cc9',
  white: '#f7f5f0',
  sand: '#e9dcc3',
  sandDark: '#d8c6a3',
  wood: '#a5714a',
  woodDark: '#7a4f31',
  steel: '#b9c0c8',
  leaf: '#4f8a4b',
  terracotta: '#c0643a',
  selected: '#f2a531',
}

const m = (cm: number) => cm / 100

export default function Room3D({ floor, selected, onSelect }: {
  floor: Floor
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const W = m(floor.widthCm)
  const D = m(floor.depthCm)
  const size = Math.max(W, D)

  return (
    <div className="stage-3d">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: [W / 2 + size * 0.15, size * 0.85, D + size * 0.55], fov: 45, near: 0.1, far: 200 }}
        onPointerMissed={() => onSelect(null)}
      >
        <color attach="background" args={['#cfe3f6']} />
        <hemisphereLight args={['#ffffff', '#c9b896', 0.9]} />
        <directionalLight
          position={[W * 0.2, 9, D * 0.1]}
          intensity={1.6}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-size}
          shadow-camera-right={size}
          shadow-camera-top={size}
          shadow-camera-bottom={-size}
        />
        <Room W={W} D={D} />
        {floor.items.map((item) => (
          <Item key={item.id} item={item} selected={item.id === selected} onSelect={() => onSelect(item.id)} />
        ))}
        <OrbitControls
          target={[W / 2, 0, D / 2]}
          maxPolarAngle={Math.PI / 2.15}
          minDistance={2}
          maxDistance={size * 2.5}
          enableDamping
        />
      </Canvas>
    </div>
  )
}

// Tiled floor (like Tunisian cement tiles) and two low walls with a blue band.
function Room({ W, D }: { W: number; D: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const g = canvas.getContext('2d')!
    g.fillStyle = C.sand
    g.fillRect(0, 0, 128, 128)
    g.fillStyle = C.sandDark
    g.fillRect(0, 0, 64, 64)
    g.fillRect(64, 64, 64, 64)
    g.fillStyle = C.blueLight
    g.globalAlpha = 0.35
    for (const [x, y] of [[32, 32], [96, 96], [96, 32], [32, 96]]) {
      g.beginPath()
      g.moveTo(x, y - 10)
      g.lineTo(x + 10, y)
      g.lineTo(x, y + 10)
      g.lineTo(x - 10, y)
      g.closePath()
      g.fill()
    }
    const t = new THREE.CanvasTexture(canvas)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(W / 0.8, D / 0.8)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [W, D])

  const wallH = 1.1
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[W / 2, 0, D / 2]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial map={texture} />
      </mesh>
      {/* Back wall and left wall, low so the camera always sees inside. */}
      <Wall x={W / 2} z={-0.05} w={W + 0.2} d={0.1} h={wallH} />
      <Wall x={-0.05} z={D / 2} w={0.1} d={D + 0.2} h={wallH} />
    </group>
  )
}

function Wall({ x, z, w, d, h }: { x: number; z: number; w: number; d: number; h: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position-y={h / 2} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={C.white} />
      </mesh>
      <mesh position-y={h - 0.08}>
        <boxGeometry args={[w + 0.01, 0.12, d + 0.01]} />
        <meshStandardMaterial color={C.blue} />
      </mesh>
    </group>
  )
}

function Item({ item, selected, onSelect }: { item: FloorItem; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false)
  const highlight = selected || hover
  return (
    <group
      position={[m(item.xCm), 0, m(item.zCm)]}
      rotation-y={(-item.rotationDeg * Math.PI) / 180}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHover(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHover(false)
        document.body.style.cursor = ''
      }}
    >
      {item.kind === 'table' && <Table item={item} highlight={highlight} />}
      {item.kind === 'counter' && <Counter item={item} highlight={highlight} />}
      {item.kind === 'kitchen' && <Kitchen item={item} highlight={highlight} />}
      {item.kind === 'plant' && <Plant />}
      {item.kind === 'door' && <Door highlight={highlight} />}
      {(item.kind === 'table' || selected) && (
        <Label
          text={item.kind === 'table' ? `${item.label} · ${item.seats} pl.` : item.label}
          y={item.kind === 'kitchen' ? 2.1 : item.kind === 'door' ? 2.6 : 1.25}
          on={selected}
        />
      )}
    </group>
  )
}

function Table({ item, highlight }: { item: FloorItem; highlight: boolean }) {
  const { w, d } = footprint(item)
  const top = highlight ? C.selected : C.white
  return (
    <group>
      {isRound(item) ? (
        <mesh position-y={0.74} castShadow receiveShadow>
          <cylinderGeometry args={[m(w / 2), m(w / 2), 0.05, 28]} />
          <meshStandardMaterial color={top} />
        </mesh>
      ) : (
        <mesh position-y={0.74} castShadow receiveShadow>
          <boxGeometry args={[m(w), 0.05, m(d)]} />
          <meshStandardMaterial color={top} />
        </mesh>
      )}
      <mesh position-y={0.36} castShadow>
        <cylinderGeometry args={[0.05, 0.08, 0.72, 10]} />
        <meshStandardMaterial color={C.woodDark} />
      </mesh>
      {chairPositions(item).map((c, i) => (
        <Chair key={i} x={m(c.x)} z={m(c.z)} angle={c.angle} />
      ))}
    </group>
  )
}

// A simple blue chair facing the table.
function Chair({ x, z, angle }: { x: number; z: number; angle: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={angle}>
      <mesh position-y={0.45} castShadow>
        <boxGeometry args={[0.4, 0.05, 0.4]} />
        <meshStandardMaterial color={C.blue} />
      </mesh>
      <mesh position={[0, 0.72, 0.18]} castShadow>
        <boxGeometry args={[0.4, 0.5, 0.05]} />
        <meshStandardMaterial color={C.blue} />
      </mesh>
      {[[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.22, lz]}>
          <boxGeometry args={[0.04, 0.45, 0.04]} />
          <meshStandardMaterial color={C.blue} />
        </mesh>
      ))}
    </group>
  )
}

function Counter({ item, highlight }: { item: FloorItem; highlight: boolean }) {
  const { w, d } = footprint(item)
  return (
    <group>
      <mesh position-y={0.55} castShadow receiveShadow>
        <boxGeometry args={[m(w), 1.1, m(d)]} />
        <meshStandardMaterial color={C.wood} />
      </mesh>
      <mesh position-y={1.12} castShadow>
        <boxGeometry args={[m(w) + 0.1, 0.05, m(d) + 0.1]} />
        <meshStandardMaterial color={highlight ? C.selected : C.white} />
      </mesh>
    </group>
  )
}

function Kitchen({ item, highlight }: { item: FloorItem; highlight: boolean }) {
  const { w, d } = footprint(item)
  return (
    <group>
      <mesh position-y={0.45} castShadow receiveShadow>
        <boxGeometry args={[m(w), 0.9, m(d)]} />
        <meshStandardMaterial color={highlight ? C.selected : C.steel} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Two cooking hobs on top */}
      {[-0.6, 0.6].map((x) => (
        <mesh key={x} position={[x, 0.92, 0]}>
          <cylinderGeometry args={[0.25, 0.25, 0.04, 20]} />
          <meshStandardMaterial color="#333" />
        </mesh>
      ))}
      <mesh position={[0, 1.6, -m(d) / 2 + 0.2]} castShadow>
        <boxGeometry args={[m(w) * 0.6, 0.35, 0.4]} />
        <meshStandardMaterial color={C.steel} metalness={0.4} />
      </mesh>
    </group>
  )
}

function Plant() {
  return (
    <group>
      <mesh position-y={0.2} castShadow>
        <cylinderGeometry args={[0.18, 0.14, 0.4, 12]} />
        <meshStandardMaterial color={C.terracotta} />
      </mesh>
      <mesh position-y={0.75} castShadow>
        <icosahedronGeometry args={[0.38, 0]} />
        <meshStandardMaterial color={C.leaf} flatShading />
      </mesh>
    </group>
  )
}

// A blue Sidi Bou Saïd door with its rounded top.
const ARCH = (() => {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, 0.5, 0, Math.PI, false)
  shape.lineTo(0.5, 0)
  return new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false, curveSegments: 20 })
})()

function Door({ highlight }: { highlight: boolean }) {
  const color = highlight ? C.selected : C.blue
  return (
    <group>
      <mesh position-y={0.95} castShadow>
        <boxGeometry args={[1, 1.9, 0.12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh geometry={ARCH} position={[0, 1.9, -0.06]} castShadow>
        <meshStandardMaterial color={color} />
      </mesh>
      {[0.6, 1.2].map((y) => (
        <mesh key={y} position={[0, y, 0.07]}>
          <boxGeometry args={[0.8, 0.03, 0.02]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      ))}
    </group>
  )
}

// A name tag floating above an item, drawn into a small image (no web page elements
// inside the 3D scene, which keeps it fast and stable).
function Label({ text, y, on }: { text: string; y: number; on: boolean }) {
  const { texture, aspect } = useMemo(() => {
    const scale = 2
    const font = `600 ${28 * scale}px Segoe UI, system-ui, sans-serif`
    const probe = document.createElement('canvas').getContext('2d')!
    probe.font = font
    const w = Math.ceil(probe.measureText(text).width) + 36 * scale
    const h = 48 * scale
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')!
    g.fillStyle = on ? C.selected : 'rgba(255,255,255,0.94)'
    g.beginPath()
    g.roundRect(2, 2, w - 4, h - 4, h / 2)
    g.fill()
    g.strokeStyle = on ? C.selected : '#d9d2c3'
    g.lineWidth = 3
    g.stroke()
    g.font = font
    g.fillStyle = on ? '#ffffff' : '#153a6b'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + 2)
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    return { texture: t, aspect: w / h }
  }, [text, on])
  useEffect(() => () => texture.dispose(), [texture])
  const height = 0.42
  return (
    <sprite position={[0, y, 0]} scale={[height * aspect, height, 1]} renderOrder={10}>
      <spriteMaterial map={texture} depthTest={false} transparent />
    </sprite>
  )
}
