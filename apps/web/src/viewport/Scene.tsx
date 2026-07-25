import { GizmoHelper, GizmoViewport, Grid, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useLayout } from '../store/layout'
import { useViewport, type PartId } from '../store/viewport'
import {
  MM,
  buildRibMatrices,
  buildSkin,
  buildSlabMatrices,
  towerHeight,
  towerRing,
} from './geometry'
import { useLoadedModel } from './loader'

/** Толщина перекрытия, мм. */
const SLAB_THICKNESS = 260

/* ────────────────────────── палитра сцены ────────────────────────── */

function usePalette() {
  const theme = useLayout((s) => s.theme)
  const dark = theme === 'dark'
  return useMemo(
    () => ({
      base: dark ? '#3a3a3a' : '#f0f0f0',
      alt: dark ? '#2a2a2a' : '#dcdcdc',
      clay: dark ? '#333333' : '#e4e4e4',
      glass: dark ? '#4a4a4a' : '#cfcfcf',
      edge: dark ? '#f2f2f2' : '#0a0a0a',
      grid: dark ? '#2e2e2e' : '#dedede',
      gridSection: dark ? '#4a4a4a' : '#b4b4b4',
    }),
    [dark],
  )
}

type Tone = 'base' | 'alt' | 'glass'

/** Материал зависит от режима отображения — тот же набор, что в Rhino/SketchUp. */
function SurfaceMaterial({ tone, active }: { tone: Tone; active: boolean }) {
  const mode = useViewport((s) => s.mode)
  const pal = usePalette()
  const isGlass = tone === 'glass'

  if (mode === 'wire') {
    return <meshBasicMaterial color={pal.edge} wireframe side={THREE.DoubleSide} />
  }
  if (mode === 'xray') {
    return (
      <meshStandardMaterial
        color={active ? pal.edge : pal[tone]}
        transparent
        opacity={active ? 0.3 : 0.12}
        depthWrite={false}
        roughness={1}
        side={THREE.DoubleSide}
      />
    )
  }
  if (mode === 'clay') {
    return (
      <meshStandardMaterial
        color={active ? pal.alt : pal.clay}
        flatShading
        roughness={1}
        metalness={0}
        side={THREE.DoubleSide}
      />
    )
  }
  return (
    <meshStandardMaterial
      color={active ? pal.alt : pal[tone]}
      roughness={0.9}
      metalness={0}
      transparent={isGlass}
      opacity={isGlass ? 0.42 : 1}
      side={THREE.DoubleSide}
    />
  )
}

/* ────────────────────────── камера и статистика ────────────────────────── */

interface OrbitLike {
  target: THREE.Vector3
  update: () => void
}

function CameraRig({ height, radius }: { height: number; radius: number }) {
  const fitToken = useViewport((s) => s.fitToken)
  const projection = useViewport((s) => s.projection)
  const { camera, controls, invalidate } = useThree()

  useEffect(() => {
    const distance = Math.max(height * 1.15, radius * 5)
    camera.position.set(distance * 0.66, Math.max(height * 0.8, 12), distance * 0.66)
    const orbit = controls as unknown as OrbitLike | null
    if (orbit?.target) {
      orbit.target.set(0, height * 0.42, 0)
      orbit.update()
    }
    camera.updateProjectionMatrix()
    invalidate()
  }, [fitToken, projection, height, radius, camera, controls, invalidate])

  return null
}

/**
 * Треугольники считаем по геометрии, а не по gl.info.render: вьюпорт живёт в
 * режиме `demand` и в покое кадров не рисует — счётчик рендера остался бы нулём.
 */
function countScene(root: THREE.Object3D): { triangles: number; objects: number } {
  let triangles = 0
  let objects = 0

  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    objects += 1

    const geometry = mesh.geometry
    const vertices = geometry.index?.count ?? geometry.attributes.position?.count ?? 0
    const instanced = mesh as THREE.InstancedMesh
    triangles += (vertices / 3) * (instanced.isInstancedMesh ? instanced.count : 1)
  })

  return { triangles: Math.round(triangles), objects }
}

function SceneStats({ deps }: { deps: unknown }) {
  const setStats = useViewport((s) => s.setStats)
  const scene = useThree((s) => s.scene)
  const acc = useRef({ time: 0, frames: 0 })

  useEffect(() => {
    // Считаем в микрозадаче — к этому моменту дети уже смонтированы.
    const id = setTimeout(() => setStats(countScene(scene)), 0)
    return () => clearTimeout(id)
  }, [deps, scene, setStats])

  useFrame((_, delta) => {
    acc.current.time += delta
    acc.current.frames += 1
    if (acc.current.time < 0.5) return
    setStats({ fps: Math.round(acc.current.frames / acc.current.time) })
    acc.current = { time: 0, frames: 0 }
  })

  return null
}

/* ────────────────────────── башня ────────────────────────── */

function Tower() {
  const params = useViewport((s) => s.params)
  const selected = useViewport((s) => s.selected)
  const select = useViewport((s) => s.select)
  const mode = useViewport((s) => s.mode)
  const pal = usePalette()

  const skin = useMemo(() => buildSkin(params), [params])
  const skinEdges = useMemo(() => new THREE.EdgesGeometry(skin, 25), [skin])

  /** Горизонтальные контуры этажей — они и дают чертёжный характер. */
  const ringLines = useMemo(() => {
    const pos: number[] = []
    for (let f = 0; f <= params.floors; f++) {
      const ring = towerRing(params, f)
      for (let k = 0; k < params.sides; k++) {
        const a = ring[k]
        const b = ring[(k + 1) % params.sides]
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    return g
  }, [params])

  const slabMatrices = useMemo(
    () => buildSlabMatrices(params, SLAB_THICKNESS * MM),
    [params],
  )
  const ribMatrices = useMemo(() => buildRibMatrices(params), [params])

  const slabsRef = useRef<THREE.InstancedMesh>(null)
  const ribsRef = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const mesh = slabsRef.current
    if (!mesh) return
    slabMatrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [slabMatrices])

  useLayoutEffect(() => {
    const mesh = ribsRef.current
    if (!mesh) return
    ribMatrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [ribMatrices])

  useEffect(() => () => void skin.dispose(), [skin])
  useEffect(() => () => void skinEdges.dispose(), [skinEdges])
  useEffect(() => () => void ringLines.dispose(), [ringLines])

  const pick = (part: PartId) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    select(part)
  }

  const r = params.radius * MM
  const h = towerHeight(params)
  // В каркасном режиме рёбра дублировали бы сетку — гасим их.
  const showEdges = mode !== 'wire'

  return (
    <group>
      {/* ядро жёсткости */}
      <mesh position={[0, h / 2, 0]} onClick={pick('core')}>
        <cylinderGeometry args={[r * 0.34, r * 0.34, h, params.sides]} />
        <SurfaceMaterial tone="alt" active={selected === 'core'} />
      </mesh>

      {/* перекрытия */}
      <instancedMesh
        key={`slabs-${slabMatrices.length}-${params.sides}`}
        ref={slabsRef}
        args={[undefined, undefined, slabMatrices.length]}
        onClick={pick('slabs')}
      >
        <cylinderGeometry args={[r, r, 1, params.sides]} />
        <SurfaceMaterial tone="base" active={selected === 'slabs'} />
      </instancedMesh>

      {/* диагрид */}
      <instancedMesh
        key={`ribs-${ribMatrices.length}`}
        ref={ribsRef}
        args={[undefined, undefined, ribMatrices.length]}
        onClick={pick('diagrid')}
      >
        <boxGeometry args={[params.ribSize * MM, 1, params.ribSize * MM]} />
        <SurfaceMaterial tone="alt" active={selected === 'diagrid'} />
      </instancedMesh>

      {/* витраж */}
      <mesh geometry={skin} onClick={pick('glass')}>
        <SurfaceMaterial tone="glass" active={selected === 'glass'} />
      </mesh>

      {showEdges ? (
        <>
          <lineSegments geometry={skinEdges}>
            <lineBasicMaterial color={pal.edge} transparent opacity={0.5} />
          </lineSegments>
          <lineSegments geometry={ringLines}>
            <lineBasicMaterial color={pal.edge} transparent opacity={0.35} />
          </lineSegments>
        </>
      ) : null}
    </group>
  )
}

/* ────────────────────────── сцена ────────────────────────── */

export function Scene() {
  const params = useViewport((s) => s.params)
  const projection = useViewport((s) => s.projection)
  const grid = useViewport((s) => s.grid)
  const gizmo = useViewport((s) => s.gizmo)
  const loaded = useLoadedModel((s) => s.object)
  const pal = usePalette()
  const { size } = useThree()

  const height = towerHeight(params)
  const radius = params.radius * MM
  const orthoZoom = Math.max(2, size.height / Math.max(height * 1.6, 1))

  return (
    <>
      {projection === 'persp' ? (
        <PerspectiveCamera makeDefault fov={38} near={0.1} far={4000} />
      ) : (
        <OrthographicCamera makeDefault zoom={orthoZoom} near={-2000} far={4000} />
      )}
      <CameraRig height={loaded ? 60 : height} radius={loaded ? 30 : radius} />
      <SceneStats deps={loaded ?? params} />

      <ambientLight intensity={1.5} />
      <directionalLight position={[40, 80, 30]} intensity={2.2} />
      <directionalLight position={[-50, 30, -40]} intensity={0.7} />

      {grid ? (
        <Grid
          args={[10, 10]}
          cellSize={1}
          cellThickness={0.6}
          cellColor={pal.grid}
          sectionSize={10}
          sectionThickness={1}
          sectionColor={pal.gridSection}
          infiniteGrid
          fadeDistance={Math.max(height * 4, 260)}
          fadeStrength={1.2}
          followCamera={false}
        />
      ) : null}

      {loaded ? <primitive object={loaded} /> : <Tower />}

      <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI / 2 - 0.01} />

      {gizmo ? (
        <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
          <GizmoViewport
            axisColors={[pal.edge, pal.edge, pal.edge]}
            labelColor={pal.edge}
            hideNegativeAxes
          />
        </GizmoHelper>
      ) : null}
    </>
  )
}
