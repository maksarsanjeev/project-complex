import { GizmoHelper, GizmoViewport, Grid, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useLayout } from '../store/layout'
import { useViewport, type PartId } from '../store/viewport'
import {
  MM,
  SLAB_THICKNESS,
  buildRibMatrices,
  buildSkin,
  buildSlabMatrices,
  towerHeight,
  towerRing,
} from './geometry'
import { MM as SCENE_MM, useModel } from '../store/model'
import { useLoadedModel } from './loader'

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
      label: dark ? '#0a0a0a' : '#ffffff',
      grid: dark ? '#2e2e2e' : '#dedede',
      gridSection: dark ? '#4a4a4a' : '#b4b4b4',
    }),
    [dark],
  )
}

type Tone = 'base' | 'alt' | 'glass'

/**
 * Материал зависит от режима отображения — тот же набор, что в Rhino/SketchUp.
 *
 * Свойства перечисляем ПОЛНОСТЬЮ в каждом режиме и вешаем key: r3f применяет
 * только то, что указано в JSX, и не возвращает опущенное к значению по
 * умолчанию. Иначе depthWrite от x-ray и flatShading от clay протекали бы в
 * shaded и ломали картинку при переключении.
 */
function SurfaceMaterial({ tone, active }: { tone: Tone; active: boolean }) {
  const mode = useViewport((s) => s.mode)
  const pal = usePalette()
  const isGlass = tone === 'glass'

  if (mode === 'wire') {
    return <meshBasicMaterial key="wire" color={pal.edge} wireframe side={THREE.DoubleSide} />
  }

  if (mode === 'xray') {
    return (
      <meshStandardMaterial
        key="xray"
        color={active ? pal.edge : pal[tone]}
        transparent
        opacity={active ? 0.3 : 0.12}
        depthWrite={false}
        flatShading={false}
        roughness={1}
        metalness={0}
        side={THREE.DoubleSide}
      />
    )
  }

  if (mode === 'clay') {
    return (
      <meshStandardMaterial
        key="clay"
        color={active ? pal.alt : pal.clay}
        transparent={false}
        opacity={1}
        depthWrite
        flatShading
        roughness={1}
        metalness={0}
        side={THREE.DoubleSide}
      />
    )
  }

  return (
    <meshStandardMaterial
      key="shaded"
      color={active ? pal.alt : pal[tone]}
      transparent={isGlass}
      opacity={isGlass ? 0.42 : 1}
      depthWrite={!isGlass}
      flatShading={false}
      roughness={0.9}
      metalness={0}
      side={THREE.DoubleSide}
    />
  )
}

/* ────────────────────────── камера и статистика ────────────────────────── */

interface OrbitLike {
  target: THREE.Vector3
  update: () => void
}

/** Угол обзора перспективной камеры, °. */
const FOV = 38

/** Направление взгляда «три четверти сверху» — привычный для CAD ракурс. */
const VIEW_DIR = new THREE.Vector3(1, 0.62, 1).normalize()

function CameraRig({
  height,
  radius,
  center: given,
}: {
  height: number
  radius: number
  /** Центр геометрии. Не задан — считаем от начала координат, как у башни. */
  center?: THREE.Vector3
}) {
  const fitToken = useViewport((s) => s.fitToken)
  const projection = useViewport((s) => s.projection)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const invalidate = useThree((s) => s.invalidate)
  // Берём числа, а не объект size: его идентичность меняется при любой
  // переконфигурации канваса, и вид сбрасывался бы прямо посреди вращения.
  const width = useThree((s) => s.size.width)
  const height0 = useThree((s) => s.size.height)
  const size = useMemo(() => ({ width, height: height0 }), [width, height0])

  useEffect(() => {
    // Вписываем описанную сферу объекта, а не «примерно высоту»: иначе высокая
    // башня обрезается сверху и снизу, а низкий объект теряется вдали.
    const center = given ?? new THREE.Vector3(0, height / 2, 0)
    const sphere = Math.hypot(radius, height / 2) * 1.1
    const aspect = size.width / Math.max(size.height, 1)

    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera
      ortho.zoom = (Math.min(size.width, size.height) / (2 * sphere)) * 0.92
      ortho.position.copy(VIEW_DIR).multiplyScalar(sphere * 4).add(center)
    } else {
      const vFov = (FOV * Math.PI) / 180
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
      const distance = sphere / Math.sin(Math.min(vFov, hFov) / 2)
      camera.position.copy(VIEW_DIR).multiplyScalar(distance).add(center)
    }

    const orbit = controls as unknown as OrbitLike | null
    if (orbit?.target) {
      orbit.target.copy(center)
      orbit.update()
    }
    camera.updateProjectionMatrix()
    invalidate()
  }, [fitToken, projection, height, radius, given, size, camera, controls, invalidate])

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
    // Служебная геометрия (сетка, гизмо) — не часть модели, в счётчики не идёт.
    if (node.name.startsWith('helper:')) return
    // Скрытое из аутлайнера не показываем и в счётчиках — иначе цифры врут.
    if (!node.visible) return
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
  const hidden = useViewport((s) => s.hidden)
  const scene = useThree((s) => s.scene)
  const acc = useRef({ time: 0, frames: 0 })

  useEffect(() => {
    // Считаем в микрозадаче — к этому моменту дети уже смонтированы,
    // а флаги видимости из аутлайнера применены.
    const id = setTimeout(() => setStats(countScene(scene)), 0)
    return () => clearTimeout(id)
  }, [deps, hidden, scene, setStats])

  useFrame((_, delta) => {
    acc.current.time += delta
    acc.current.frames += 1
    if (acc.current.time < 0.5) return
    setStats({ fps: Math.round(acc.current.frames / acc.current.time) })
    acc.current = { time: 0, frames: 0 }
  })

  return null
}

/* ────────────────────────── модель из движка ────────────────────────── */

/**
 * Слой определяет вид поверхности. Стекло рисуется прозрачным — как и у
 * демо-башни, где слои тоже названы по материалу.
 */
function toneForLayer(layer: string): Tone {
  const name = layer.toLowerCase()
  if (name.includes('стекл') || name.includes('glass')) return 'glass'
  if (name.includes('метал') || name.includes('желез') || name.includes('steel')) return 'alt'
  return 'base'
}

/**
 * Настоящая модель из движка.
 *
 * Собирается обычными узлами сцены, а НЕ подставляется готовым объектом
 * three.js. Разница принципиальная: подставленный объект проходит мимо
 * материалов, обработчиков клика и флагов видимости — режимы отображения на
 * него не действуют, выделить нельзя, погасить из аутлайнера нельзя. Именно
 * так и оказалось при первой попытке.
 *
 * Поворот на −90° вокруг X: у SketchUp вверх смотрит Z, у three.js — Y.
 */
function RealModel() {
  const snapshot = useModel((s) => s.snapshot)
  const selected = useViewport((s) => s.selected)
  const select = useViewport((s) => s.select)
  const hidden = useViewport((s) => s.hidden)
  const locked = useViewport((s) => s.locked)

  // Геометрию пересобираем только при новом снимке: переключение режима
  // отображения или видимости не должно трогать буферы.
  const parts = useMemo(() => {
    if (!snapshot) return []
    return snapshot.parts.map((part) => {
      const geometry = new THREE.BufferGeometry()
      const positions = Float32Array.from(part.positions, (v) => v * SCENE_MM)
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      if (part.normals.length === part.positions.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3))
      } else {
        geometry.computeVertexNormals()
      }
      geometry.computeBoundingSphere()
      return { id: part.nodeId, layer: part.layer, geometry }
    })
  }, [snapshot])

  useEffect(() => () => parts.forEach((p) => p.geometry.dispose()), [parts])

  if (!snapshot) return null

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {parts.map((part) => (
        <mesh
          key={part.id}
          name={part.id}
          geometry={part.geometry}
          visible={!hidden[part.id]}
          onClick={(event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation()
            // Заблокированную часть не выделяем — так же, как у башни.
            if (locked[part.id]) return
            // Ctrl или Shift добавляют к выделению: привычно по всем редакторам.
            select(part.id, event.ctrlKey || event.metaKey || event.shiftKey)
          }}
        >
          <SurfaceMaterial tone={toneForLayer(part.layer)} active={selected.includes(part.id)} />
        </mesh>
      ))}
    </group>
  )
}

/* ────────────────────────── башня ────────────────────────── */

function Tower() {
  const params = useViewport((s) => s.params)
  const selected = useViewport((s) => s.selected)
  const select = useViewport((s) => s.select)
  const mode = useViewport((s) => s.mode)
  const hidden = useViewport((s) => s.hidden)
  const locked = useViewport((s) => s.locked)
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

  // Заблокированной части просто не даём обработчика — она перестаёт выделяться.
  const pick = (part: PartId) =>
    locked[part]
      ? undefined
      : (e: ThreeEvent<MouseEvent>) => {
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
      <mesh position={[0, h / 2, 0]} visible={!hidden.core} onClick={pick('core')}>
        <cylinderGeometry args={[r * 0.34, r * 0.34, h, params.sides]} />
        <SurfaceMaterial tone="alt" active={selected.includes('core')} />
      </mesh>

      {/* перекрытия */}
      <instancedMesh
        key={`slabs-${slabMatrices.length}-${params.sides}`}
        ref={slabsRef}
        args={[undefined, undefined, slabMatrices.length]}
        visible={!hidden.slabs}
        onClick={pick('slabs')}
      >
        <cylinderGeometry args={[r, r, 1, params.sides]} />
        <SurfaceMaterial tone="base" active={selected.includes('slabs')} />
      </instancedMesh>

      {/* диагрид */}
      <instancedMesh
        key={`ribs-${ribMatrices.length}`}
        ref={ribsRef}
        args={[undefined, undefined, ribMatrices.length]}
        visible={!hidden.diagrid}
        onClick={pick('diagrid')}
      >
        <boxGeometry args={[params.ribSize * MM, 1, params.ribSize * MM]} />
        <SurfaceMaterial tone="alt" active={selected.includes('diagrid')} />
      </instancedMesh>

      {/* витраж */}
      <mesh geometry={skin} visible={!hidden.glass} onClick={pick('glass')}>
        <SurfaceMaterial tone="glass" active={selected.includes('glass')} />
      </mesh>

      {/* Контуры принадлежат своим частям и гаснут вместе с ними. */}
      {showEdges ? (
        <>
          <lineSegments geometry={skinEdges} visible={!hidden.glass}>
            <lineBasicMaterial color={pal.edge} transparent opacity={0.5} />
          </lineSegments>
          <lineSegments geometry={ringLines} visible={!hidden.slabs}>
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
  const bounds = useLoadedModel((s) => s.bounds)
  const snapshot = useModel((s) => s.snapshot)
  const snapBounds = useModel((s) => s.bounds)
  const pal = usePalette()
  const invalidate = useThree((s) => s.invalidate)

  const height = towerHeight(params)
  const radius = params.radius * MM

  return (
    <>
      {/* Ракурс и зум задаёт CameraRig — здесь только тип камеры. */}
      {projection === 'persp' ? (
        <PerspectiveCamera makeDefault fov={FOV} near={0.1} far={8000} />
      ) : (
        <OrthographicCamera makeDefault near={-4000} far={8000} />
      )}
      {/*
        Габарит берём у самой модели, а не подставляем условные числа.
        Раньше для загруженной модели стояло 60 на 30 — это подходило
        перетащенному файлу, который вписывается в стандартный размер, но
        снимок из движка приходит в НАСТОЯЩИХ миллиметрах, и коробка 300 мм
        оказывалась точкой в кадре, рассчитанном на башню высотой 86 метров.
      */}
      <CameraRig
        height={loaded ? (bounds?.height ?? 60) : (snapBounds?.height ?? height)}
        radius={loaded ? (bounds?.radius ?? 30) : (snapBounds?.radius ?? radius)}
        center={
          loaded
            ? bounds?.center
            : snapBounds
              ? new THREE.Vector3(...snapBounds.center)
              : undefined
        }
      />
      <SceneStats deps={loaded ?? snapshot ?? params} />

      <ambientLight intensity={1.5} />
      <directionalLight position={[40, 80, 30]} intensity={2.2} />
      <directionalLight position={[-50, 30, -40]} intensity={0.7} />

      {grid ? (
        <Grid
          name="helper:grid"
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

      {/* Порядок важен: перетащенный файл перекрывает снимок, снимок — демо-башню. */}
      {loaded ? <primitive object={loaded} /> : snapshot ? <RealModel /> : <Tower />}

      {/*
        Вьюпорт рисует по требованию, поэтому каждое движение камеры обязано само
        просить кадр — без этого орбита крутится «вслепую»: камера уже повернулась,
        а на экране висит предыдущий кадр.
      */}
      {/* Углы не ограничиваем: модель нужно уметь посмотреть и снизу. */}
      <OrbitControls makeDefault enableDamping={false} onChange={() => invalidate()} />

      {gizmo ? (
        <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
          {/* Оси монохромные, поэтому подпись берём цветом фона — иначе чёрное по чёрному. */}
          <GizmoViewport
            axisColors={[pal.edge, pal.edge, pal.edge]}
            labelColor={pal.label}
            axisHeadScale={0.9}
            hideNegativeAxes
          />
        </GizmoHelper>
      ) : null}
    </>
  )
}
