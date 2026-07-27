import type { EngineId, ModelSnapshot, SceneNode } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { useSession } from './session'
import { useViewport } from './viewport'

/**
 * Настоящая модель из движка.
 *
 * До этого вьюпорт показывал демо-башню, которая генерировалась прямо в
 * браузере и была одинаковой в любой сессии. Теперь геометрия приходит из
 * SketchUp: и треугольники, и дерево слоёв — одним снимком.
 *
 * Снимок берётся ПО СОБЫТИЮ, а не по таймеру: после каждого ответа модели и
 * по кнопке. Опрашивать движок постоянно нельзя — сборка меша идёт на главном
 * потоке SketchUp, и на тяжёлой сцене это дёргало бы интерфейс самого SketchUp
 * каждые несколько секунд.
 *
 * Здесь хранится только СНИМОК, без объектов three.js. Сцену из него строит
 * вьюпорт обычными средствами r3f — иначе мимо модели проходят режимы
 * отображения, выделение и видимость, которые живут в компонентах сцены.
 */

/** Миллиметры снимка → единицы сцены. Демо-башня живёт в тех же единицах. */
export const MM = 0.001

/** Габарит для камеры — уже в единицах сцены и в её системе координат. */
export interface SnapshotBounds {
  height: number
  radius: number
  center: [number, number, number]
}

interface ModelState {
  /**
   * Снимки по движкам. Один проект бывает открыт сразу в SketchUp, Rhino и
   * Blender — в дереве они станут тремя ветками верхнего уровня.
   */
  snapshots: ModelSnapshot[]
  bounds: SnapshotBounds | null
  loading: boolean
  error: string | null
  /** Забрать модель из движка. Тихо ничего не делает, если движок не запущен. */
  pull: (engine?: EngineId) => Promise<void>
  /** Показать готовые снимки — ими пользуется переключение сессий. */
  adopt: (snapshots: ModelSnapshot[]) => void
  clear: () => void
}

export const useModel = create<ModelState>()((set) => ({
  snapshots: [],
  bounds: null,
  loading: false,
  error: null,

  async pull(engine = 'sketchup') {
    set({ loading: true, error: null })
    try {
      // Снимок принадлежит сессии, в которой работали, — сервер его туда и
      // положит, чтобы при возврате к проекту модель была на месте.
      const sessionId = useSession.getState().activeId ?? undefined
      const fresh = await transport.pullModel({ engine, sessionId })

      // Пока снимок ехал, человек мог создать новый проект. Снимок принадлежит
      // ТОЙ сессии, из которой его просили, и в новую попасть не должен —
      // иначе в пустом проекте висит модель предыдущего. Снимок Rhino едет
      // мегабайтами и секундами, так что окно для этой гонки широкое.
      if (useSession.getState().activeId !== sessionId) {
        set({ loading: false })
        return
      }
      // Движок не запущен — это не ошибка, а обычное состояние: просто у этой
      // ветки дерева нечего показать, остальные остаются на месте.
      set((state) => {
        const rest = state.snapshots.filter((x) => x.engine !== engine)
        const snapshots = fresh ? [...rest, fresh] : rest
        return { snapshots, bounds: measure(snapshots), loading: false }
      })

      // Выделение, сделанное руками в самом приложении, подхватываем в
      // интерфейс. Иначе человек выделяет в SketchUp, спрашивает «что я
      // выделил» — и получает ответ про другое выделение.
      if (fresh?.selection?.length) {
        const known = new Set(fresh.nodes.map((n) => n.id))
        const ids = fresh.selection.filter((id) => known.has(id))
        if (ids.length) useViewport.getState().selectMany(ids)
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'не удалось забрать модель',
      })
    }
  },

  adopt(snapshots) {
    // Выделение принадлежит модели: при смене проекта оно теряет смысл.
    useViewport.getState().select(null)
    set({ snapshots, bounds: measure(snapshots), error: null })
  },

  clear() {
    useViewport.getState().select(null)
    set({ snapshots: [], bounds: null, error: null })
  },
}))

/**
 * Габаритная коробка снимка, пересчитанная в систему координат сцены.
 *
 * У SketchUp вверх смотрит Z, у three.js — Y, поэтому сцена поворачивается на
 * −90° вокруг X. Тот же поворот применяем и к габариту: иначе камера считала бы
 * высотой глубину модели и наводилась мимо.
 */
function measure(snapshots: ModelSnapshot[]): SnapshotBounds | null {
  if (!snapshots.length) return null

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  // Габарит по ВСЕМ движкам сразу: камера должна вписать проект целиком, а не
  // одну его часть.
  for (const part of snapshots.flatMap((x) => x.parts)) {
    const p = part.positions
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] as number
      const y = p[i + 1] as number
      const z = p[i + 2] as number
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  }

  if (!Number.isFinite(minX)) return { height: 1, radius: 1, center: [0, 0, 0] }

  const sx = (maxX - minX) * MM
  const sy = (maxY - minY) * MM
  const sz = (maxZ - minZ) * MM
  const cx = ((minX + maxX) / 2) * MM
  const cy = ((minY + maxY) / 2) * MM
  const cz = ((minZ + maxZ) / 2) * MM

  return {
    // Вверх в сцене — это Z модели.
    height: Math.max(sz, 0.001),
    radius: Math.max(Math.hypot(sx, sy) / 2, 0.001),
    // Поворот на −90° вокруг X: (x, y, z) → (x, z, −y).
    center: [cx, cz, -cy],
  }
}

/**
 * Названия движков для корневых веток дерева. Берём те же слова, что в панели
 * движков, — человек не должен гадать, «Rhino» и «Rhinoceros» это одно и то же.
 */
export const ENGINE_LABEL: Record<EngineId, string> = {
  sketchup: 'SketchUp',
  rhino: 'Rhinoceros',
  blender: 'Blender',
}

/** Все узлы всех движков плюс корни-движки над ними. */
export function mergedNodes(snapshots: ModelSnapshot[]): SceneNode[] {
  return snapshots.flatMap((snapshot) => {
    const rootId = `engine:${snapshot.engine}`
    const root: SceneNode = {
      id: rootId,
      name: ENGINE_LABEL[snapshot.engine],
      kind: 'engine',
      parentId: null,
      visible: true,
      locked: false,
      engine: snapshot.engine,
      triangles: snapshot.triangles,
    }
    // Узлы верхнего уровня движка подвешиваем под его корень.
    const nodes = snapshot.nodes.map((n) => (n.parentId ? n : { ...n, parentId: rootId }))
    return [root, ...nodes]
  })
}
